import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { Brain } from "./agent.ts";
import { CLAUDE_MODELS, claudeStreamFactory, listClaudeModels, type Effort } from "./providers/anthropic.ts";
import { openAICompatibleStreamFactory } from "./providers/openai.ts";
import { DEFAULT_VOICE, VOICE_ALLOWLIST, voiceEngineReady, type VoiceId } from "./voice.ts";

export const PROVIDER_IDS = ["claude", "ollama", "lmstudio", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Selection {
  provider: ProviderId;
  model: string;
}

/** The settings.json shape: model selection plus voice, all dashboard-settable. */
export interface SavedSettings extends Selection {
  voice?: string;
  voiceEnabled?: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  ready: boolean;
  /** One line for the picker: what's wrong, or where it's running. */
  detail: string;
  models: string[];
  /** Where the API key came from, for providers that use one. */
  keySource?: "env" | "saved";
}

interface ProviderDef {
  id: ProviderId;
  label: string;
  baseURL?: string;
  apiKey?: string;
  /** Where the API key came from, for providers that use one. */
  keySource?: "env" | "saved";
  /** Needs no probing to know it's unusable (e.g. no API key). */
  missing?: string;
}

const PROBE_TIMEOUT_MS = 1500;
const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|rerank/i;

/** Tolerates what people paste: spaces, quotes, a "Bearer " prefix. */
function cleanKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const t = key.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  return t.length >= 8 ? t : null;
}

/** Accepts "http://host:11434" or ".../v1". */
function v1(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return /\/v\d+(beta)?(\/openai)?$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function hostLabel(baseURL: string): string {
  const host = new URL(baseURL).hostname;
  if (host.includes("openrouter")) return "OpenRouter";
  if (host === "api.openai.com") return "OpenAI";
  if (host.includes("groq")) return "Groq";
  if (host.includes("googleapis")) return "Gemini";
  if (host.includes("mistral")) return "Mistral";
  if (host.includes("deepseek")) return "DeepSeek";
  if (host.includes("x.ai")) return "xAI";
  if (host === "localhost" || host === "127.0.0.1") return "Local server";
  return host;
}

/**
 * Knows which AI back ends are available, which one is in use, and builds the matching
 * Brain for the agent. Claude uses the Anthropic API; everything else goes through the
 * OpenAI-compatible chat API that local runtimes and most other providers speak.
 */
export class ModelRouter {
  private defs!: Map<ProviderId, ProviderDef>;
  private claude!: Anthropic | null;
  private claudeModels: string[] | null = null;
  private keysFile: string;
  private savedKeys: Record<string, string> = {};
  selection: Selection = { provider: "claude", model: "claude-opus-5" };
  /** Neural voice for spoken replies, and whether the overlay speaks them. */
  voice: VoiceId = DEFAULT_VOICE;
  voiceEnabled = false;

  constructor(
    private env: NodeJS.ProcessEnv,
    private settingsFile: string,
    private effort: Effort,
  ) {
    this.keysFile = path.join(path.dirname(settingsFile), "keys.json");
    this.loadKeys();
    this.reload();
  }

  /** (Re)build provider defs from env plus keys saved through the dashboard. Saved keys win. */
  private reload(): void {
    const env = this.env;
    const claudeKey = this.savedKeys.claude || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
    this.claude = claudeKey ? new Anthropic(this.savedKeys.claude ? { apiKey: this.savedKeys.claude } : undefined) : null;
    const openaiBase = env.OPENAI_BASE_URL
      ? v1(env.OPENAI_BASE_URL)
      : this.savedKeys.openai || env.OPENAI_API_KEY
        ? "https://api.openai.com/v1"
        : undefined;
    const defs: ProviderDef[] = [
      {
        id: "claude",
        label: "Claude",
        keySource: this.savedKeys.claude ? "saved" : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "env" : undefined,
        missing: claudeKey ? undefined : "No API key yet",
      },
      { id: "ollama", label: "Ollama", baseURL: v1(env.OLLAMA_URL ?? "http://127.0.0.1:11434") },
      { id: "lmstudio", label: "LM Studio", baseURL: v1(env.LMSTUDIO_URL ?? "http://127.0.0.1:1234") },
      {
        id: "openai",
        label: openaiBase ? hostLabel(openaiBase) : "OpenAI-compatible",
        baseURL: openaiBase,
        apiKey: this.savedKeys.openai || env.OPENAI_API_KEY,
        keySource: this.savedKeys.openai ? "saved" : env.OPENAI_API_KEY ? "env" : undefined,
        missing: openaiBase ? undefined : "No server configured",
      },
    ];
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }

  /** Saved choice, else SCRUFF_PROVIDER/SCRUFF_MODEL, else the first back end that works. */
  async init(env: NodeJS.ProcessEnv): Promise<void> {
    const saved = this.loadSaved();
    if (saved) {
      this.selection = saved.selection;
      this.voice = saved.voice;
      this.voiceEnabled = saved.voiceEnabled;
      return;
    }
    const provider = env.SCRUFF_PROVIDER as ProviderId | undefined;
    if (provider && PROVIDER_IDS.includes(provider)) {
      const model = env.SCRUFF_MODEL ?? (provider === "claude" ? "claude-opus-5" : (await this.models(provider))[0] ?? "");
      this.selection = { provider, model };
      return;
    }
    if (this.claude) {
      this.selection = { provider: "claude", model: env.SCRUFF_MODEL ?? "claude-opus-5" };
      return;
    }
    for (const id of ["ollama", "lmstudio", "openai"] as const) {
      const models = await this.models(id).catch(() => []);
      if (models.length) {
        this.selection = { provider: id, model: env.SCRUFF_MODEL && id === "openai" ? env.SCRUFF_MODEL : models[0] };
        return;
      }
    }
  }

  brain(): Brain {
    const { provider, model } = this.selection;
    if (provider === "claude") {
      return { model, createStream: claudeStreamFactory(this.claude ?? new Anthropic(), this.effort) };
    }
    const def = this.defs.get(provider)!;
    if (!def.baseURL) throw new Error(def.missing);
    return { model, createStream: openAICompatibleStreamFactory({ label: def.label, baseURL: def.baseURL, apiKey: def.apiKey }) };
  }

  select(selection: Selection): Brain {
    if (!PROVIDER_IDS.includes(selection.provider)) throw new Error(`Unknown provider ${selection.provider}.`);
    if (!selection.model.trim()) throw new Error("Pick a model.");
    this.selection = { provider: selection.provider, model: selection.model.trim() };
    this.save();
    return this.brain();
  }

  describe() {
    const def = this.defs.get(this.selection.provider)!;
    return {
      ...this.selection,
      providerLabel: def.id === "claude" ? "Claude" : def.label,
      ready: !def.missing,
      problem: def.missing,
      voice: this.voice,
      voiceEnabled: this.voiceEnabled,
      voiceReady: voiceEngineReady(),
    };
  }

  /** Sets the spoken-reply voice and whether the overlay speaks replies. */
  setVoice(voice: string, enabled: boolean): void {
    if (!VOICE_ALLOWLIST.includes(voice as VoiceId)) throw new Error(`Unknown voice ${voice}.`);
    this.voice = voice as VoiceId;
    this.voiceEnabled = enabled;
    this.save();
  }

  async status(): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.defs.values()].map(async (def): Promise<ProviderStatus> => {
        const base = { id: def.id, label: def.label, keySource: def.keySource };
        if (def.missing) {
          return { ...base, ready: false, detail: def.missing, models: def.id === "claude" ? CLAUDE_MODELS : [] };
        }
        try {
          const models = await this.models(def.id);
          const where = def.baseURL ? new URL(def.baseURL).host : "api.anthropic.com";
          if (!models.length && (def.id === "ollama" || def.id === "lmstudio")) {
            return { ...base, ready: false, detail: `Running at ${where}, but no models are installed`, models };
          }
          return { ...base, ready: true, detail: where, models };
        } catch {
          const detail =
            def.id === "ollama"
              ? "Not running. Install it from ollama.com, then `ollama pull qwen3:8b`"
              : def.id === "lmstudio"
                ? "Not running. Start LM Studio's local server (Developer tab)"
                : `Can't reach ${def.baseURL}`;
          return { ...base, ready: false, detail, models: def.id === "claude" ? CLAUDE_MODELS : [] };
        }
      }),
    );
  }

  private async models(id: ProviderId): Promise<string[]> {
    if (id === "claude") {
      if (!this.claude) return CLAUDE_MODELS;
      this.claudeModels ??= await listClaudeModels(this.claude).catch(() => CLAUDE_MODELS);
      return this.claudeModels;
    }
    const def = this.defs.get(id)!;
    if (!def.baseURL) return [];
    const client = new OpenAI({ baseURL: def.baseURL, apiKey: def.apiKey || "not-needed", timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
    const ids: string[] = [];
    for await (const m of client.models.list()) {
      if (!NOT_CHAT.test(m.id)) ids.push(m.id);
      if (ids.length >= 300) break;
    }
    return ids.sort((a, b) => a.localeCompare(b));
  }

  private loadKeys(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.keysFile, "utf8")) as Record<string, unknown>;
      for (const id of ["claude", "openai"]) {
        const k = cleanKey(raw[id]);
        if (k) this.savedKeys[id] = k;
      }
    } catch {
      this.savedKeys = {};
    }
  }

  private persistKeys(): void {
    try {
      fs.mkdirSync(path.dirname(this.keysFile), { recursive: true });
      const ids = Object.keys(this.savedKeys);
      if (!ids.length) {
        fs.rmSync(this.keysFile, { force: true });
        return;
      }
      fs.writeFileSync(this.keysFile, JSON.stringify(this.savedKeys, null, 2), { mode: 0o600 });
    } catch {
      // not fatal: the key just won't survive a restart
    }
  }

  /**
   * Save an API key from the dashboard's connect flow (null forgets it). The key is
   * validated live before it's stored, and it takes precedence over .env afterwards.
   */
  async setProviderKey(id: string, key: string | null): Promise<void> {
    if (id !== "claude" && id !== "openai") throw new Error(`${id} doesn't use an API key.`);
    const clean = cleanKey(key);
    if (key && !clean) throw new Error("That doesn't look like an API key. Copy it from the provider's dashboard.");
    if (clean) {
      await this.validateKey(id as "claude" | "openai", clean);
      this.savedKeys[id] = clean;
    } else {
      delete this.savedKeys[id];
    }
    this.persistKeys();
    this.claudeModels = null;
    this.reload();
  }

  /** Throws with a human-readable reason when the provider rejects the key. */
  private async validateKey(id: "claude" | "openai", key: string): Promise<void> {
    try {
      if (id === "claude") {
        await listClaudeModels(new Anthropic({ apiKey: key, timeout: 10000, maxRetries: 0 }));
      } else {
        const baseURL = this.env.OPENAI_BASE_URL ? v1(this.env.OPENAI_BASE_URL) : "https://api.openai.com/v1";
        const client = new OpenAI({ baseURL, apiKey: key, timeout: 10000, maxRetries: 0 });
        await client.models.list();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|unauthorized|invalid|incorrect|authentication/i.test(msg)) {
        throw new Error("That key was rejected. Double-check you copied the whole thing.");
      }
      throw new Error(`Couldn't reach the provider to check the key: ${msg}`);
    }
  }

  private loadSaved(): { selection: Selection; voice: VoiceId; voiceEnabled: boolean } | null {
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, "utf8")) as SavedSettings;
      if (!(PROVIDER_IDS.includes(saved.provider) && typeof saved.model === "string" && saved.model)) return null;
      const voice = VOICE_ALLOWLIST.includes(saved.voice as VoiceId) ? (saved.voice as VoiceId) : DEFAULT_VOICE;
      return {
        selection: { provider: saved.provider, model: saved.model },
        voice,
        voiceEnabled: saved.voiceEnabled === true,
      };
    } catch {
      // nothing saved yet
    }
    return null;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      const settings: SavedSettings = { ...this.selection, voice: this.voice, voiceEnabled: this.voiceEnabled };
      fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2));
    } catch {
      // not fatal: the choice just won't survive a restart
    }
  }
}

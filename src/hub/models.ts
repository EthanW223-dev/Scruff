import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { Brain } from "./agent.ts";
import { CLAUDE_MODELS, claudeStreamFactory, listClaudeModels, type Effort } from "./providers/anthropic.ts";
import { openAICompatibleStreamFactory, OPENROUTER_APP_HEADERS } from "./providers/openai.ts";
import { BEST_VOICE, defaultVoiceFor, isVoiceFor, selectedEngineReady, TTS_ENGINES, voiceEnginesReady, type TtsEngine } from "./voice.ts";

export const PROVIDER_IDS = [
  "claude",
  "openai",
  "openrouter",
  "groq",
  "deepseek",
  "mistral",
  "gemini",
  "xai",
  "ollama",
  "lmstudio",
  "custom",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Every cloud brain Telos can talk to, each through the OpenAI-compatible chat
 * API. `custom` is the escape hatch: any OpenAI-compatible server (vLLM,
 * llama.cpp server, a proxy) via a user-supplied URL.
 */
interface CompatProvider {
  id: ProviderId;
  label: string;
  baseURL: string;
  /** Env vars holding the API key, in priority order. */
  envKeys: string[];
  keyUrl: string;
  keyKind: string;
}

const COMPAT_PROVIDERS: CompatProvider[] = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", envKeys: ["OPENAI_API_KEY"], keyUrl: "https://platform.openai.com/api-keys", keyKind: "OpenAI" },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", envKeys: ["OPENROUTER_API_KEY"], keyUrl: "https://openrouter.ai/keys", keyKind: "OpenRouter" },
  { id: "groq", label: "Groq", baseURL: "https://api.groq.com/openai/v1", envKeys: ["GROQ_API_KEY"], keyUrl: "https://console.groq.com/keys", keyKind: "Groq" },
  { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", envKeys: ["DEEPSEEK_API_KEY"], keyUrl: "https://platform.deepseek.com/api_keys", keyKind: "DeepSeek" },
  { id: "mistral", label: "Mistral", baseURL: "https://api.mistral.ai/v1", envKeys: ["MISTRAL_API_KEY"], keyUrl: "https://console.mistral.ai/api-keys", keyKind: "Mistral" },
  { id: "gemini", label: "Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], keyUrl: "https://aistudio.google.com/apikey", keyKind: "Google AI Studio" },
  { id: "xai", label: "xAI", baseURL: "https://api.x.ai/v1", envKeys: ["XAI_API_KEY"], keyUrl: "https://console.x.ai", keyKind: "xAI" },
];

/** Provider ids that take an API key through the dashboard's connect flow. */
const KEYED_IDS = ["claude", ...COMPAT_PROVIDERS.map((p) => p.id), "custom"] as const;

export interface Selection {
  provider: ProviderId;
  model: string;
}

/** The settings.json shape: model selection plus voice, all dashboard-settable. */
export interface SavedSettings extends Selection {
  voice?: string;
  voiceEnabled?: boolean;
  voiceEngine?: TtsEngine;
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
  /** Where to get an API key; sent so the dashboard doesn't hardcode providers. */
  keyUrl?: string;
  keyKind?: string;
  /** The server's base URL (for the custom provider, to prefill its URL field). */
  baseURL?: string;
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
  keyUrl?: string;
  keyKind?: string;
}

const PROBE_TIMEOUT_MS = 1500;
const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|rerank/i;

/** Tolerates what people paste: spaces, quotes, a "Bearer " prefix. */
function cleanKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const t = key.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  return t.length >= 8 ? t : null;
}

/** Tolerates what people paste for a custom server URL; normalizes to a /v1 base. */
function cleanBaseURL(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const t = url.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return v1(t);
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
 * OpenRouter serves GET /models without checking the key at all, so a models-list
 * "check" would accept any garbage string and save it as "Connected". /auth/key
 * actually verifies the key: 200 means it's good, 401/403 means it was rejected.
 * `fetchFn` is injectable so tests don't need the network.
 */
export async function checkOpenRouterKey(key: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_APP_HEADERS },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("That key was rejected. Double-check you copied the whole thing.");
  }
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}; try again in a bit.`);
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
  /** Custom OpenAI-compatible server URL saved through the dashboard. */
  private savedCustomURL?: string;
  selection: Selection = { provider: "claude", model: "claude-opus-5" };
  /** Neural voice for spoken replies, and whether the overlay speaks them. Out of
      the box this is the best-ranked voice (Heart on Kokoro). */
  voice: string = BEST_VOICE.id;
  voiceEngine: TtsEngine = BEST_VOICE.engine;
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
    const keyOf = (id: string, envKeys: string[]): { apiKey?: string; keySource?: "env" | "saved" } => {
      if (this.savedKeys[id]) return { apiKey: this.savedKeys[id], keySource: "saved" };
      for (const name of envKeys) {
        const v = cleanKey(env[name]);
        if (v) return { apiKey: v, keySource: "env" };
      }
      return {};
    };
    const defs: ProviderDef[] = [
      {
        id: "claude",
        label: "Claude",
        keySource: this.savedKeys.claude ? "saved" : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "env" : undefined,
        missing: claudeKey ? undefined : "No API key yet",
        keyUrl: "https://console.anthropic.com/settings/keys",
        keyKind: "Anthropic",
      },
    ];
    for (const cp of COMPAT_PROVIDERS) {
      const { apiKey, keySource } = keyOf(cp.id, cp.envKeys);
      defs.push({
        id: cp.id,
        label: cp.label,
        baseURL: cp.baseURL,
        apiKey,
        keySource,
        keyUrl: cp.keyUrl,
        keyKind: cp.keyKind,
        missing: apiKey ? undefined : "No API key yet",
      });
    }
    defs.push(
      { id: "ollama", label: "Ollama", baseURL: v1(env.OLLAMA_URL ?? "http://127.0.0.1:11434") },
      { id: "lmstudio", label: "LM Studio", baseURL: v1(env.LMSTUDIO_URL ?? "http://127.0.0.1:1234") },
    );
    // Custom server: the old OPENAI_BASE_URL behavior lives on here, so existing
    // setups keep working; the dashboard can also set the URL directly.
    {
      const url = this.savedCustomURL ?? (env.OPENAI_BASE_URL ? v1(env.OPENAI_BASE_URL) : undefined);
      const { apiKey, keySource } = keyOf("custom", url && !this.savedKeys.custom ? ["OPENAI_API_KEY"] : []);
      defs.push({
        id: "custom",
        label: url ? hostLabel(url) : "Custom server",
        baseURL: url,
        apiKey,
        keySource,
        missing: url ? undefined : "No server URL set",
      });
    }
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }

  /** Saved choice, else SCRUFF_PROVIDER/SCRUFF_MODEL, else the first back end that works. */
  async init(env: NodeJS.ProcessEnv): Promise<void> {
    const saved = this.loadSaved();
    if (saved) {
      this.selection = saved.selection;
      this.voice = saved.voice;
      this.voiceEngine = saved.voiceEngine;
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
    // No saved choice and no explicit env: prefer a local runtime, then any cloud
    // provider that actually has a key, then the custom server.
    const autoOrder: ProviderId[] = [
      "ollama",
      "lmstudio",
      ...(COMPAT_PROVIDERS.map((p) => p.id).filter((id) => !this.defs.get(id)?.missing) as ProviderId[]),
      "custom",
    ];
    for (const id of autoOrder) {
      if (this.defs.get(id)?.missing) continue;
      const models = await this.models(id).catch(() => []);
      if (models.length) {
        this.selection = { provider: id, model: env.SCRUFF_MODEL || models[0] };
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
      voiceEngine: this.voiceEngine,
      voiceEnabled: this.voiceEnabled,
      voiceReady: selectedEngineReady(this.voiceEngine),
      voiceEngines: voiceEnginesReady(),
    };
  }

  /** Sets the spoken-reply engine + voice and whether the overlay speaks replies. */
  setVoice(voice: string, enabled: boolean, engine?: TtsEngine): void {
    const eng: TtsEngine = engine && TTS_ENGINES.includes(engine) ? engine : this.voiceEngine;
    if (!isVoiceFor(eng, voice)) throw new Error(`Unknown voice ${voice} for ${eng}.`);
    this.voiceEngine = eng;
    this.voice = voice;
    this.voiceEnabled = enabled;
    this.save();
  }

  async status(): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.defs.values()].map(async (def): Promise<ProviderStatus> => {
        const base = { id: def.id, label: def.label, keySource: def.keySource, keyUrl: def.keyUrl, keyKind: def.keyKind, baseURL: def.baseURL };
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
      for (const id of KEYED_IDS) {
        const k = cleanKey(raw[id]);
        if (k) this.savedKeys[id] = k;
      }
      const url = typeof raw._customBaseURL === "string" ? raw._customBaseURL.trim() : "";
      if (url) this.savedCustomURL = url;
    } catch {
      this.savedKeys = {};
    }
  }

  private persistKeys(): void {
    try {
      fs.mkdirSync(path.dirname(this.keysFile), { recursive: true });
      const data: Record<string, string> = { ...this.savedKeys };
      if (this.savedCustomURL) data._customBaseURL = this.savedCustomURL;
      if (!Object.keys(data).length) {
        fs.rmSync(this.keysFile, { force: true });
        return;
      }
      fs.writeFileSync(this.keysFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
      // not fatal: the key just won't survive a restart
    }
  }

  /**
   * Save an API key from the dashboard's connect flow (null forgets it). The key is
   * validated live before it's stored, and it takes precedence over .env afterwards.
   */
  async setProviderKey(id: string, key: string | null, baseURL?: string): Promise<void> {
    if (!(KEYED_IDS as readonly string[]).includes(id)) throw new Error(`${id} doesn't use an API key.`);
    let url: string | undefined;
    if (id === "custom" && baseURL !== undefined) {
      const t = baseURL.trim();
      if (t) {
        const cleaned = cleanBaseURL(t);
        if (!cleaned) throw new Error("That doesn't look like a server URL — it should start with http:// or https://");
        url = cleaned;
      }
      // An empty URL clears the saved one.
    }
    const clean = cleanKey(key);
    if (key && !clean) throw new Error("That doesn't look like an API key. Copy it from the provider's dashboard.");
    if (clean) {
      await this.validateKey(id, clean, url);
      this.savedKeys[id] = clean;
    } else {
      delete this.savedKeys[id];
    }
    if (id === "custom" && baseURL !== undefined) this.savedCustomURL = url;
    this.persistKeys();
    this.claudeModels = null;
    this.reload();
  }

  /** Throws with a human-readable reason when the provider rejects the key. */
  private async validateKey(id: string, key: string, customURL?: string): Promise<void> {
    try {
      if (id === "claude") {
        await listClaudeModels(new Anthropic({ apiKey: key, timeout: 10000, maxRetries: 0 }));
      } else if (id === "openrouter") {
        await checkOpenRouterKey(key);
      } else {
        const baseURL =
          id === "custom"
            ? (customURL ?? this.savedCustomURL ?? (this.env.OPENAI_BASE_URL ? v1(this.env.OPENAI_BASE_URL) : undefined))
            : COMPAT_PROVIDERS.find((p) => p.id === id)?.baseURL;
        if (!baseURL) throw new Error("Set the server URL first.");
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

  private loadSaved(): { selection: Selection; voice: string; voiceEngine: TtsEngine; voiceEnabled: boolean } | null {
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, "utf8")) as SavedSettings;
      if (!(PROVIDER_IDS.includes(saved.provider) && typeof saved.model === "string" && saved.model)) return null;
      const engine: TtsEngine = TTS_ENGINES.includes(saved.voiceEngine as TtsEngine) ? (saved.voiceEngine as TtsEngine) : BEST_VOICE.engine;
      // A voice saved under an older list falls back to that engine's default.
      const voice = isVoiceFor(engine, saved.voice ?? "") ? (saved.voice as string) : defaultVoiceFor(engine);
      return {
        selection: { provider: saved.provider, model: saved.model },
        voice,
        voiceEngine: engine,
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
      const settings: SavedSettings = { ...this.selection, voice: this.voice, voiceEnabled: this.voiceEnabled, voiceEngine: this.voiceEngine };
      fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2));
    } catch {
      // not fatal: the choice just won't survive a restart
    }
  }
}

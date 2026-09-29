import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { Brain } from "./agent.ts";
import { CLAUDE_MODELS, claudeStreamFactory, listClaudeModels, type Effort } from "./providers/anthropic.ts";
import { openAICompatibleStreamFactory } from "./providers/openai.ts";

export const PROVIDER_IDS = ["claude", "ollama", "lmstudio", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Selection {
  provider: ProviderId;
  model: string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  ready: boolean;
  /** One line for the picker: what's wrong, or where it's running. */
  detail: string;
  models: string[];
}

interface ProviderDef {
  id: ProviderId;
  label: string;
  baseURL?: string;
  apiKey?: string;
  /** Needs no probing to know it's unusable (e.g. no API key). */
  missing?: string;
}

const PROBE_TIMEOUT_MS = 1500;
const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|rerank/i;

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
  private defs: Map<ProviderId, ProviderDef>;
  private claude: Anthropic | null;
  private claudeModels: string[] | null = null;
  selection: Selection = { provider: "claude", model: "claude-opus-5" };

  constructor(
    env: NodeJS.ProcessEnv,
    private settingsFile: string,
    private effort: Effort,
  ) {
    const claudeKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    this.claude = claudeKey ? new Anthropic() : null;
    const openaiBase = env.OPENAI_BASE_URL ? v1(env.OPENAI_BASE_URL) : env.OPENAI_API_KEY ? "https://api.openai.com/v1" : undefined;
    const defs: ProviderDef[] = [
      {
        id: "claude",
        label: "Claude (API key)",
        missing: claudeKey ? undefined : "Add ANTHROPIC_API_KEY to .env",
      },
      { id: "ollama", label: "Ollama", baseURL: v1(env.OLLAMA_URL ?? "http://127.0.0.1:11434") },
      { id: "lmstudio", label: "LM Studio", baseURL: v1(env.LMSTUDIO_URL ?? "http://127.0.0.1:1234") },
      {
        id: "openai",
        label: openaiBase ? hostLabel(openaiBase) : "OpenAI-compatible",
        baseURL: openaiBase,
        apiKey: env.OPENAI_API_KEY,
        missing: openaiBase ? undefined : "Set OPENAI_BASE_URL (and OPENAI_API_KEY) in .env",
      },
    ];
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }

  /** Saved choice, else SCRUFF_PROVIDER/SCRUFF_MODEL, else the first back end that works. */
  async init(env: NodeJS.ProcessEnv): Promise<void> {
    const saved = this.load();
    if (saved) {
      this.selection = saved;
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
    };
  }

  async status(): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.defs.values()].map(async (def): Promise<ProviderStatus> => {
        const base = { id: def.id, label: def.label };
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

  private load(): Selection | null {
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
      if (PROVIDER_IDS.includes(saved.provider) && typeof saved.model === "string" && saved.model) return saved;
    } catch {
      // nothing saved yet
    }
    return null;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.selection, null, 2));
    } catch {
      // not fatal: the choice just won't survive a restart
    }
  }
}

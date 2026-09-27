import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

/**
 * Client for Jev, TypeSafe's System One model (https://docs.typesafe.ai). Jev doesn't chat or
 * write text: it takes a `state` and typed questions (pick one option, score on levels, yes/no)
 * and answers all of them in one fast call, each with calibrated probabilities. Scruff uses it
 * to understand quick commands without waiting on a chat model.
 */

type Instructions = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: "noul"; instructions: Instructions; criteria?: { true?: Instructions; false?: Instructions } }
  | { type: "choice"; instructions: Instructions; criteria: Record<string, Instructions | null> }
  | { type: "score"; instructions: Instructions; criteria: Instructions[] };

export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

/** What the fast path needs; tests pass a stand-in. */
export interface Jev {
  readonly model: string;
  ask(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResult>;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const JEV_DEFAULT_URL = "https://api.typesafe.ai";
/** Choice questions take at most this many options. */
export const JEV_MAX_OPTIONS = 255;
const TIMEOUT_MS = 6000;
const RETRIES = 2;

export class JevClient implements Jev {
  readonly model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(
    private apiKey: string,
    opts: { baseUrl?: string; model?: string; timeoutMs?: number } = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? JEV_DEFAULT_URL).replace(/\/+$/, "");
    this.model = opts.model ?? "jev-latest";
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  async ask(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResult> {
    const body = JSON.stringify({ state, model: this.model, questions });
    return (await this.request("POST", "/v1/systemone", body, signal)) as JevResult;
  }

  /** Cheap way to check a key: 401 means it's wrong. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = (await this.request("GET", "/v1/models", undefined, signal)) as { models?: { name: string }[] };
    return (res.models ?? []).map((m) => m.name);
  }

  private async request(method: string, route: string, body: string | undefined, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      let res: Response;
      try {
        res = await fetch(this.baseUrl + route, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new JevError(timeout.aborted ? "Jev didn't answer in time." : `Couldn't reach Jev: ${(err as Error).message}`);
      }
      // Rate limited or overloaded: back off briefly, honoring retry-after, then give up so the
      // chat model can take the message instead.
      if ((res.status === 429 || res.status === 529) && attempt < RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Math.min(2000, Number.isFinite(after) && after > 0 ? after * 1000 : 250 * 2 ** attempt), signal);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const reason =
          res.status === 401
            ? "Jev rejected the API key."
            : res.status === 429
              ? "Jev is rate limiting requests."
              : `Jev returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
        throw new JevError(reason, res.status);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new JevError("Jev sent back something that isn't JSON.");
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Where the key comes from: TYPESAFE_API_KEY in .env, or one pasted into the AI menu (kept in
 * .scruff/typesafe.json, never sent back to the dashboard).
 */
export class JevSettings {
  private saved: string | null = null;

  constructor(
    private file: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    try {
      this.saved = JSON.parse(fs.readFileSync(file, "utf8")).apiKey ?? null;
    } catch {
      this.saved = null;
    }
  }

  get source(): "env" | "saved" | null {
    return this.env.TYPESAFE_API_KEY ? "env" : this.saved ? "saved" : null;
  }

  client(): JevClient | null {
    const key = this.env.TYPESAFE_API_KEY || this.saved;
    if (!key) return null;
    return new JevClient(key, { baseUrl: this.env.TYPESAFE_BASE_URL, model: this.env.TYPESAFE_MODEL });
  }

  save(apiKey: string | null): void {
    this.saved = apiKey?.trim() || null;
    if (!this.saved) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ apiKey: this.saved }), { mode: 0o600 });
  }
}

export interface JevInfo {
  enabled: boolean;
  source: "env" | "saved" | "test" | null;
  model: string | null;
  problem: string | null;
}

/** The Jev the hub uses right now, and switching it on or off from the AI menu. Emits "change". */
export class JevService extends EventEmitter {
  private client: Jev | null;
  private problem: string | null = null;

  /** `fixed` replaces the key-based client (tests). */
  constructor(
    private settings: JevSettings,
    private fixed?: Jev | null,
  ) {
    super();
    this.client = fixed !== undefined ? fixed : settings.client();
  }

  get current(): Jev | null {
    return this.problem ? null : this.client;
  }

  info(): JevInfo {
    return {
      enabled: Boolean(this.current),
      source: this.fixed !== undefined ? (this.fixed ? "test" : null) : this.settings.source,
      model: this.client?.model ?? null,
      problem: this.problem,
    };
  }

  /** Stops using Jev (e.g. the key was rejected) until a new key is saved. */
  disable(reason: string): void {
    this.problem = reason;
    this.emit("change");
  }

  async setKey(key: string | null): Promise<void> {
    if (this.settings.source === "env") {
      throw new Error("TYPESAFE_API_KEY in .env is in use; change or remove it there.");
    }
    const trimmed = key?.trim() || null;
    if (trimmed) {
      const probe = new JevClient(trimmed, { baseUrl: process.env.TYPESAFE_BASE_URL });
      try {
        await probe.listModels();
      } catch (err) {
        throw new Error(err instanceof JevError && err.status === 401 ? "TypeSafe didn't accept that key." : (err as Error).message);
      }
    }
    this.settings.save(trimmed);
    this.client = this.settings.client();
    this.problem = null;
    this.emit("change");
  }
}

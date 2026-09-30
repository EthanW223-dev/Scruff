import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

/**
 * Client for Jev, TypeSafe's System One model (https://docs.typesafe.ai). Jev doesn't chat or
 * write text: it takes a `state` and typed questions (pick one option, score on levels, yes/no)
 * and answers all of them in one fast call, each with calibrated probabilities. Telos uses it
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
 * Where the key comes from: one pasted into the AI menu (kept in .scruff/typesafe.json, never
 * sent back to the dashboard) or TYPESAFE_API_KEY in .env. A pasted key wins.
 */
export class JevSettings {
  private saved: string | null = null;

  constructor(
    private file: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    try {
      this.saved = cleanKey(JSON.parse(fs.readFileSync(file, "utf8")).apiKey);
    } catch {
      this.saved = null;
    }
  }

  get source(): "env" | "saved" | null {
    return this.saved ? "saved" : cleanKey(this.env.TYPESAFE_API_KEY) ? "env" : null;
  }

  client(key = this.saved ?? cleanKey(this.env.TYPESAFE_API_KEY)): JevClient | null {
    if (!key) return null;
    return new JevClient(key, { baseUrl: this.env.TYPESAFE_BASE_URL, model: this.env.TYPESAFE_MODEL });
  }

  save(apiKey: string | null): void {
    this.saved = cleanKey(apiKey);
    if (!this.saved) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ apiKey: this.saved }), { mode: 0o600 });
  }
}

/** Tolerates what people paste: spaces, quotes, a "Bearer " prefix, placeholder text. */
function cleanKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const k = key.trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
  return k && !/\s/.test(k) && !/^(your|paste|<)/i.test(k) ? k : null;
}

export type JevStatus = "off" | "checking" | "working" | "rejected" | "unreachable";

export interface JevInfo {
  enabled: boolean;
  status: JevStatus;
  source: "env" | "saved" | "test" | null;
  model: string | null;
  problem: string | null;
}

/**
 * The Jev the hub uses right now. Its status comes from real calls (a key check at start and
 * after saving, then every fast-path request), so "on" means TypeSafe actually answered.
 * Emits "change".
 */
export class JevService extends EventEmitter {
  private client: Jev | null;
  private status: JevStatus;
  private problem: string | null = null;

  /** `fixed` replaces the key-based client (tests). */
  constructor(
    private settings: JevSettings,
    private fixed?: Jev | null,
  ) {
    super();
    this.client = fixed !== undefined ? fixed : settings.client();
    this.status = !this.client ? "off" : fixed !== undefined ? "working" : "checking";
    if (this.status === "checking") void this.check();
  }

  /** Null when off or the key was rejected; "unreachable" keeps trying (the network may be back). */
  get current(): Jev | null {
    return this.status === "off" || this.status === "rejected" ? null : this.client;
  }

  info(): JevInfo {
    return {
      enabled: this.status === "working" || this.status === "checking",
      status: this.status,
      source: this.fixed !== undefined ? (this.fixed ? "test" : null) : this.settings.source,
      model: this.client?.model ?? null,
      problem: this.problem,
    };
  }

  /** How the last call went: null for fine, else the error. */
  report(err: unknown): void {
    const [status, problem] = describe(err);
    if (status === this.status && problem === this.problem) return;
    this.status = status;
    this.problem = problem;
    this.emit("change");
  }

  async check(): Promise<void> {
    const client = this.client;
    if (!(client instanceof JevClient)) return;
    try {
      await client.listModels();
      if (this.client === client) this.report(null);
    } catch (err) {
      if (this.client === client) this.report(err);
    }
  }

  /** Saves a key from the AI menu (null forgets it). A key TypeSafe rejects isn't saved. */
  async setKey(key: string | null): Promise<void> {
    const trimmed = cleanKey(key);
    if (key && !trimmed) throw new Error("That doesn't look like an API key. Copy it from console.typesafe.ai/keys.");
    if (trimmed) {
      const [status, problem] = await this.settings
        .client(trimmed)!
        .listModels()
        .then(() => describe(null), describe);
      if (status === "rejected") throw new Error(problem ?? "TypeSafe didn't accept that key.");
      this.settings.save(trimmed);
      this.client = this.settings.client();
      this.status = status;
      this.problem = problem;
    } else {
      this.settings.save(null);
      this.client = this.settings.client(); // falls back to .env, if it has one
      this.status = this.client ? "checking" : "off";
      this.problem = null;
      if (this.client) void this.check();
    }
    this.emit("change");
  }
}

function describe(err: unknown): [JevStatus, string | null] {
  if (!err) return ["working", null];
  if (err instanceof JevError && (err.status === 401 || err.status === 403)) {
    return ["rejected", err.status === 401 ? "TypeSafe didn't accept the API key." : err.message];
  }
  return ["unreachable", (err as Error).message];
}

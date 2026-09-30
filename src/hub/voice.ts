import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

/** Speech engines for spoken replies. Edge is instant (cloud); Kokoro is local and more human. */
export type TtsEngine = "edge" | "kokoro";
export const TTS_ENGINES: TtsEngine[] = ["edge", "kokoro"];

/** Natural-sounding neural voices, via Microsoft's edge-tts. */
export const EDGE_VOICES = [
  "en-US-AndrewNeural",
  "en-US-AvaNeural",
  "en-US-AriaNeural",
  "en-US-BrianNeural",
  "en-GB-RyanNeural",
  "en-GB-SoniaNeural",
] as const;
/** Back-compat alias: the original allowlist was the Edge set. */
export const VOICE_ALLOWLIST = EDGE_VOICES;
export type VoiceId = (typeof VOICE_ALLOWLIST)[number];
export const DEFAULT_VOICE: VoiceId = "en-US-AndrewNeural";
export const VOICE_LABELS: Record<VoiceId, string> = {
  "en-US-AndrewNeural": "Andrew — most natural",
  "en-US-AvaNeural": "Ava — warm, expressive",
  "en-US-AriaNeural": "Aria — friendly",
  "en-US-BrianNeural": "Brian — steady narrator",
  "en-GB-RyanNeural": "Ryan — British, calm",
  "en-GB-SoniaNeural": "Sonia — British, crisp",
};
/** Local Kokoro voices (82M model, runs on the PC's CPU). */
export const KOKORO_VOICES = ["af_heart", "af_bella", "af_sarah", "am_adam", "am_michael", "bf_emma"] as const;
export type KokoroVoiceId = (typeof KOKORO_VOICES)[number];
export const DEFAULT_KOKORO_VOICE: KokoroVoiceId = "af_heart";
export const KOKORO_VOICE_LABELS: Record<KokoroVoiceId, string> = {
  af_heart: "Heart — warm female",
  af_bella: "Bella — bright female",
  af_sarah: "Sarah — smooth female",
  am_adam: "Adam — deep male",
  am_michael: "Michael — steady male",
  bf_emma: "Emma — British female",
};

export function voicesFor(engine: TtsEngine): readonly string[] {
  return engine === "kokoro" ? KOKORO_VOICES : EDGE_VOICES;
}
export function defaultVoiceFor(engine: TtsEngine): string {
  return engine === "kokoro" ? DEFAULT_KOKORO_VOICE : DEFAULT_VOICE;
}
export function isVoiceFor(engine: TtsEngine, voice: string): boolean {
  return (voicesFor(engine) as readonly string[]).includes(voice);
}
/** Spoken replies are short by design; edge-tts also handles long text poorly. */
export const MAX_VOICE_CHARS = 600;
const MAX_CACHED_FILES = 100;

const execFileAsync = promisify(execFile);

/** A voice failure the hub turns into a 503 with a human-readable hint. */
export class VoiceError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

/**
 * Strips markdown and other unreadable artifacts so the voice doesn't read
 * "**bold**" or hex addresses out loud. Caps length for speech.
 */
export function sanitizeVoiceText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [label](url) -> label
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // **bold**, __bold__
    .replace(/(`{1,3})(.*?)\1/g, "$2") // `code`
    .replace(/(^|\s)#{1,6}\s+/g, "$1") // # headings
    .replace(/0x[0-9A-Fa-f]+/g, "that address")
    .replace(/[*_~>|]/g, "") // leftover markdown punctuation
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_VOICE_CHARS);
}

export function voiceCacheKey(text: string, voice: string): string {
  return createHash("sha1").update(`${voice}\n${text}`).digest("hex");
}

/** undefined = not probed yet, null = probed and missing. Otherwise the argv that imports edge_tts. */
let pythonWithTts: string[] | null | undefined;

/** Last background probe of the edge-tts engine; null until the first probe finishes. */
let engineReady: boolean | null = null;
let engineProbedAt = 0;
const ENGINE_PROBE_TTL = 60_000;

/**
 * Starts (or refreshes) the background probe for the edge-tts engine. Cheap to
 * call often: it re-probes at most once a minute, so installing edge-tts while
 * the hub runs flips the dashboard's voice section without a restart.
 * Resolves with the probe result; the hub awaits the first call at startup so
 * the first hello already carries the true engine state.
 */
export function probeVoiceEngineNow(): Promise<boolean> {
  const now = Date.now();
  if (engineReady !== null && now - engineProbedAt < ENGINE_PROBE_TTL)
    return Promise.resolve(engineReady);
  engineProbedAt = now;
  // A past miss is cached as null; drop it so a later install can succeed.
  if (engineReady === false) pythonWithTts = undefined;
  return findPython().then(
    () => (engineReady = true),
    () => (engineReady = false),
  );
}

export function probeVoiceEngine(): void {
  void probeVoiceEngineNow();
}

/** Sync read of the last engine probe. False until the first probe completes. */
export function voiceEngineReady(): boolean {
  return engineReady === true;
}

/**
 * Kokoro probe. Deliberately cheap: it only checks the package is importable
 * (find_spec, no onnxruntime import) instead of loading the ~600MB model. The
 * real load happens once, inside the daemon, on first use.
 */
let kokoroInstalled: boolean | null = null;
let kokoroProbedAt = 0;

export async function probeKokoroEngineNow(): Promise<boolean> {
  const now = Date.now();
  if (kokoroInstalled !== null && now - kokoroProbedAt < ENGINE_PROBE_TTL)
    return kokoroInstalled;
  kokoroProbedAt = now;
  let bin: string[];
  try {
    bin = await findPython();
  } catch {
    return (kokoroInstalled = false);
  }
  try {
    await execFileAsync(
      bin[0],
      [...bin.slice(1), "-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('kokoro_onnx') else 1)"],
      { timeout: 30000 },
    );
    return (kokoroInstalled = true);
  } catch {
    return (kokoroInstalled = false);
  }
}

/** Fire-and-forget kokoro probe; the next describe() will carry the result. */
function pokeKokoroProbe(): void {
  if (kokoroInstalled === null) void probeKokoroEngineNow().catch(() => {});
}

/**
 * Readiness of the engine the user actually picked. Kokoro is optimistic until
 * the probe says otherwise — the first real synthesis failure then carries the
 * honest install hint, and the probe result sticks from then on.
 */
export function selectedEngineReady(engine: TtsEngine): boolean {
  if (engine === "kokoro") {
    pokeKokoroProbe();
    return kokoroInstalled !== false;
  }
  return voiceEngineReady();
}

/** Readiness of each speech engine. Kokoro is probed on demand (first use / engine pick). */
export function voiceEnginesReady(): { edge: boolean; kokoro: boolean } {
  return { edge: voiceEngineReady(), kokoro: kokoroInstalled === true };
}

/** Marks the kokoro probe stale so the next read re-checks (e.g. after install). */
export function resetKokoroProbe(): void {
  kokoroInstalled = null;
  kokoroProbedAt = 0;
}

/** Remembers which interpreters were probed so the error names them. */
const triedBins: string[] = [];

async function findPython(): Promise<string[]> {
  if (pythonWithTts !== undefined) {
    if (pythonWithTts === null) throw voiceMissingError(triedBins);
    return pythonWithTts;
  }
  // Candidates as argv arrays: explicit SCRUFF_PYTHON override first (for when
  // `python` on PATH isn't the interpreter edge-tts was installed into), then
  // the usual names, then the Windows `py` launcher.
  const candidates: string[][] = [];
  if (process.env.SCRUFF_PYTHON) candidates.push([process.env.SCRUFF_PYTHON]);
  candidates.push(["python"], ["python3"]);
  if (process.platform === "win32") candidates.push(["py", "-3"]);
  for (const argv of candidates) {
    triedBins.push(argv.join(" "));
    try {
      await execFileAsync(argv[0], [...argv.slice(1), "-c", "import edge_tts"], { timeout: 15000 });
      pythonWithTts = argv;
      return argv;
    } catch {
      // try the next candidate
    }
  }
  pythonWithTts = null;
  throw voiceMissingError(triedBins);
}

function voiceMissingError(tried: string[]): VoiceError {
  const where = tried.length ? ` (tried: ${tried.join(", ")})` : "";
  const fix = process.env.SCRUFF_PYTHON
    ? `SCRUFF_PYTHON is set but that python lacks edge-tts — run: "${process.env.SCRUFF_PYTHON}" -m pip install edge-tts`
    : `Run: python -m pip install edge-tts — or set SCRUFF_PYTHON to the python that has it`;
  return new VoiceError(`The edge-tts module isn't installed${where}.`, fix);
}

/**
 * Synthesizes speech, caching the audio by sha1(engine + voice + text) under
 * cacheDir. Edge returns mp3; Kokoro returns wav. Throws VoiceError when
 * synthesis is unavailable.
 */
export async function synthesizeVoice(opts: {
  text: string;
  voice: string;
  engine: TtsEngine;
  cacheDir: string;
}): Promise<{ file: string; cached: boolean; mime: string }> {
  const { text, voice, engine, cacheDir } = opts;
  fs.mkdirSync(cacheDir, { recursive: true });
  if (engine === "kokoro") {
    if (!isVoiceFor("kokoro", voice)) throw new VoiceError(`Unknown Kokoro voice ${voice}.`, "Pick a voice from the list.");
    const file = path.join(cacheDir, `${voiceCacheKey(text, `kokoro:${voice}`)}.wav`);
    if (fs.existsSync(file)) return { file, cached: true, mime: "audio/wav" };
    await kokoroSay({ text, voice, file });
    pruneCache(cacheDir);
    return { file, cached: false, mime: "audio/wav" };
  }
  const file = path.join(cacheDir, `${voiceCacheKey(text, voice)}.mp3`);
  if (fs.existsSync(file)) return { file, cached: true, mime: "audio/mpeg" };
  const bin = await findPython();
  try {
    await execFileAsync(bin[0], [...bin.slice(1), "-m", "edge_tts", "--voice", voice, "--text", text, "--write-media", file], { timeout: 60000 });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new VoiceError(`edge-tts failed: ${(err as Error).message}`, "pip install edge-tts");
  }
  pruneCache(cacheDir);
  return { file, cached: false, mime: "audio/mpeg" };
}

/* ------------------------------------------------------------------ */
/* Kokoro: persistent daemon so the model loads once, not per sentence */
/* ------------------------------------------------------------------ */

let kokoroProc: ChildProcess | null = null;
let kokoroReady: Promise<void> | null = null;
let kokoroStarting = false;
let kokoroReqId = 0;
const kokoroPending = new Map<number, { resolve: (file: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
const KOKORO_READY_TIMEOUT = 10 * 60 * 1000; // first run downloads the ~330MB model
const KOKORO_SAY_TIMEOUT = 180_000;

function kokoroInstallHint(bin: string[]): string {
  return `Run: "${bin[0]}" -m pip install kokoro-onnx espeakng_loader (then restart Telos)`;
}

function ensureKokoroDaemon(): Promise<void> {
  if (kokoroProc && !kokoroProc.killed && kokoroReady) return kokoroReady;
  if (kokoroStarting && kokoroReady) return kokoroReady;
  kokoroStarting = true;
  kokoroReady = (async () => {
    let bin: string[];
    try {
      bin = await findPython();
    } catch (e) {
      throw e instanceof VoiceError ? e : new VoiceError("No Python with edge-tts found.", "pip install edge-tts");
    }
    const daemonPath = fileURLToPath(new URL("./kokoro_daemon.py", import.meta.url));
    if (!fs.existsSync(daemonPath)) throw new VoiceError("Kokoro daemon missing from the install.", "Pull the latest Telos code.");
    const proc = spawn(bin[0], [...bin.slice(1), "-u", daemonPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    kokoroProc = proc;
    let buf = "";
    let settled = false;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new VoiceError("Kokoro is still loading the model.", "Wait a minute and try again."));
        }
      }, KOKORO_READY_TIMEOUT);
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.ready === true && !settled) {
          settled = true;
          clearTimeout(timer);
          kokoroInstalled = true;
          resolve();
        } else if (msg.ready === false && !settled) {
          settled = true;
          clearTimeout(timer);
          kokoroInstalled = false;
          reject(new VoiceError(`Kokoro failed to start: ${msg.error ?? "unknown"}`, kokoroInstallHint(bin)));
        } else if (typeof msg.id === "number") {
          const p = kokoroPending.get(msg.id);
          if (p) {
            kokoroPending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.file);
            else p.reject(new VoiceError(`Kokoro synthesis failed: ${msg.error ?? "unknown"}`, kokoroInstallHint(bin)));
          }
        }
      };
      proc.stdout!.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      proc.stderr!.on("data", () => {
        /* daemon chatter stays out of the hub log */
      });
      proc.on("exit", () => {
        kokoroProc = null;
        kokoroStarting = false;
        kokoroReady = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new VoiceError("The Kokoro daemon exited during startup.", kokoroInstallHint(bin)));
        }
        for (const [, p] of kokoroPending) {
          clearTimeout(p.timer);
          p.reject(new VoiceError("The Kokoro daemon exited.", "Restart Telos and try again."));
        }
        kokoroPending.clear();
      });
      proc.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new VoiceError(`Couldn't launch Kokoro: ${(err as Error).message}`, kokoroInstallHint(bin)));
        }
      });
    });
    // If the daemon dies later, the next call starts it again.
    void ready.catch(() => {
      kokoroStarting = false;
    });
    return ready;
  })();
  return kokoroReady;
}

async function kokoroSay(opts: { text: string; voice: string; file: string }): Promise<void> {
  await ensureKokoroDaemon();
  const proc = kokoroProc;
  if (!proc?.stdin?.writable) throw new VoiceError("The Kokoro daemon isn't running.", "Restart Telos and try again.");
  const id = ++kokoroReqId;
  await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      kokoroPending.delete(id);
      reject(new VoiceError("Kokoro took too long to speak.", "Try a shorter sentence."));
    }, KOKORO_SAY_TIMEOUT);
    kokoroPending.set(id, { resolve, reject, timer });
    proc.stdin!.write(JSON.stringify({ id, text: opts.text, voice: opts.voice, speed: 1.0, file: opts.file }) + "\n", (err) => {
      if (err) {
        kokoroPending.delete(id);
        clearTimeout(timer);
        reject(new VoiceError(`Couldn't reach the Kokoro daemon: ${err.message}`, "Restart Telos and try again."));
      }
    });
  });
  if (!fs.existsSync(opts.file)) throw new VoiceError("Kokoro produced no audio file.", "Try again.");
}

/** Asks the daemon to exit; the hub calls this on shutdown. */
export function stopKokoroDaemon(): void {
  const proc = kokoroProc;
  kokoroProc = null;
  kokoroReady = null;
  kokoroStarting = false;
  if (proc && !proc.killed) {
    try {
      proc.stdin?.write(JSON.stringify({ id: ++kokoroReqId, shutdown: true }) + "\n");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, 2000).unref();
  }
}

function pruneCache(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".mp3") || f.endsWith(".wav"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(MAX_CACHED_FILES)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // best effort: a full cache is a nuisance, not a failure
  }
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** Natural-sounding neural voices for spoken replies, via Microsoft's edge-tts. */
export const VOICE_ALLOWLIST = ["en-US-AriaNeural", "en-US-JennyNeural", "en-US-GuyNeural", "en-GB-SoniaNeural"] as const;
export type VoiceId = (typeof VOICE_ALLOWLIST)[number];
export const DEFAULT_VOICE: VoiceId = "en-US-AriaNeural";
export const VOICE_LABELS: Record<VoiceId, string> = {
  "en-US-AriaNeural": "Aria — warm, natural",
  "en-US-JennyNeural": "Jenny — friendly",
  "en-US-GuyNeural": "Guy — deep",
  "en-GB-SoniaNeural": "Sonia — British",
};
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

/** undefined = not probed yet, null = probed and missing. */
let pythonWithTts: string | null | undefined;

async function findPython(): Promise<string> {
  if (pythonWithTts !== undefined) {
    if (pythonWithTts === null) throw new VoiceError("The edge-tts module isn't installed.", "pip install edge-tts");
    return pythonWithTts;
  }
  for (const bin of ["python", "python3"]) {
    try {
      await execFileAsync(bin, ["-c", "import edge_tts"], { timeout: 15000 });
      pythonWithTts = bin;
      return bin;
    } catch {
      // try the next binary
    }
  }
  pythonWithTts = null;
  throw new VoiceError("The edge-tts module isn't installed.", "pip install edge-tts");
}

/**
 * Synthesizes speech with a Microsoft neural voice, caching the mp3 by
 * sha1(text + voice) under cacheDir. Throws VoiceError when synthesis is unavailable.
 */
export async function synthesizeVoice(opts: { text: string; voice: string; cacheDir: string }): Promise<{ file: string; cached: boolean }> {
  const { text, voice, cacheDir } = opts;
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${voiceCacheKey(text, voice)}.mp3`);
  if (fs.existsSync(file)) return { file, cached: true };
  const bin = await findPython();
  try {
    await execFileAsync(bin, ["-m", "edge_tts", "--voice", voice, "--text", text, "--write-media", file], { timeout: 60000 });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new VoiceError(`edge-tts failed: ${(err as Error).message}`, "pip install edge-tts");
  }
  pruneCache(cacheDir);
  return { file, cached: false };
}

function pruneCache(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(MAX_CACHED_FILES)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // best effort: a full cache is a nuisance, not a failure
  }
}

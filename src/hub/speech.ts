import path from "node:path";

/**
 * Local speech-to-text with Whisper, for push-to-talk in the overlay (Electron has no
 * built-in speech recognition). Runs on your CPU; the model (~80 MB) downloads on first use
 * and is cached in .scruff/models. The audio never leaves your PC.
 */

const MODEL = process.env.SCRUFF_WHISPER_MODEL ?? "onnx-community/whisper-base.en";
export const SAMPLE_RATE = 16_000;

type Transcriber = (audio: Float32Array) => Promise<{ text: string } | { text: string }[]>;
let loading: Promise<Transcriber> | null = null;

export function speechModel(): string {
  return MODEL;
}

/** Loads the model (downloading it the first time). `onStatus` reports progress for the UI. */
function load(dataDir: string, onStatus: (text: string) => void): Promise<Transcriber> {
  loading ??= (async () => {
    onStatus("Loading the voice model (the first time downloads about 80 MB)…");
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = process.env.SCRUFF_MODELS_DIR ?? path.join(dataDir, "models");
    const asr = await pipeline("automatic-speech-recognition", MODEL, { dtype: "q8" });
    return asr as unknown as Transcriber;
  })();
  loading.catch(() => {
    loading = null; // let the next attempt retry (e.g. after going back online)
  });
  return loading;
}

/** `pcm` is 16 kHz mono, 16-bit. */
export async function transcribe(pcm: Int16Array, dataDir: string, onStatus: (text: string) => void): Promise<string> {
  const asr = await load(dataDir, onStatus);
  const audio = Float32Array.from(pcm, (s) => s / 32768);
  const result = await asr(audio);
  const text = (Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text).trim();
  // Whisper's usual hallucinations on silence.
  return /^\[?(blank_audio|silence|music|inaudible)\]?$|^(\(.*\)|\.+)$/i.test(text) ? "" : text;
}

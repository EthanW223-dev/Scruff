import type { Brain } from "./agent.ts";
import { ImageNotSupportedError } from "./providers/openai.ts";

/**
 * A chat model that can look at screenshots. Jev can't (text only), so this is always the
 * chat Brain: Claude, or a local vision model (e.g. `ollama pull qwen3-vl`). The OpenAI-
 * compatible provider already converts image blocks and reports when a model can't see them.
 */
export interface VisionClient {
  readonly model: string;
  ask(jpegBase64: string, question: string, signal: AbortSignal): Promise<string>;
}

export class VisionError extends Error {
  constructor(
    message: string,
    readonly code: "no-vision" | "failed",
  ) {
    super(message);
  }
}

/** One-shot question about a screenshot, through any Brain. No tools, no history. */
export async function askVision(
  brain: Brain,
  jpegBase64: string,
  question: string,
  signal: AbortSignal,
): Promise<string> {
  const stream = brain.createStream(
    {
      model: brain.model,
      max_tokens: 300,
      // A blind model must fail, not answer without the screenshot.
      strictVision: true,
      system:
        "You look at game screenshots and answer briefly about what you see. " +
        "Reply with exactly what was asked and nothing else.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
          ],
        },
      ],
    } as Parameters<Brain["createStream"]>[0],
    signal,
  );
  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof ImageNotSupportedError || isImageRejection(err)) {
      throw new VisionError(
        `${brain.model} can't see images. Use Claude, or a vision model on your PC (for example: ollama pull qwen3-vl).`,
        "no-vision",
      );
    }
    throw new VisionError(`Couldn't read the screen: ${(err as Error).message}`, "failed");
  }
  const texts: string[] = [];
  for (const b of message.content) if (b.type === "text") texts.push(b.text);
  const text = texts.join(" ").trim();
  if (!text) throw new VisionError("The model gave no answer about the screenshot.", "failed");
  return text;
}

function isImageRejection(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /400/.test(m) && /image|vision|multimodal/i.test(m);
}

/** "What number is shown for the player's X?" — answered from a screenshot. */
export function hudQuestion(what: string, game: string | null): string {
  return (
    `This is a screenshot of the game ${game ?? "the player is playing"}. ` +
    `What number is shown for the player's ${what}? Look at the HUD, resource counters and inventory numbers. ` +
    `Reply with just the number (with decimals if shown), or "not visible" if you can't see it.`
  );
}

/** "Was it just set to Y?" — answered from a screenshot after a write. */
export function confirmQuestion(what: string, expected: string): string {
  return (
    `This is a screenshot of a game. The player's ${what} was just changed to ${expected}. ` +
    `Is the ${what} number visible on screen right now? If yes, what number does it show? ` +
    `Reply with just the number you see, or "not visible" if the ${what} counter isn't on screen.`
  );
}

/** "Did the visual change happen?" — answered from a screenshot after a mod. */
export function visualQuestion(change: string): string {
  return (
    `This is a screenshot of a game. The player just asked for this change: "${change}". ` +
    `Did it visibly happen? Reply with just "yes" if you can see the change, "no" if the scene ` +
    `is visible but the change clearly didn't happen, or "not visible" if you can't tell from this shot.`
  );
}

/**
 * Did the screen confirm the mod? "yes" it's visible, "no" the scene is visible but unchanged,
 * "unknown" when the shot can't tell (never treat that as a failure).
 */
export function parseVisual(reply: string): "yes" | "no" | "unknown" {
  const r = reply.toLowerCase();
  if (/not visible|can't see|cannot see|unable to|don't see|can't tell/i.test(r)) return "unknown";
  if (/\byes\b/.test(r)) return "yes";
  if (/\bno\b/.test(r)) return "no";
  return "unknown";
}

/** First number in a reply ("12", "about 4.75 cans", "not visible" → null). */
export function parseNumber(reply: string): number | null {
  if (/not visible|can't see|cannot see|unable to|don't see/i.test(reply)) return null;
  const m = reply.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Did the HUD confirm the write? "yes" the number matches, "no" it's visible but different,
 * "unknown" when the counter isn't on screen (never treat that as a failure).
 */
export function parseConfirm(reply: string, expected: number): "yes" | "no" | "unknown" {
  const seen = parseNumber(reply);
  if (seen !== null) {
    const close = Math.abs(seen - expected) <= Math.max(0.01, Math.abs(expected) * 1e-4);
    return close ? "yes" : "no";
  }
  const r = reply.toLowerCase();
  if (/not visible|can't see|cannot see|unable to|don't see/.test(r)) return "unknown";
  if (/\byes\b/.test(r)) return "yes";
  if (/\bno\b/.test(r)) return "no";
  return "unknown";
}

/** Builds a VisionClient from a Brain factory (a fresh Brain per call, so a visionless local
 * model doesn't poison the agent's own provider state). */
export function visionFromBrain(makeBrain: () => Brain, modelName?: string): VisionClient {
  return {
    get model() {
      return modelName ?? makeBrain().model;
    },
    async ask(jpegBase64: string, question: string, signal: AbortSignal): Promise<string> {
      return askVision(makeBrain(), jpegBase64, question, signal);
    },
  };
}

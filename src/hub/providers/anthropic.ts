import Anthropic from "@anthropic-ai/sdk";
import type { StreamFactory } from "../agent.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Shown when the model list can't be fetched (no key yet). */
export const CLAUDE_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5-5", "claude-fable-5-1"];

/** Adaptive thinking and effort exist from the 4.6 generation on; older models reject them. */
const MODERN = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/;
/** Models that accept `fallbacks: "default"`. */
const FALLBACKS = /^claude-(opus-5|fable-5)/;

export function claudeStreamFactory(client: Anthropic, effort: Effort): StreamFactory {
  return (params, signal) => {
    const modern = MODERN.test(params.model);
    // strictVision is a Scruff-internal flag for the OpenAI-compatible provider; never send it.
    const { strictVision: _strictVision, ...rest } = params as typeof params & { strictVision?: boolean };
    return client.beta.messages.stream(
      {
        ...rest,
        // Caches the whole prefix up to the latest message, so each step only pays for what's new.
        cache_control: { type: "ephemeral" },
        ...(modern ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } } : {}),
        // If a safety classifier declines (memory editing can look like hacking), retry on the recommended model.
        ...(FALLBACKS.test(params.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    );
  };
}

export async function listClaudeModels(client: Anthropic): Promise<string[]> {
  const ids: string[] = [];
  for await (const model of client.models.list({ limit: 100 })) ids.push(model.id);
  return ids.length ? ids : CLAUDE_MODELS;
}

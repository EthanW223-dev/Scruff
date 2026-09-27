import type Anthropic from "@anthropic-ai/sdk";
import type { ModelStream, StreamFactory } from "../src/hub/agent.ts";

type Params = Parameters<StreamFactory>[0];
type Block = Anthropic.Beta.BetaContentBlock;

export interface Reply {
  content: Block[];
  stop_reason?: Anthropic.Beta.BetaMessage["stop_reason"];
}

export const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
let nextId = 1;
export const toolUse = (name: string, input: unknown): Block =>
  ({ type: "tool_use", id: `toolu_${nextId++}`, name, input }) as Block;

/**
 * A stand-in for Claude driven by a deterministic policy, so the whole hub can be tested
 * without an API key. Records every request it receives.
 */
export function fakeModel(policy: (params: Params) => Reply | Promise<Reply>) {
  const calls: Params[] = [];
  const factory: StreamFactory = (params, signal) => {
    // Snapshot: the agent keeps appending to the same array.
    calls.push(structuredClone({ ...params, messages: params.messages }));
    const listeners: Record<string, ((delta: string) => void)[]> = {};
    const stream: ModelStream = {
      on(event: string, listener: (delta: string) => void) {
        (listeners[event] ??= []).push(listener);
        return stream;
      },
      async finalMessage() {
        const reply = await policy(params);
        await new Promise((r) => setTimeout(r, 5));
        if (signal.aborted) throw new Error("Request was aborted.");
        for (const block of reply.content) {
          if (block.type === "text") for (const l of listeners.text ?? []) l(block.text);
        }
        const hasTool = reply.content.some((b) => b.type === "tool_use");
        return {
          id: `msg_${nextId++}`,
          type: "message",
          role: "assistant",
          model: params.model,
          content: reply.content,
          stop_reason: reply.stop_reason ?? (hasTool ? "tool_use" : "end_turn"),
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Beta.BetaMessage;
      },
    } as ModelStream;
    return stream;
  };
  return { factory, calls };
}

/** Text of the newest user message, or null when it's a batch of tool results. */
export function lastUserText(params: Params): string | null {
  const last = params.messages.at(-1)!;
  if (typeof last.content === "string") return last.content;
  const texts = last.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  return last.content.some((b) => b.type === "tool_result") ? null : texts.at(-1) ?? "";
}

/** The newest tool call and its result text. */
export function lastToolResult(params: Params): { name: string; input: any; result: string; isError: boolean } | null {
  const msgs = params.messages;
  const results = msgs.at(-1)!;
  const calls = msgs.at(-2);
  if (typeof results.content === "string" || !calls || typeof calls.content === "string") return null;
  const result = results.content.find((b) => b.type === "tool_result") as Anthropic.Beta.BetaToolResultBlockParam | undefined;
  const call = calls.content.find((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock | undefined;
  if (!result || !call) return null;
  const content = result.content;
  const resultText = typeof content === "string" ? content : (content ?? []).map((b) => ("text" in b ? b.text : `[${b.type}]`)).join("");
  return { name: call.name, input: call.input, result: resultText, isError: Boolean(result.is_error) };
}

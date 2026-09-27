import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { EventEmitter } from "node:events";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { ToolInputError, toApiTools, type HubTool, type ToolResultContent } from "./tools.ts";

type Params = BetaMessageStreamParams;
type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * The slice of the SDK's BetaMessageStream the agent uses. Every provider (Claude, local
 * models, tests) produces this shape; history is always kept in the Claude message format.
 */
export interface ModelStream {
  on(event: "text", listener: (delta: string) => void): unknown;
  on(event: "thinking", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Message>;
}
export type StreamFactory = (params: Params, signal: AbortSignal) => ModelStream;

/** Which model answers, and how to reach it. */
export interface Brain {
  model: string;
  createStream: StreamFactory;
}

export interface AgentOptions {
  brain: Brain;
  /** Fixed for the session; see prompt.ts for why. */
  tools: HubTool[];
  /** Status text (attached game, adapters, events). Sent with a user message when it changes. */
  status: () => { note: string; events: string[] };
}

/** Events for the dashboard. */
export type AgentEvent =
  | { type: "user"; text: string }
  | { type: "turn_start" }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_progress"; id: string; text: string }
  | { type: "tool_result"; id: string; ok: boolean; text: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string }
  | { type: "turn_end" };

const MAX_TOKENS = 16000;
const MAX_STEPS = 40;
const MAX_JSON_RETRIES = 2;

/**
 * One ongoing conversation with the AI. The history is append-only (never edited), which
 * keeps Claude's prompt cache warm and its replayed thinking blocks valid.
 */
export class Agent extends EventEmitter {
  private messages: MessageParam[] = [];
  private queue: string[] = [];
  private running = false;
  private controller: AbortController | null = null;
  private lastNote = "";
  private toolsByName: Map<string, HubTool>;
  private apiTools: Anthropic.Beta.BetaTool[];

  constructor(private opts: AgentOptions) {
    super();
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
    this.apiTools = toApiTools(opts.tools);
  }

  get busy(): boolean {
    return this.running;
  }

  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queue.push(trimmed);
    if (!this.running) void this.drain();
  }

  stop(): void {
    this.queue = [];
    this.controller?.abort();
  }

  reset(): void {
    this.stop();
    this.messages = [];
    this.lastNote = "";
  }

  get brain(): Brain {
    return this.opts.brain;
  }

  /** Switches models. Starts a new conversation: histories don't carry across models cleanly. */
  setBrain(brain: Brain): void {
    this.reset();
    this.opts.brain = brain;
  }

  private emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length) {
        const text = this.queue.shift()!;
        this.emitEvent({ type: "user", text });
        this.controller = new AbortController();
        this.emitEvent({ type: "turn_start" });
        try {
          await this.turn(text, this.controller.signal);
        } catch (err) {
          if (!this.controller.signal.aborted) this.emitEvent({ type: "error", text: describeError(err) });
        }
        if (this.controller.signal.aborted) this.emitEvent({ type: "notice", text: "Stopped." });
        this.emitEvent({ type: "turn_end" });
      }
    } finally {
      this.controller = null;
      this.running = false;
    }
  }

  private userContent(text: string): MessageParam["content"] {
    const { note, events } = this.opts.status();
    const parts: string[] = [];
    if (note !== this.lastNote) {
      parts.push(note);
      this.lastNote = note;
    }
    if (events.length) parts.push(`Game events since the last message:\n${events.map((e) => `- ${e}`).join("\n")}`);
    if (!parts.length) return text;
    return [
      { type: "text", text: `[Scruff status]\n${parts.join("\n\n")}\n[/Scruff status]` },
      { type: "text", text },
    ];
  }

  private async turn(text: string, signal: AbortSignal): Promise<void> {
    // Held for the whole turn: if "New chat" swaps in a fresh history mid-turn, this turn's
    // leftovers must not land in it.
    const messages = this.messages;
    const turnStart = messages.length;
    messages.push({ role: "user", content: this.userContent(text) });
    let jsonRetries = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = this.opts.brain.createStream(this.params(messages), signal);
      stream.on("text", (delta) => this.emitEvent({ type: "text", text: delta }));
      stream.on("thinking", (delta) => this.emitEvent({ type: "thinking", text: delta }));

      let message: Message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        if (signal.aborted) return;
        // With eager input streaming a tool input can arrive as unparseable JSON; re-issue the request.
        if (!isToolJsonError(err) || jsonRetries++ >= MAX_JSON_RETRIES) throw err;
        continue;
      }

      if (message.stop_reason === "refusal") {
        // Drop the whole turn so the same request doesn't keep being declined.
        messages.length = turnStart;
        this.lastNote = "";
        this.emitEvent({ type: "error", text: "Claude declined that request." });
        return;
      }

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        // The tool input was cut off; never run it, and don't keep an unanswered tool call in history.
        this.emitEvent({ type: "error", text: "The reply was too long and got cut off. Try asking for less at once." });
        return;
      }

      messages.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "pause_turn") continue;
      if (!toolUses.length) return;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        if (signal.aborted) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Cancelled by the user." });
          continue;
        }
        results.push(await this.runTool(use, signal));
      }
      messages.push({ role: "user", content: results });
      if (signal.aborted) return;
    }
    this.emitEvent({ type: "error", text: `Stopped after ${MAX_STEPS} steps.` });
  }

  private async runTool(
    use: Anthropic.Beta.BetaToolUseBlock,
    signal: AbortSignal,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    this.emitEvent({ type: "tool_call", id: use.id, name: use.name, input: use.input });
    const tool = this.toolsByName.get(use.name);
    let content: ToolResultContent;
    let isError = false;
    try {
      if (!tool) throw new Error(`Unknown tool ${use.name}.`);
      content = await tool.run(use.input, {
        signal,
        progress: (text) => this.emitEvent({ type: "tool_progress", id: use.id, text }),
      });
    } catch (err) {
      isError = true;
      content =
        err instanceof ToolInputError
          ? JSON.stringify({ INVALID_JSON: JSON.stringify(use.input), error: err.message })
          : (err as Error).message;
    }
    this.emitEvent({ type: "tool_result", id: use.id, ok: !isError, text: summarize(content) });
    return { type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) };
  }

  /** Provider-neutral request; each provider adds its own options (see providers/). */
  private params(messages: MessageParam[]): Params {
    return {
      model: this.opts.brain.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: this.apiTools,
      messages,
    };
  }
}

function summarize(content: ToolResultContent): string {
  if (!content) return "";
  if (typeof content === "string") return content.length > 600 ? content.slice(0, 600) + "…" : content;
  return content
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join(" ")
    .slice(0, 600);
}

/** The SDK has no dedicated class for this; it's the only non-API error worth retrying. */
function isToolJsonError(err: unknown): boolean {
  return (
    err instanceof Anthropic.AnthropicError &&
    !(err instanceof Anthropic.APIError) &&
    err.message.startsWith("Unable to parse tool parameter JSON")
  );
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in your .env file.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  if (err instanceof Anthropic.AnthropicError && /authentication method/i.test(err.message)) {
    return "No Anthropic API key found. Add ANTHROPIC_API_KEY to .env, or pick a local model in the AI menu.";
  }
  return (err as Error)?.message ?? String(err);
}

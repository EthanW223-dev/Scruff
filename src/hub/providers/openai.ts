import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ModelStream, StreamFactory } from "../agent.ts";

/**
 * Any model behind an OpenAI-compatible chat API: Ollama, LM Studio, llama.cpp, vLLM, Jan,
 * OpenRouter, OpenAI, Groq, Gemini... Telos keeps its history in Claude's message format, so
 * this converts each request to chat completions and turns the streamed answer back into a
 * Claude-shaped message.
 */

/** App-identification headers OpenRouter asks API clients to send. */
export const OPENROUTER_APP_HEADERS = {
  "HTTP-Referer": "https://github.com/EthanW223-dev/Scruff",
  "X-Title": "Telos",
} as const;

/** True for requests headed to OpenRouter's API (key checks and chat alike). */
export function isOpenRouterURL(baseURL: string): boolean {
  return baseURL.includes("openrouter.ai");
}

type Params = Parameters<StreamFactory>[0];
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface OpenAICompatibleConfig {
  /** Shown in error messages, e.g. "Ollama". */
  label: string;
  baseURL: string;
  apiKey?: string;
}

export function openAICompatibleStreamFactory(config: OpenAICompatibleConfig): StreamFactory {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey || "not-needed",
    maxRetries: 1,
    defaultHeaders: isOpenRouterURL(config.baseURL) ? { ...OPENROUTER_APP_HEADERS } : undefined,
  });
  // Flipped off the first time the server rejects images (text-only local models).
  let vision = true;

  return (params, signal) => {
    const listeners = { text: [] as ((d: string) => void)[], thinking: [] as ((d: string) => void)[] };
    const emit = (kind: "text" | "thinking", delta: string) => {
      if (delta) for (const l of listeners[kind]) l(delta);
    };

    const run = async (): Promise<Anthropic.Beta.BetaMessage> => {
      let stream;
      try {
        stream = await client.chat.completions.create(toRequest(params, vision), { signal });
      } catch (err) {
        if (vision && isImageRejection(err)) {
          // Vision calls from Telos (screenshots) would rather fail than have a blind
          // model answer without the image.
          if (strictVision(params)) throw new ImageNotSupportedError(`${config.label} can't see images with ${params.model}.`);
          vision = false;
          stream = await client.chat.completions.create(toRequest(params, false), { signal });
        } else {
          throw friendlyError(err, config, params.model);
        }
      }

      const splitter = new ThinkSplitter();
      const calls: { id: string; name: string; args: string }[] = [];
      let text = "";
      let finish: string | null = null;
      try {
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          const delta = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
          emit("thinking", delta.reasoning_content ?? delta.reasoning ?? "");
          if (delta.content) {
            splitter.push(delta.content, (kind, part) => {
              if (kind === "text") text += part;
              emit(kind, part);
            });
          }
          for (const tc of delta.tool_calls ?? []) {
            const call = (calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" });
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name += tc.function.name;
            if (tc.function?.arguments) call.args += tc.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (err) {
        throw friendlyError(err, config, params.model);
      }
      splitter.flush((kind, part) => {
        if (kind === "text") text += part;
        emit(kind, part);
      });

      const toolUses = calls.filter(Boolean).map((c, i) => ({
        type: "tool_use" as const,
        id: c.id || `call_${Date.now().toString(36)}_${i}`,
        name: c.name,
        input: parseArguments(c.args),
      }));
      const content = [...(text.trim() ? [{ type: "text", text: text.trim(), citations: null }] : []), ...toolUses] as Block[];
      return {
        id: `local_${Date.now().toString(36)}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content,
        // Some servers report "stop" even when they called tools.
        stop_reason: toolUses.length ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    };

    const result = run();
    result.catch(() => {}); // surfaced through finalMessage()
    const stream: ModelStream = {
      on(event: "text" | "thinking", listener: (delta: string) => void) {
        listeners[event].push(listener);
        return stream;
      },
      finalMessage: () => result,
    } as ModelStream;
    return stream;
  };
}

export function toRequest(params: Params, vision: boolean): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  return {
    model: params.model,
    stream: true,
    messages: toChatMessages(typeof params.system === "string" ? params.system : "", params.messages, vision),
    tools: (params.tools ?? []).flatMap((t) =>
      "input_schema" in t
        ? [{ type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters: t.input_schema as Record<string, unknown> } }]
        : [],
    ),
  };
}

/** Claude-format history → chat-completions messages. */
export function toChatMessages(system: string, messages: Params["messages"], vision: boolean): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role as "user" | "assistant", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const toolCalls = m.content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
          : [],
      );
      // Nothing said and nothing called (e.g. only thinking): nothing to send.
      if (!text && !toolCalls.length) continue;
      // Never null: Ollama rejects it ("invalid message content type: <nil>"); "" works everywhere.
      out.push({ role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // A user turn: tool results must come first, straight after the assistant's tool calls.
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const { text, images } = flattenToolResult(b as ToolResult);
        let body = (b as ToolResult).is_error ? `Error: ${text}` : text;
        if (images.length) body += vision ? "\n(Screenshot attached in the next message.)" : "\n(A screenshot was taken, but this model can't see images.)";
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: body || "(no output)" });
        if (vision) for (const url of images) parts.push({ type: "image_url", image_url: { url } });
      } else if (b.type === "text") {
        parts.push({ type: "text", text: b.text });
      }
    }
    if (!parts.length) continue;
    const onlyText = parts.every((p) => p.type === "text");
    out.push({
      role: "user",
      content: onlyText ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts,
    });
  }
  return out;
}

function flattenToolResult(block: ToolResult): { text: string; images: string[] } {
  if (typeof block.content === "string") return { text: block.content, images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of block.content ?? []) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "image" && part.source.type === "base64") {
      images.push(`data:${part.source.media_type};base64,${part.source.data}`);
    }
  }
  return { text: texts.join("\n"), images };
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Fails the tool's schema check, so the model is told its arguments were malformed.
    return { INVALID_JSON: raw };
  }
}

type Sink = (kind: "text" | "thinking", part: string) => void;

/**
 * Many local reasoning models (DeepSeek-R1, Qwen3...) put their reasoning inline as
 * <think>...</think>. This separates it from the answer while streaming, even when a tag is
 * split across chunks.
 */
export class ThinkSplitter {
  private buf = "";
  private inThink = false;

  push(chunk: string, sink: Sink): void {
    this.buf += chunk;
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>";
      const at = this.buf.indexOf(tag);
      if (at >= 0) {
        sink(this.inThink ? "thinking" : "text", this.buf.slice(0, at));
        this.buf = this.buf.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a tail that could be the start of a tag.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      sink(this.inThink ? "thinking" : "text", this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }

  flush(sink: Sink): void {
    sink(this.inThink ? "thinking" : "text", this.buf);
    this.buf = "";
  }
}

function isImageRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400 && /image|vision|multimodal/i.test(err.message);
}

/** Set on params by callers that need images to fail loudly instead of answering blind. */
export function strictVision(params: Params): boolean {
  return (params as { strictVision?: boolean }).strictVision === true;
}

/** Thrown instead of silently dropping the image when strictVision is set. */
export class ImageNotSupportedError extends Error {}

function friendlyError(err: unknown, config: OpenAICompatibleConfig, model: string): Error {
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.APIConnectionError) {
    return new Error(`Can't reach ${config.label} at ${config.baseURL}. Is it running?`);
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new Error(
      `${config.label} doesn't have a model called "${model}".` +
        (config.label === "Ollama" ? ` Download it with: ollama pull ${model}` : " Pick another one in the AI menu."),
    );
  }
  if (err instanceof OpenAI.AuthenticationError) return new Error(`${config.label} rejected the API key.`);
  if (err instanceof OpenAI.APIError) return new Error(`${config.label} error ${err.status ?? ""}: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

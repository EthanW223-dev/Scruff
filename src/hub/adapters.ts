import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { z } from "zod";
import { defineTool, type HubTool, type ToolResultContent } from "./tools.ts";

/**
 * Game adapters are small plugins that live inside (or next to) a specific game and give
 * Claude richer powers than memory editing: spawn items, change gravity, run console
 * commands. They connect over WebSocket; see docs/ADAPTERS.md for the protocol.
 */

interface AdapterToolSpec {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface Pending {
  resolve(content: ToolResultContent): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface GameEvent {
  adapter: string;
  text: string;
  at: number;
}

interface Adapter {
  id: number;
  ws: WebSocket;
  name: string;
  prefix: string;
  description: string;
  tools: AdapterToolSpec[];
  pending: Map<string, Pending>;
}

const CALL_TIMEOUT_MS = 30_000;
const MAX_EVENTS = 50;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "adapter";
}

export class AdapterRegistry extends EventEmitter {
  private adapters = new Map<number, Adapter>();
  private nextId = 1;
  private nextCall = 1;
  /** Game events not yet shown to Claude; drained into the next user message. */
  private unseen: GameEvent[] = [];

  handle(ws: WebSocket): void {
    let adapter: Adapter | null = null;

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return ws.send(JSON.stringify({ type: "error", error: "Messages must be JSON." }));
      }

      if (msg.type === "hello") {
        const name = String(msg.name ?? "Unnamed adapter");
        adapter = {
          id: this.nextId++,
          ws,
          name,
          prefix: this.uniquePrefix(slug(String(msg.game ?? name))),
          description: String(msg.description ?? ""),
          tools: sanitizeTools(msg.tools),
          pending: new Map(),
        };
        this.adapters.set(adapter.id, adapter);
        ws.send(JSON.stringify({ type: "welcome", id: adapter.id, prefix: adapter.prefix }));
        this.emit("update");
        return;
      }
      if (!adapter) {
        return ws.send(JSON.stringify({ type: "error", error: 'Send {"type":"hello",...} first.' }));
      }

      switch (msg.type) {
        case "tools":
          adapter.tools = sanitizeTools(msg.tools);
          this.emit("update");
          break;
        case "result": {
          const call = adapter.pending.get(String(msg.id));
          if (!call) break;
          adapter.pending.delete(String(msg.id));
          clearTimeout(call.timer);
          if (msg.ok === false) call.reject(new Error(String(msg.error ?? "Adapter reported an error.")));
          else call.resolve(toContent(msg.content));
          break;
        }
        case "event": {
          const event = { adapter: adapter.name, text: String(msg.text ?? "").slice(0, 500), at: Date.now() };
          this.unseen.push(event);
          if (this.unseen.length > MAX_EVENTS) this.unseen.shift();
          this.emit("event", event);
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!adapter) return;
      for (const call of adapter.pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error(`${adapter.name} disconnected.`));
      }
      this.adapters.delete(adapter.id);
      this.emit("update");
    });
  }

  /**
   * One fixed tool that reaches every adapter. Adapters come and go mid-conversation; keeping
   * the tool list constant keeps the prompt cache (and replayed thinking) valid. What each
   * adapter offers is described to Claude in the status note instead.
   */
  dispatchTool(): HubTool {
    return defineTool({
      name: "use_game_adapter",
      description:
        "Call a tool provided by a connected game adapter (a plugin running inside the game). The available " +
        "adapter tools and their input schemas are listed in the latest [Scruff status] note.",
      input: z.looseObject({
        tool: z.string().describe("Full adapter tool name as listed in the status note, e.g. demo__spawn_coins"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Arguments matching that tool's input schema"),
      }),
      run: ({ tool, input: given, ...rest }, ctx) => {
        // Arguments put next to "tool" instead of inside "input" are taken as the input.
        const input = Object.keys(given).length ? given : rest;
        const sep = tool.indexOf("__");
        const adapter = [...this.adapters.values()].find((a) => a.prefix === tool.slice(0, sep));
        const spec = adapter?.tools.find((t) => t.name === tool.slice(sep + 2));
        if (sep < 0 || !adapter || !spec) {
          const known = this.toolNames();
          throw new Error(
            known.length ? `No adapter tool "${tool}". Available: ${known.join(", ")}.` : "No game adapters are connected.",
          );
        }
        ctx.progress(`${adapter.name}: ${spec.name}…`);
        return this.call(adapter, spec.name, input, ctx.signal);
      },
    });
  }

  /** Status-note text describing what each connected adapter can do. */
  describe(): string {
    if (!this.adapters.size) return "No game adapters connected.";
    return [...this.adapters.values()]
      .map((a) => {
        const tools = a.tools
          .map((t) => `  - ${a.prefix}__${t.name}: ${t.description ?? ""}${t.input_schema ? ` Input schema: ${JSON.stringify(t.input_schema)}` : ""}`)
          .join("\n");
        return `Adapter "${a.name}"${a.description ? ` (${a.description})` : ""} offers:\n${tools || "  (no tools)"}`;
      })
      .join("\n")
      .concat(`\nCall these through use_game_adapter, e.g. {"tool": "${this.toolNames()[0] ?? "game__tool"}", "input": {...}}.`);
  }

  private toolNames(): string[] {
    return [...this.adapters.values()].flatMap((a) => a.tools.map((t) => `${a.prefix}__${t.name}`));
  }

  drainEvents(): GameEvent[] {
    const events = this.unseen;
    this.unseen = [];
    return events;
  }

  state() {
    return [...this.adapters.values()].map((a) => ({
      name: a.name,
      prefix: a.prefix,
      description: a.description,
      tools: a.tools.map((t) => t.name),
    }));
  }

  private call(adapter: Adapter, tool: string, input: unknown, signal: AbortSignal): Promise<ToolResultContent> {
    const id = String(this.nextCall++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        adapter.pending.delete(id);
        reject(new Error(`${adapter.name} didn't answer within ${CALL_TIMEOUT_MS / 1000}s.`));
      }, CALL_TIMEOUT_MS);
      adapter.pending.set(id, { resolve, reject, timer });
      signal.addEventListener(
        "abort",
        () => {
          if (!adapter.pending.delete(id)) return;
          clearTimeout(timer);
          adapter.ws.send(JSON.stringify({ type: "cancel", id }));
          reject(new Error("Cancelled."));
        },
        { once: true },
      );
      adapter.ws.send(JSON.stringify({ type: "call", id, tool, input }));
    });
  }

  private uniquePrefix(base: string): string {
    const taken = new Set([...this.adapters.values()].map((a) => a.prefix));
    let prefix = base;
    for (let n = 2; taken.has(prefix); n++) prefix = `${base}${n}`;
    return prefix;
  }
}

function sanitizeTools(tools: unknown): AdapterToolSpec[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is AdapterToolSpec => typeof t?.name === "string" && /^[a-zA-Z0-9_-]{1,36}$/.test(t.name))
    .map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description.slice(0, 1000) : undefined,
      input_schema: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : undefined,
    }));
}

function toContent(content: unknown): ToolResultContent {
  if (content === undefined || content === null) return "Done.";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

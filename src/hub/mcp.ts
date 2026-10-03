import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { AgentEvent } from "./agent.ts";
import { mcpInstructions } from "./prompt.ts";
import { CHAT_HEADER } from "./providers/claudecode.ts";
import type { HubTool, ToolResultContent } from "./tools.ts";

/**
 * Telos as an MCP server, so a Claude app (Claude Desktop, Claude Code) can be the brain
 * instead of the built-in chat. That's how Telos runs on a Claude Pro/Max subscription: the
 * Claude app does the talking and calls these tools. Exposed over HTTP at /mcp on the hub,
 * and over stdio by src/mcp-stdio.ts for apps that launch servers themselves.
 */

const QUIET_MS = 60_000;

export interface McpOptions {
  tools: HubTool[];
  dashboardUrl: string;
}

/** Emits "event" (AgentEvent) for tool activity, so the dashboard shows it like the built-in chat's. */
export class McpEndpoint extends EventEmitter {
  private nextId = 1;
  private lastActivity = 0;

  constructor(private opts: McpOptions) {
    super();
  }

  private onEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  /** Stateless Streamable HTTP: a fresh server per request, JSON responses. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    // Claude Code running as Telos's own chat brain: its tool calls are part of the chat turn.
    // The Workshop's builder logs its own steps; its calls stay out of the chat.
    const client = req.headers[CHAT_HEADER];
    const server = this.server(client === "1" ? "chat" : client === "workshop" ? "workshop" : "app");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  server(client: "chat" | "workshop" | "app" = "app"): McpServer {
    const server = new McpServer(
      { name: "scruff", version: "0.2.0" },
      { instructions: mcpInstructions(this.opts.dashboardUrl) },
    );
    for (const tool of this.opts.tools) {
      if (!tool.schema) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
          description: tool.description,
          inputSchema: tool.schema,
          annotations: {
            readOnlyHint: Boolean(tool.readOnly),
            // Changes are logged and undoable, never destructive.
            destructiveHint: false,
            openWorldHint: false,
          },
        },
        (args: unknown, extra: { signal: AbortSignal }) => this.call(tool, args, extra.signal, client),
      );
    }
    return server;
  }

  private async call(tool: HubTool, args: unknown, signal: AbortSignal, client: "chat" | "workshop" | "app" = "app"): Promise<CallToolResult> {
    const id = `mcp_${this.nextId++}`;
    const report = client === "workshop" ? () => {} : (event: AgentEvent) => this.onEvent(event);
    if (client === "app") {
      if (Date.now() - this.lastActivity > QUIET_MS) {
        this.onEvent({ type: "notice", text: "Your Claude app is using Telos." });
      }
      this.lastActivity = Date.now();
    }
    report({ type: "tool_call", id, name: tool.name, input: args });
    try {
      const content = await tool.run(args, {
        signal,
        progress: (text) => report({ type: "tool_progress", id, text }),
      });
      const result = toMcpContent(content);
      report({ type: "tool_result", id, ok: true, text: summary(result) });
      return { content: result };
    } catch (err) {
      const text = (err as Error).message;
      report({ type: "tool_result", id, ok: false, text });
      return { content: [{ type: "text", text }], isError: true };
    }
  }
}

function toMcpContent(content: ToolResultContent): CallToolResult["content"] {
  if (!content) return [{ type: "text", text: "Done." }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.type === "image" && block.source.type === "base64") {
      return { type: "image" as const, data: block.source.data, mimeType: block.source.media_type };
    }
    return { type: "text" as const, text: `[${block.type}]` };
  });
}

function summary(content: CallToolResult["content"]): string {
  return content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join(" ")
    .slice(0, 600);
}

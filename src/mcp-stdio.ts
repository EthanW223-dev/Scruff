import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { startScruff } from "./index.ts";

/**
 * Scruff for Claude Desktop (or any MCP client that launches servers over stdio).
 * Claude Desktop runs this when it starts. If the Scruff hub isn't already running, this
 * starts it (dashboard and all) in this process; then it relays MCP messages between the
 * Claude app and the hub's /mcp endpoint. stdout carries only MCP messages.
 */

const port = Number(process.env.SCRUFF_PORT ?? 7777);
const base = `http://127.0.0.1:${port}`;

async function hubRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === "scruff";
  } catch {
    return false;
  }
}

if (!(await hubRunning())) {
  try {
    await startScruff({ quiet: true });
    console.error(`Scruff started. Dashboard: http://localhost:${port}`);
  } catch (err) {
    console.error(`Couldn't start Scruff on port ${port}: ${(err as Error).message}`);
    process.exit(1);
  }
}

const upstream = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
const client = new StdioServerTransport();

client.onmessage = (message: JSONRPCMessage) => {
  upstream.send(message).catch((err: Error) => {
    // Answer requests that couldn't be delivered, so the Claude app doesn't hang.
    if ("id" in message && "method" in message) {
      void client.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `Scruff hub: ${err.message}` } });
    }
  });
};
upstream.onmessage = (message) => void client.send(message);
upstream.onerror = (err) => console.error(`Scruff hub connection: ${err.message}`);
client.onclose = () => process.exit(0);

await upstream.start();
await client.start();

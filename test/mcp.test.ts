import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { createHub } from "../src/hub/create.ts";
import { fakeModel, text } from "./fake-model.ts";

// The "use your Claude subscription" path: a Claude app connects to Telos over MCP and
// drives the same tools. Here a real MCP client plays the Claude app.

const root = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
let hub: Awaited<ReturnType<typeof createHub>>;
let port: number;
let game: ChildProcessWithoutNullStreams;
let gameLines: AsyncIterator<string>;
const clients: Client[] = [];

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");

async function connectHttp(): Promise<Client> {
  const client = new Client({ name: "test-claude-app", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return client;
}

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return p;
}

before(async () => {
  hub = await createHub({
    root,
    port: 0,
    lan: false,
    token: "t",
    brain: { model: "unused", createStream: fakeModel(() => ({ content: [text("unused")] })).factory },
  });
  port = (hub.server.address() as AddressInfo).port;
  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless", "--offline"]);
  gameLines = readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]();
  await gameLines.next();
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  game?.kill();
  hub?.close();
});

test("lists Telos's tools with instructions and read-only hints", async () => {
  const client = await connectHttp();
  assert.match(client.getInstructions() ?? "", /game_status first/);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ["find_value", "write_value", "freeze_value", "undo_change", "look_at_screen", "use_game_adapter"]) {
    assert.ok(names.includes(expected), expected);
  }
  assert.equal(tools.find((t) => t.name === "game_status")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "write_value")?.annotations?.readOnlyHint, false);
});

test("a Claude app can find and change the demo game's gold over MCP, and the dashboard sees it", async () => {
  const dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
  const seen: any[] = [];
  dash.on("message", (raw) => seen.push(JSON.parse(String(raw))));
  await new Promise((r) => dash.once("open", r));

  const client = await connectHttp();
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  const games = JSON.parse(textOf(await call("list_running_games", { search: "the scruff dungeon game" })));
  const pid = games.find((g: { pid: number }) => g.pid === game.pid).pid;
  assert.match(textOf(await call("attach_to_game", { pid })), /Attached/);
  const started = JSON.parse(textOf(await call("find_value", { what: "gold", value: 350 })));
  assert.equal(started.search, "started");
  assert.match(started.next_step, /change the gold in-game/);
  game.stdin.write("spend 50\n");
  await gameLines.next();
  // Same `what`: narrows instead of starting over, even though it's called the same way.
  const refined = JSON.parse(textOf(await call("find_value", { what: "Gold", value: 300 })));
  assert.equal(refined.search, "narrowed");
  assert.match(refined.next_step, /Found it/);
  const addresses = refined.addresses.map((r: { address: string }) => r.address);

  // A stale or made-up address is refused, and the error names the right ones.
  const stale = await call("freeze_value", { address: "0x10", value: 1, label: "Gold" });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), new RegExp(`Current results: ${addresses[0]}`));

  const written = JSON.parse(textOf(await call("write_value", { addresses, value: 4242, label: "Gold" })));
  assert.equal(written.results.find((w: any) => w.type === "int32")?.now, 4242, "type inferred and the write stuck");
  assert.match(written.note, /doesn't prove the game shows it/);

  game.stdin.write("print\n");
  assert.equal(JSON.parse((await gameLines.next()).value).gold, 4242);

  const status = JSON.parse(textOf(await call("game_status")));
  assert.equal(status.attached, true);
  assert.equal(status.screen_shared, false);
  assert.match(status.adapters, /No game adapters/);

  const bad = await call("write_value", { addresses: ["0x1"], type: "int32" });
  assert.equal(bad.isError, true, "invalid input is reported as a tool error");

  const events = seen.filter((m) => m.type === "agent").map((m) => m.event);
  assert.ok(events.some((e) => e.type === "notice" && /Claude app/.test(e.text)));
  assert.ok(events.some((e) => e.type === "tool_call" && e.name === "write_value"));
  dash.close();
});

test("stdio bridge relays to a running hub (the Claude Desktop setup)", async () => {
  const client = new Client({ name: "test-desktop", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, path.join(root, "src", "mcp-stdio.ts")],
      env: { ...process.env, SCRUFF_PORT: String(port) } as Record<string, string>,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "game_status"));
  const status = JSON.parse(textOf(await client.callTool({ name: "game_status", arguments: {} })));
  assert.equal(status.name, "Telos's Dungeon", "same hub, same attached game");
});

test("stdio bridge starts its own hub when none is running", async () => {
  const own = await freePort();
  const client = new Client({ name: "test-desktop", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, path.join(root, "src", "mcp-stdio.ts")],
      env: { ...process.env, SCRUFF_PORT: String(own), OLLAMA_URL: "http://127.0.0.1:9", LMSTUDIO_URL: "http://127.0.0.1:9" } as Record<string, string>,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  const status = JSON.parse(textOf(await client.callTool({ name: "game_status", arguments: {} })));
  assert.equal(status.attached, false);
  const health = await fetch(`http://127.0.0.1:${own}/health`).then((r) => r.json());
  assert.equal(health.app, "scruff", "the dashboard is up too");
});

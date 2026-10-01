import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { createHub } from "../src/hub/create.ts";
import { ModelRouter } from "../src/hub/models.ts";

// A local model (served the way Ollama / LM Studio do: OpenAI-compatible, streamed) drives the
// real hub against the demo game. The fake server streams <think> tags, splits tool-call
// arguments across chunks, and follows a script based on the conversation it's sent.

type Msg = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string };
const requests: { model: string; messages: Msg[]; tools: any[] }[] = [];

function decide(messages: Msg[]): { content?: string; call?: { name: string; args: unknown } } {
  const last = messages.at(-1)!;
  if (last.role === "user") {
    const said = typeof last.content === "string" ? last.content : "";
    if (/325/.test(said)) return { call: { name: "find_value", args: { what: "gold", value: 325 } } };
    return { content: "<think>Find the game first.</think>On it.", call: { name: "list_running_games", args: { search: "dungeon" } } };
  }
  // A tool result: look at which call it answers.
  const assistant = [...messages].reverse().find((m) => m.role === "assistant")!;
  const name = assistant.tool_calls![0].function.name;
  const result = String(last.content);
  switch (name) {
    case "list_running_games":
      // Other test files run their own copy of the demo game at the same time: pick ours.
      return { call: { name: "attach_to_game", args: { pid: JSON.parse(result).find((p: any) => p.pid === game.pid).pid } } };
    case "attach_to_game":
      return { call: { name: "find_value", args: { what: "gold", value: 350 } } };
    case "find_value": {
      const found = JSON.parse(result);
      if (found.search === "started") return { content: "Spend some gold and tell me how much you have." };
      return { call: { name: "write_value", args: { addresses: found.addresses.map((r: any) => r.address), value: 7777, label: "Gold" } } };
    }
    default:
      return { content: "Done! You have 7777 gold." };
  }
}

const fakeOllama = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b", object: "model" }, { id: "nomic-embed-text", object: "model" }] }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const request = JSON.parse(body);
    requests.push(request);
    const { content, call } = decide(request.messages);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (content) for (let i = 0; i < content.length; i += 7) send({ content: content.slice(i, i + 7) });
    if (call) {
      const args = JSON.stringify(call.args);
      const half = Math.floor(args.length / 2);
      send({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: call.name, arguments: args.slice(0, half) } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] });
    }
    // Like some local servers, report "stop" even after a tool call.
    send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
});

let hub: Awaited<ReturnType<typeof createHub>>;
let port: number;
let game: ChildProcessWithoutNullStreams;
let gameLines: AsyncIterator<string>;
let dash: WebSocket;
const inbox: any[] = [];
const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scruff-")), "settings.json");

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function chat(message: string) {
  const start = inbox.length;
  dash.send(JSON.stringify({ type: "chat", text: message }));
  await waitFor(() => inbox.slice(start).some((m) => m.type === "agent" && m.event.type === "turn_end"), "turn end");
  const events = inbox.slice(start).filter((m) => m.type === "agent").map((m) => m.event);
  assert.deepEqual(events.filter((e) => e.type === "error" || (e.type === "tool_result" && !e.ok)), []);
  return events;
}

before(async () => {
  fakeOllama.listen(0, "127.0.0.1");
  await new Promise((r) => fakeOllama.once("listening", r));
  const env = {
    OLLAMA_URL: `http://127.0.0.1:${(fakeOllama.address() as AddressInfo).port}`,
    LMSTUDIO_URL: "http://127.0.0.1:9",
  };
  const router = new ModelRouter(env, settings, "medium");
  await router.init(env);
  hub = await createHub({ root: path.resolve(import.meta.dirname, ".."), port: 0, lan: false, token: "t", router });
  port = (hub.server.address() as AddressInfo).port;

  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless", "--offline"]);
  gameLines = readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]();
  await gameLines.next();

  dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
  dash.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((r) => dash.once("open", r));
});

after(() => {
  dash?.close();
  game?.kill();
  hub?.close();
  fakeOllama.close();
});

test("with no Claude key, Telos picks the local Ollama model on its own", () => {
  const hello = inbox.find((m) => m.type === "hello");
  assert.equal(hello.ai.provider, "ollama");
  assert.equal(hello.ai.model, "qwen3:8b", "embedding models are skipped");
});

test("a local model finds and changes the gold", async () => {
  const first = await chat("give me 7777 gold in the dungeon game");
  assert.deepEqual(first.filter((e) => e.type === "tool_call").map((e) => e.name), ["list_running_games", "attach_to_game", "find_value"]);
  assert.equal(first.filter((e) => e.type === "thinking").map((e) => e.text).join(""), "Find the game first.");
  assert.ok(first.filter((e) => e.type === "text").map((e) => e.text).join("").startsWith("On it."));

  game.stdin.write("spend 25\n");
  await gameLines.next();
  await chat("ok I have 325 now");
  game.stdin.write("print\n");
  assert.equal(JSON.parse((await gameLines.next()).value).gold, 7777);

  // What the local model was sent: system prompt, tools, and tool results as role "tool".
  const lastRequest = requests.at(-1)!;
  assert.equal(lastRequest.model, "qwen3:8b");
  assert.equal(lastRequest.messages[0].role, "system");
  assert.ok(lastRequest.tools.some((t) => t.function.name === "find_value"));
  assert.ok(lastRequest.messages.some((m) => m.role === "tool" && /Attached/.test(m.content)));
});

test("the AI menu lists providers and can switch models", async () => {
  const start = inbox.length;
  dash.send(JSON.stringify({ type: "list_models" }));
  const models = await waitFor(() => inbox.slice(start).find((m) => m.type === "models"), "model list");
  const byId = Object.fromEntries(models.providers.map((p: any) => [p.id, p]));
  assert.equal(byId.ollama.ready, true);
  assert.deepEqual(byId.ollama.models, ["qwen3:8b"]);
  assert.equal(byId.lmstudio.ready, false);
  assert.match(byId.lmstudio.detail, /LM Studio/);
  assert.match(models.connect.claudeCode, /claude mcp add --transport http scruff http:\/\/localhost:\d+\/mcp/);
  assert.match(models.connect.desktopConfig, /mcp-stdio\.ts/);

  dash.send(JSON.stringify({ type: "set_model", provider: "ollama", model: "llama3.1:8b" }));
  await waitFor(() => inbox.slice(start).some((m) => m.type === "hello" && m.ai.model === "llama3.1:8b"), "model switch");
  assert.equal(hub.agent.brain.model, "llama3.1:8b");
  // The settings file also holds voice preferences; this is about the model choice.
  const saved = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual({ provider: saved.provider, model: saved.model }, { provider: "ollama", model: "llama3.1:8b" }, "the choice is remembered");
});

test("a model the server doesn't have gives a helpful error", async () => {
  const start = inbox.length;
  fakeOllama.removeAllListeners("request");
  fakeOllama.on("request", (_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: 'model "llama3.1:8b" not found, try pulling it first' } }));
  });
  dash.send(JSON.stringify({ type: "chat", text: "hello?" }));
  const error = await waitFor(() => inbox.slice(start).find((m) => m.type === "agent" && m.event.type === "error"), "error");
  assert.match(error.event.text, /ollama pull llama3.1:8b/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/hub/agent.ts";
import { createHub } from "../src/hub/create.ts";
import { ModelRouter } from "../src/hub/models.ts";
import { CLAUDE_CODE_MODELS, claudeCodeStreamFactory, explain, probeClaudeCode } from "../src/hub/providers/claudecode.ts";
// @ts-ignore: plain JS test fixture
import { startMockApi } from "./fixtures/claude-code/mock-api.mjs";

// Claude Code as Telos's brain: the player's own `claude` command answers the chat, and
// calls Telos's tools over MCP. A fake `claude` checks how Telos drives it; the real CLI
// (when installed) runs end to end against a stand-in for the Anthropic API.

const root = path.resolve(import.meta.dirname, "..");
const FAKE = path.join(root, "test", "fixtures", "claude-code", "fake-claude.mjs");

/** The fake as a command: the script itself, or a .cmd shim on Windows (like npm's). */
function fakeCommand(dir: string): string {
  if (process.platform !== "win32") return FAKE;
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, `@"${process.execPath}" "${FAKE}" %*\r\n`);
  return shim;
}

function setup(mode = "ok", extraEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-cc-test-"));
  const log = path.join(dir, "calls.jsonl");
  const env = { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extraEnv };
  const opts = { command: fakeCommand(dir), mcpUrl: "http://127.0.0.1:7777/mcp", cwd: path.join(dir, "cc"), env };
  const calls = () =>
    fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string; cwd: string; env: Record<string, string | null> })
      : [];
  return { dir, opts, factory: claudeCodeStreamFactory(opts), calls };
}

const TOOLS = [{ name: "game_status", description: "x", input_schema: { type: "object" } }];
const params = (messages: any[], extra: Record<string, unknown> = {}) =>
  ({ model: "default", max_tokens: 100, system: "Telos", tools: TOOLS, messages, ...extra }) as any;

async function turn(factory: ReturnType<typeof claudeCodeStreamFactory>, p: any, signal = new AbortController().signal) {
  const stream = factory(p, signal);
  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  const message = await stream.finalMessage();
  const text = message.content.map((b: any) => b.text ?? "").join("");
  return { deltas, text, message };
}

const argAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("a chat message runs claude headless with Telos's tools, and its words stream back", async () => {
  const { factory, calls } = setup();
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "[Telos status]\nAttached to Game.exe\n[/Telos status]" }, { type: "text", text: "give me gold" }] },
  ];
  const first = await turn(factory, params(messages));
  assert.equal(first.text, "Hello from a new session.");
  assert.ok(first.deltas.length > 1, "streamed in pieces");
  assert.equal(first.deltas.join(""), first.text, "each word once: the whole message doesn't repeat the stream");
  assert.ok(!first.text.includes("subagent"), "a subagent's messages aren't the reply");

  const [call] = calls();
  for (const flag of ["-p", "--strict-mcp-config", "--include-partial-messages", "--verbose"]) assert.ok(call.args.includes(flag), flag);
  assert.equal(argAfter(call.args, "--output-format"), "stream-json");
  assert.equal(argAfter(call.args, "--input-format"), "stream-json");
  assert.equal(argAfter(call.args, "--allowedTools"), "mcp__telos", "Telos's tools need no prompt");
  assert.match(argAfter(call.args, "--disallowedTools") ?? "", /Bash.*Edit.*Write/, "nothing that acts on the PC from the overlay");
  assert.match(argAfter(call.args, "--append-system-prompt") ?? "", /brain of Telos/);
  assert.ok(!call.args.includes("--model"), "default: Claude Code's own model setting");
  assert.ok(!call.args.includes("--resume"));
  const config = JSON.parse(fs.readFileSync(argAfter(call.args, "--mcp-config")!, "utf8"));
  assert.deepEqual(config.mcpServers.telos, { type: "http", url: "http://127.0.0.1:7777/mcp", headers: { "x-telos-chat": "1" } });
  const input = JSON.parse(call.stdin);
  assert.equal(input.type, "user");
  assert.deepEqual(
    input.message.content.map((b: any) => b.text),
    ["[Telos status]\nAttached to Game.exe\n[/Telos status]", "give me gold"],
    "the message (status note included) goes in on stdin, never on the command line",
  );

  // The next message continues the same Claude Code session.
  messages.push({ role: "assistant", content: first.message.content }, { role: "user", content: "more" });
  const second = await turn(factory, params(messages, { model: "sonnet" }));
  assert.equal(second.text, "Hello from the same session.");
  const [, call2] = calls();
  assert.match(argAfter(call2.args, "--resume") ?? "", /^sess-\d+$/);
  assert.equal(argAfter(call2.args, "--model"), "sonnet");

  // "New chat" hands the brain a fresh history: a fresh session.
  await turn(factory, params([{ role: "user", content: "hi" }]));
  assert.ok(!calls()[2].args.includes("--resume"));
});

test("an older claude without partial messages: the flag is dropped and the reply still arrives once", async () => {
  const { factory, calls } = setup("no-partial");
  const { text, deltas } = await turn(factory, params([{ role: "user", content: "hi" }]));
  assert.equal(text, "Hello from a new session.");
  assert.deepEqual(deltas, ["Hello from a new session."]);
  const all = calls();
  assert.equal(all.length, 2, "one retry");
  assert.ok(!all[1].args.includes("--include-partial-messages"));
});

test("what went wrong is said plainly: not logged in, a wrapper that rejects the options, not installed", async () => {
  await assert.rejects(turn(setup("login").factory, params([{ role: "user", content: "hi" }])), /isn't logged in.*log in/);
  await assert.rejects(
    turn(setup("wrapper").factory, params([{ role: "user", content: "hi" }])),
    (err: Error) => /didn't accept Claude Code's options \(error: unknown option '-p'\)/.test(err.message) && !/starting router/.test(err.message),
  );
  const missing = claudeCodeStreamFactory({ ...setup().opts, command: path.join(os.tmpdir(), "no-such-claude-here") });
  await assert.rejects(turn(missing, params([{ role: "user", content: "hi" }])), /couldn't find Claude Code.*SCRUFF_CLAUDE_COMMAND/);
});

test("only a missing claude reads as 'not installed': a build's own missing tool is its own problem", () => {
  const notFound = /couldn't find Claude Code/;
  assert.match(explain("'claude' is not recognized as an internal or external command,", "claude"), notFound);
  assert.match(explain("sh: 1: claude: not found", "claude"), notFound);
  assert.match(explain("bash: /usr/local/bin/claude: No such file or directory\nENOENT", "/usr/local/bin/claude"), notFound);
  assert.match(explain("'claude.cmd' is not recognized as an internal or external command", "C:\\npm\\claude.cmd"), notFound);
  assert.doesNotMatch(explain("dotnet: command not found", "claude"), notFound);
  assert.match(explain("dotnet: command not found", "claude"), /^Claude Code: dotnet: command not found/);
  assert.doesNotMatch(explain("git: authentication failed for repo", "claude"), /isn't logged in/);
  assert.match(explain("Invalid API key · Please run /login", "claude"), /isn't logged in/);
});

test("a session Claude Code no longer has: carries on in a new one", async () => {
  const { factory, calls } = setup("stale-session");
  const messages: any[] = [{ role: "user", content: "hi" }];
  await turn(factory, params(messages));
  messages.push({ role: "assistant", content: [] }, { role: "user", content: "again" });
  const { text } = await turn(factory, params(messages));
  assert.equal(text, "Hello from a new session.");
  assert.ok(!calls().at(-1)!.args.includes("--resume"));
});

test("Stop ends the run right away", async () => {
  const { factory } = setup("slow");
  const ctrl = new AbortController();
  const started = Date.now();
  const pending = turn(factory, params([{ role: "user", content: "hi" }]), ctrl.signal);
  setTimeout(() => ctrl.abort(), 500);
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  assert.ok(Date.now() - started < 10_000);
});

test("a screenshot question goes in without Telos's tools, image included", async () => {
  const { factory, calls } = setup();
  const p = params(
    [{ role: "user", content: [{ type: "text", text: "What number is shown?" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] }],
    { tools: undefined, system: "You look at game screenshots and answer briefly." },
  );
  await turn(factory, p);
  const [call] = calls();
  assert.ok(!call.args.includes("--mcp-config") && !call.args.includes("--allowedTools"));
  assert.match(argAfter(call.args, "--append-system-prompt") ?? "", /game screenshots/);
  const input = JSON.parse(call.stdin);
  assert.deepEqual(input.message.content[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
});

test("Claude Code doesn't inherit the Claude Code session Telos may have been started from", async () => {
  const { factory, calls } = setup("ok", { CLAUDECODE: "1" });
  await turn(factory, params([{ role: "user", content: "hi" }]));
  assert.equal(calls()[0].env.claudecode, null);
});

test("the AI menu offers Claude Code, ready when the command runs, and keeps Telos's own API key out of it", async () => {
  const { dir, opts } = setup();
  fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=sk-from-telos-env\n");
  const settings = path.join(dir, ".scruff", "settings.json");
  const env = { ...opts.env, SCRUFF_CLAUDE_COMMAND: opts.command, ANTHROPIC_API_KEY: "sk-from-telos-env", OLLAMA_URL: "http://127.0.0.1:9", LMSTUDIO_URL: "http://127.0.0.1:9" };
  const router = new ModelRouter(env, settings, "medium");
  const status = (await router.status()).find((p) => p.id === "claude-code")!;
  assert.equal(status.ready, true);
  assert.match(status.detail, /9\.9\.9 \(Claude Code\)/);
  assert.deepEqual(status.models, CLAUDE_CODE_MODELS);

  router.useHub({ mcpUrl: "http://127.0.0.1:1234/mcp", cwd: path.join(dir, "cc") });
  const brain = router.select({ provider: "claude-code", model: "default" });
  assert.equal(router.describe().providerLabel, "Claude Code");
  assert.equal(router.describe().ready, true);
  const stream = brain.createStream(params([{ role: "user", content: "hi" }]), new AbortController().signal);
  await stream.finalMessage();
  const log = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[0].env.anthropicKey, null, "the key in Telos's .env is for the Claude choice, not the player's Claude Code");
  const config = JSON.parse(fs.readFileSync(log[0].args[log[0].args.indexOf("--mcp-config") + 1], "utf8"));
  assert.equal(config.mcpServers.telos.url, "http://127.0.0.1:1234/mcp", "the hub's own MCP endpoint");

  const gone = await probeClaudeCode(path.join(dir, "nope"), process.env);
  assert.equal(gone.ok, false);
  assert.match(gone.detail, /couldn't find Claude Code/);
});

// ---- the real Claude Code CLI, if this machine has it ----

function realClaude(): boolean {
  try {
    return /Claude Code/.test(execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return p;
}

test("end to end with the real claude: the overlay's chat runs Claude Code, which uses Telos's tools", { skip: !realClaude() && "claude isn't installed here", timeout: 120_000 }, async () => {
  const api = await startMockApi();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-cc-e2e-"));
  const port = await freePort();
  const env = {
    ...process.env,
    // A stand-in API and a throwaway config: no real model, no real account touched.
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: "sk-test-key",
    CLAUDE_CONFIG_DIR: path.join(dataDir, "claude-config"),
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const brain = {
    model: "default",
    createStream: claudeCodeStreamFactory({ command: "claude", mcpUrl: `http://127.0.0.1:${port}/mcp`, cwd: path.join(dataDir, "claude-code"), env }),
  };
  const hub = await createHub({ root, port, lan: false, token: "t", brain, dataDir, jev: null });
  try {
    const events: AgentEvent[] = [];
    const all = (e: AgentEvent) => events.push(e);
    hub.agent.on("event", all);
    const done = new Promise<void>((resolve) => hub.agent.on("event", (e: AgentEvent) => e.type === "turn_end" && resolve()));
    // Tool events from MCP reach the dashboard through the hub's own websocket broadcast; listen there.
    const { default: WebSocket } = await import("ws");
    const dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    const broadcast: any[] = [];
    dash.on("message", (raw) => broadcast.push(JSON.parse(String(raw))));
    await new Promise((r) => dash.once("open", r));

    hub.agent.send("Please check the game.");
    await done;
    dash.close();

    const reply = events.filter((e) => e.type === "text").map((e: any) => e.text).join("");
    assert.match(reply, /Checking\..*Telos says: \{/s, "Claude Code's words, streamed into Telos's chat");
    assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events.filter((e) => e.type === "error")));
    const agentEvents = broadcast.filter((m) => m.type === "agent").map((m) => m.event);
    assert.ok(agentEvents.some((e) => e.type === "tool_call" && e.name === "game_status"), "its tool call shows in the overlay");
    assert.ok(agentEvents.some((e) => e.type === "tool_result" && e.ok && /attached/.test(e.text)));
    assert.ok(!agentEvents.some((e) => e.type === "notice" && /Claude app is using Telos/.test(e.text)), "it's Telos's own chat, not an outside app");
    const sent = api.requests.find((r: any) => r.method === "POST" && r.body.tools);
    const names = sent.body.tools.map((t: any) => t.name);
    assert.ok(names.includes("mcp__telos__find_value"));
    assert.ok(!names.includes("Bash") && !names.includes("Write"), "no shell or file edits from the overlay");
  } finally {
    hub.close();
    api.server.close();
  }
});

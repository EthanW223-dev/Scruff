import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { createHub } from "../src/hub/create.ts";
import { fakeModel, lastToolResult, lastUserText, text, toolUse, type Reply } from "./fake-model.ts";

// The whole hub, end to end: a dashboard client chats, a scripted stand-in for Claude drives the
// real tools, and they find and change the demo game's gold in its actual process memory. The
// demo game is also connected as a game adapter.

const policy = (params: Parameters<typeof lastUserText>[0]): Reply => {
  const said = lastUserText(params);
  if (said !== null) {
    if (/spent/i.test(said)) return { content: [toolUse("find_value", { what: "gold", value: 325 })] };
    if (/spawn/i.test(said)) return { content: [toolUse("use_game_adapter", { tool: "demo__spawn_gold", input: { amount: 1 } })] };
    if (/undo/i.test(said)) return { content: [toolUse("undo_change", {})] };
    return { content: [text("On it."), toolUse("list_running_games", { search: "dungeon" })] };
  }
  const last = lastToolResult(params)!;
  assert.ok(!last.isError, `${last.name} failed: ${last.result}`);
  switch (last.name) {
    case "list_running_games": {
      // Other test files run their own copy of the demo game at the same time: pick ours.
      const ours = JSON.parse(last.result).find((p: { pid: number }) => p.pid === game.pid);
      return { content: [toolUse("attach_to_game", { pid: ours.pid })] };
    }
    case "attach_to_game":
      return { content: [toolUse("find_value", { what: "gold", value: 350 })] };
    case "find_value": {
      const found = JSON.parse(last.result);
      if (found.search === "started") return { content: [text("Found some candidates. Spend a little gold and tell me the new amount.")] };
      // No type given: Telos knows how each result is stored.
      return { content: [toolUse("write_value", { addresses: found.addresses.map((r: any) => r.address), value: 99999, label: "Gold" })] };
    }
    default:
      return { content: [text(`Done: ${last.name}.`)] };
  }
};

const model = fakeModel(policy);
let hub: Awaited<ReturnType<typeof createHub>>;
let port: number;
let game: ChildProcessWithoutNullStreams;
let gameLines: AsyncIterator<string>;
let dash: WebSocket;
const inbox: any[] = [];

async function gameCommand(cmd: string) {
  game.stdin.write(cmd + "\n");
  return JSON.parse((await gameLines.next()).value);
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
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
  const errors = events.filter((e) => e.type === "error" || (e.type === "tool_result" && !e.ok));
  assert.deepEqual(errors, [], "no errors in the turn");
  return events;
}

before(async () => {
  hub = await createHub({
    root: path.resolve(import.meta.dirname, ".."),
    port: 0,
    lan: false,
    token: "test-token",
    brain: { model: "claude-opus-5", createStream: model.factory },
  });
  port = (hub.server.address() as AddressInfo).port;

  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless"], {
    env: { ...process.env, SCRUFF_ADAPTER_URL: `ws://127.0.0.1:${port}/ws/adapter` },
  });
  gameLines = readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]();
  await gameLines.next(); // ready
  await waitFor(() => hub.adapters.state().length === 1, "demo game adapter to connect");

  dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
  dash.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((r) => dash.once("open", r));
});

after(() => {
  dash?.close();
  game?.kill();
  hub?.close();
});

test("serves the dashboard", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Telos<\/title>/);
});

test("chat → scan → refine → write changes the game's gold", async () => {
  const first = await chat("I'm playing the dungeon game, give me 99999 gold");
  const toolNames = first.filter((e) => e.type === "tool_call").map((e) => e.name);
  assert.deepEqual(toolNames, ["list_running_games", "attach_to_game", "find_value"]);
  assert.ok(first.some((e) => e.type === "text" && e.text === "On it."));

  await gameCommand("spend 25");
  await chat("ok I spent some, I have 325 now");

  assert.equal((await gameCommand("print")).gold, 99999);
  // The dashboard's mod list picks up the new value (state pushes are debounced).
  const watch = await waitFor(
    () => inbox.filter((m) => m.type === "state").at(-1)?.game.attached?.watch.find((w: any) => w.label === "Gold"),
    "Gold in the mod list",
  );
  assert.equal(watch.value, 99999);
});

test("game adapters are reachable through use_game_adapter", async () => {
  await chat("spawn me a coin");
  assert.equal((await gameCommand("print")).gold, 100000);
});

test("undo puts back the value from before the change", async () => {
  await chat("undo that");
  assert.equal((await gameCommand("print")).gold, 325);
});

test("history is append-only and the system prompt and tools never change", () => {
  const calls = model.calls;
  assert.ok(calls.length >= 8);
  for (let i = 1; i < calls.length; i++) {
    assert.equal(calls[i].system, calls[0].system);
    assert.deepEqual(calls[i].tools, calls[0].tools);
    const prev = calls[i - 1].messages;
    // Every request extends the previous one (plus the reply it got) without editing it.
    assert.deepEqual(calls[i].messages.slice(0, prev.length), prev);
  }
  // The status note (game + adapters) went along with the first message.
  const firstUser = JSON.stringify(calls[0].messages[0].content);
  assert.match(firstUser, /Telos status/);
  assert.match(firstUser, /demo__spawn_gold/);
});

test("rejects cross-site and DNS-rebinding connections", async () => {
  const attempt = (headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`, { headers });
      ws.on("open", () => (ws.close(), resolve("open")));
      ws.on("error", () => resolve("rejected"));
    });
  assert.equal(await attempt({ Origin: "https://evil.example" }), "rejected");
  assert.equal(await attempt({ Host: `evil.example:${port}` }), "rejected");
  assert.equal(await attempt({ Origin: `http://127.0.0.1:${port}` }), "open");
});

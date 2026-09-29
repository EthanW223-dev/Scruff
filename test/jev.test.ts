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
import { GameManager } from "../src/hub/game.ts";
import { JevClient, JevError, type JevQuestion } from "../src/hub/jev.ts";
import { findNumbers, findPhrases, maxFor, quickPath } from "../src/hub/quick.ts";
import { fakeModel, text } from "./fake-model.ts";

// Jev (TypeSafe's System One model) as Scruff's fast path. A stand-in TypeSafe server speaks the
// documented API (POST /v1/systemone, GET /v1/models); a small rule set plays Jev's part.

type Questions = Record<string, JevQuestion & { criteria: any }>;
type Decide = (state: any, questions: Questions) => Record<string, string | { choice: string; confidence: number } | undefined>;

/** The option whose description (or key) passes the test; "none" otherwise. */
const optionWhere = (q: { criteria: Record<string, unknown> } | undefined, ok: (desc: string) => boolean) =>
  Object.entries(q?.criteria ?? {}).find(([k, d]) => k !== "none" && ok(String(d ?? k)))?.[0] ?? "none";

function mockTypeSafe(decide: Decide) {
  const requests: { auth?: string; body: any }[] = [];
  let failures: number[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const auth = req.headers.authorization;
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (auth !== "Bearer ts-test-key") return reply(401, { detail: "Invalid API key" });
    if (req.method === "GET" && req.url === "/v1/models") return reply(200, { models: [{ name: "jev-latest" }] });
    if (req.method !== "POST" || req.url !== "/v1/systemone") return reply(404, {});
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ auth, body });
    const status = failures.shift();
    if (status === -1) return; // never answers
    if (status) return reply(status, { detail: "busy" });
    // The documented request shape.
    if (!body.model || body.state === undefined || !body.questions) return reply(422, { detail: "missing field" });
    for (const q of Object.values(body.questions) as any[]) {
      if (q.type === "choice" && (Object.keys(q.criteria).length > 255 || !Object.keys(q.criteria).length)) {
        return reply(422, { detail: "bad choice" });
      }
    }
    const picks = decide(body.state, body.questions);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions) as [string, any][]) {
      if (q.type !== "choice") continue;
      const options = Object.keys(q.criteria);
      const pick = picks[id] ?? (options.includes("none") ? "none" : options[0]);
      const { choice, confidence } = typeof pick === "string" ? { choice: pick, confidence: 0.92 } : pick;
      const n = options.length;
      // A distribution with this confidence: (n·p − 1)/(n − 1) = confidence.
      const p = n > 1 ? (confidence * (n - 1) + 1) / n : 1;
      const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? p : (1 - p) / (n - 1)]));
      answers[id] = { type: "choice", choice, probabilities, confidence };
    }
    reply(200, { model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 20 } });
  });
  return {
    requests,
    failNext: (...statuses: number[]) => (failures = statuses),
    async listen() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// ---------- pieces ----------

test("numbers and phrases are pulled out of the message for Jev to choose from", () => {
  assert.deepEqual(findNumbers("I have 5 soup cans, give me 99").map((n) => n.value), [5, 99]);
  assert.deepEqual(findNumbers("ok now it's 4.75").map((n) => n.value), [4.75]);
  assert.deepEqual(findNumbers("set gold to 1,500 or 5k").map((n) => n.value), [1500, 5000]);
  assert.deepEqual(findNumbers("I've got five cans").map((n) => n.value), [5]);
  const msg = "I have 5 soup cans, give me 99";
  assert.ok(findPhrases(msg, findNumbers(msg)).includes("soup cans"));
  assert.ok(findPhrases("set gold to 500", findNumbers("set gold to 500")).includes("gold"));
  assert.ok(findPhrases("lock my health", []).includes("health"));
  assert.equal(maxFor(5), 999);
  assert.equal(maxFor(4500), 99_999);
});

test("the client speaks TypeSafe's API: auth, request shape, retry on overload, key errors", async () => {
  const api = mockTypeSafe((_s, q) => ({ urgent: optionWhere(q.urgent, (d) => d.startsWith("Yes")) }));
  const url = await api.listen();
  try {
    const jev = new JevClient("ts-test-key", { baseUrl: url });
    const questions = { urgent: { type: "choice", instructions: "Is it urgent?", criteria: { yes: "Yes, urgent", no: "No" } } } as const;
    api.failNext(529); // overloaded once: retried
    const result = await jev.ask({ message: "help, now!" }, questions);
    assert.equal(result.answers.urgent.type, "choice");
    assert.equal((result.answers.urgent as any).choice, "yes");
    assert.equal(api.requests.length, 2);
    assert.deepEqual(api.requests[1].body, { state: { message: "help, now!" }, model: "jev-latest", questions });
    assert.deepEqual(await jev.listModels(), ["jev-latest"]);

    const bad = new JevClient("wrong", { baseUrl: url });
    await assert.rejects(bad.ask("x", questions), (err) => err instanceof JevError && err.status === 401);
  } finally {
    api.close();
  }
});

test("with no chat AI, Jev explains what it can do instead of failing", async () => {
  const api = mockTypeSafe(() => ({ intent: "other" }));
  const url = await api.listen();
  try {
    const events: any[] = [];
    const handler = quickPath({
      jev: () => new JevClient("ts-test-key", { baseUrl: url }),
      games: new GameManager(),
      tools: [],
      chatReady: () => false,
    });
    const outcome = await handler("what's a good build for a mage?", (e) => events.push(e), new AbortController().signal);
    assert.equal(outcome.handled, true);
    assert.match(events.find((e) => e.type === "text").text, /needs a chat AI/);
  } finally {
    api.close();
  }
});

// ---------- the whole loop on the demo game ----------

const TITLE = `Scruff's Dungeon QA${process.pid}`;
let api: ReturnType<typeof mockTypeSafe>;
let hub: Awaited<ReturnType<typeof createHub>>;
let game: ChildProcessWithoutNullStreams;
let gameLines: AsyncIterator<string>;
let dash: WebSocket;
const inbox: any[] = [];
let script: Decide;
const brainReplies: string[] = [];
const model = fakeModel(() => ({ content: [text(brainReplies.shift() ?? "ok")] }));

async function gameCommand(cmd: string) {
  game.stdin.write(cmd + "\n");
  return JSON.parse((await gameLines.next()).value);
}

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
  const failed = events.filter((e) => e.type === "error" || (e.type === "tool_result" && !e.ok));
  assert.deepEqual(failed, [], "no errors in the turn");
  if (process.env.SHOW_TURNS) console.log(`> ${message}\n`, events.map((e) => e.type === "text" ? `  ${e.text}` : e.type === "tool_result" ? `  [${e.id}] ${e.text.slice(0, 90).replace(/\s+/g, " ")}` : null).filter(Boolean).join("\n"));
  return { events, reply: events.filter((e) => e.type === "text").map((e) => e.text).join(""), tools: events.filter((e) => e.type === "tool_call").map((e) => e.name) };
}

before(async () => {
  api = mockTypeSafe((state, q) => script(state, q));
  const url = await api.listen();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-jev-"));
  hub = await createHub({
    root: path.resolve(import.meta.dirname, ".."),
    port: 0,
    lan: false,
    token: "t",
    dataDir,
    brain: { model: "claude-opus-5", createStream: model.factory },
    jev: new JevClient("ts-test-key", { baseUrl: url }),
  });
  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless", "--offline"], {
    env: { ...process.env, SCRUFF_DEMO_TITLE: TITLE },
  });
  gameLines = readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]();
  await gameLines.next(); // ready
  const port = (hub.server.address() as AddressInfo).port;
  dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
  dash.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((r) => dash.once("open", r));
});

after(() => {
  dash?.close();
  game?.kill();
  hub?.close();
  api?.close();
});

test("Jev picks the game, finds gold, finishes the job when the player reports the new number, locks and undoes — no chat model", async () => {
  script = (state, q) => {
    const msg: string = state.player_message;
    if (/playing/.test(msg)) return { intent: "pick_game", game: optionWhere(q.game, (d) => d.includes(TITLE)) };
    if (/give me 99999/.test(msg)) {
      return {
        intent: "find_and_change",
        current_number: optionWhere(q.current_number, (d) => d.startsWith("350")),
        wanted_number: optionWhere(q.wanted_number, (d) => d.startsWith("99999")),
        thing: optionWhere(q.thing, (d) => d === "gold"),
      };
    }
    const now = /now I have (\d+)/.exec(msg);
    if (now) return { intent: "report_new_amount", current_number: optionWhere(q.current_number, (d) => d.startsWith(now[1])) };
    if (/^lock/.test(msg)) return { intent: "freeze_known", which_value: optionWhere(q.which_value, (d) => d === "gold") };
    if (/undo everything/.test(msg)) return { intent: "undo_all" };
    return { intent: "other" };
  };

  let turn = await chat("I'm playing the dungeon game");
  assert.deepEqual(turn.tools, ["jev", "attach_to_game"]);
  assert.equal(hub.games.session?.target.pid, game.pid);
  assert.match(turn.reply, /Connected to/);

  turn = await chat("I have 350 gold, give me 99999");
  assert.deepEqual(turn.tools, ["jev", "find_value"]);
  assert.equal(hub.games.session?.searchGoal, 99999, "the goal is remembered");

  // Spend until the search is down to a few places: the reply then says it's set.
  let gold = 350;
  for (let i = 0; i < 3 && !/^Set gold/.test(turn.reply); i++) {
    gold = (await gameCommand("spend 25")).gold;
    turn = await chat(`ok now I have ${gold}`);
  }
  assert.match(turn.reply, /^Set gold to 99,999/);
  assert.equal((await gameCommand("print")).gold, 99999, "the game really has it");

  turn = await chat("lock my gold");
  assert.deepEqual(turn.tools.slice(0, 2), ["jev", "freeze_value"]);
  await gameCommand("spend 25");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await gameCommand("print")).gold, 99999, "held while locked");

  turn = await chat("undo everything");
  assert.deepEqual(turn.tools, ["jev", "revert_all_changes"]);
  assert.equal((await gameCommand("print")).gold, gold, "back to what it was");

  assert.equal(model.calls.length, 0, "the chat model was never needed");
  // Every Jev request stays small: the message, a few facts, typed questions.
  for (const r of api.requests) assert.ok(JSON.stringify(r.body).length < 20_000);
});

test("anything else goes to the chat model, which hears what Jev already did", async () => {
  brainReplies.push("Paris.");
  const turn = await chat("what's the capital of France?");
  assert.equal(turn.reply, "Paris.");
  assert.equal(model.calls.length, 1);
  const sent = JSON.stringify(model.calls[0].messages.at(-1));
  assert.match(sent, /Handled instantly by Scruff's fast path \(Jev\)/);
  assert.match(sent, /undo everything/);
  assert.match(sent, /Set gold to 99,999/);
});

test("when Jev isn't sure, or TypeSafe is down, the chat model takes the message", async () => {
  script = () => ({ intent: { choice: "undo_all", confidence: 0.35 } });
  brainReplies.push("Which change do you mean?");
  let turn = await chat("hmm maybe undo some of it?");
  assert.equal(turn.reply, "Which change do you mean?");
  assert.ok(!turn.tools.includes("revert_all_changes"));

  api.failNext(529, 529, 529);
  brainReplies.push("Sure.");
  turn = await chat("undo everything");
  assert.equal(turn.reply, "Sure.");
  assert.ok(turn.events.some((e) => e.type === "notice" && /Jev returned 529.*chat AI is taking this one/.test(e.text)), "says why");
  assert.equal(hub.jev.info().status, "unreachable", "the AI menu shows it");
  assert.ok(hub.jev.current, "an overload doesn't turn Jev off: the next message tries again");

  api.failNext(-1);
  brainReplies.push("Still here.");
  const started = Date.now();
  turn = await chat("undo everything");
  assert.equal(turn.reply, "Still here.");
  assert.ok(Date.now() - started < 6000, "a hung TypeSafe doesn't hold the chat model up for long");

  // Back to normal: the status recovers on the next good answer.
  script = () => ({ intent: "other" });
  brainReplies.push("ok");
  await chat("hello again");
  assert.equal(hub.jev.info().status, "working");
});

test("keys: a pasted key replaces .env's, TypeSafe checks it, a rejected one isn't kept", async () => {
  const { JevService, JevSettings } = await import("../src/hub/jev.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-jev-key-"));
  const mock = mockTypeSafe(() => ({}));
  const url = await mock.listen();
  try {
    const env = { TYPESAFE_API_KEY: "wrong-env-key", TYPESAFE_BASE_URL: url };
    const service = new JevService(new JevSettings(path.join(dir, "k.json"), env));
    await waitFor(() => service.info().status !== "checking", "key check");
    assert.equal(service.info().status, "rejected", "a bad .env key shows as rejected, not 'on'");
    assert.equal(service.current, null);

    await assert.rejects(service.setKey("also-wrong"), /didn't accept/);
    await service.setKey('  "Bearer ts-test-key" ');
    assert.deepEqual(
      { status: service.info().status, source: service.info().source },
      { status: "working", source: "saved" },
      "the pasted key wins over .env",
    );
    assert.ok(!JSON.stringify(service.info()).includes("ts-test-key"), "the key is never sent back");
    await assert.rejects(service.setKey("paste your key here"), /doesn't look like an API key/);
  } finally {
    mock.close();
  }
});

test("no number: 'give me max health' snapshots memory, narrows by down/same/up, and fills the bar", async () => {
  script = (state, q) => {
    const msg: string = state.player_message;
    if (/max health/.test(msg)) return { intent: "change_no_number", wanted_number: "max", thing: optionWhere(q.thing, (d) => d === "health") };
    if (/went down/.test(msg)) return { intent: "report_direction", direction: "decreased" };
    if (/went up/.test(msg)) return { intent: "report_direction", direction: "increased" };
    if (/same/.test(msg)) return { intent: "report_direction", direction: "unchanged" };
    return { intent: "other" };
  };
  const calls = model.calls.length;
  let turn = await chat("give me max health");
  assert.deepEqual(turn.tools, ["jev", "find_value"]);
  assert.match(turn.reply, /make it go down or up/);
  assert.ok(hub.games.session!.scanner.isSnapshot, "no number: a snapshot");

  // The player plays: takes hits, waits, drinks a potion; tells Scruff only which way it went.
  const moves = ["fight", "wait", "fight", "heal 4", "wait", "fight", "heal 4", "fight", "wait", "heal 4", "fight", "wait"];
  const said: string[] = [];
  for (const move of moves) {
    const before = (await gameCommand("print")).health;
    if (move === "wait") await new Promise((r) => setTimeout(r, 300));
    else await gameCommand(move);
    const after = (await gameCommand("print")).health;
    const report = after < before ? "it went down" : after > before ? "it went up" : "it's the same";
    turn = await chat(report);
    said.push(`${report} → ${turn.reply.slice(0, 40)}`);
    if (/^(Set|Locked) health/.test(turn.reply)) break;
  }
  assert.match(turn.reply, /^Set health to 100 \(my guess at full\)/, said.join("\n"));
  assert.equal((await gameCommand("print")).health, 100, "the game's health bar is full");
  // It's the real thing: when the game changes its health, the found value follows.
  await gameCommand("damage 10");
  const found = hub.games.state().attached!.watch.filter((w) => w.label === "health");
  assert.ok(found.length >= 1 && found.every((w) => w.value === 90), JSON.stringify(found));
  assert.equal(model.calls.length, calls, "no chat model involved");
});

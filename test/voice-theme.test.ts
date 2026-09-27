import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { createHub } from "../src/hub/create.ts";
import { contrast } from "../src/hub/themes.ts";
import { fakeModel, lastToolResult, lastUserText, text, toolUse, type Reply } from "./fake-model.ts";

// Per-game overlay themes and push-to-talk voice, through the real hub.

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-data-"));
// Share one downloaded voice model across test runs.
process.env.SCRUFF_MODELS_DIR ??= path.join(root, ".scruff", "models");

const heard: string[] = [];
const model = fakeModel((p): Reply => {
  const said = lastUserText(p);
  if (said !== null) {
    heard.push(said);
    if (/attach/.test(said)) return { content: [toolUse("list_running_games", { search: "dungeon" })] };
    if (/style/.test(said)) {
      // Deliberately unreadable text color: the hub should fix it.
      return { content: [toolUse("style_overlay", { accent: "#e0a526", background: "#1a1208", text: "#1a1208", font: "fantasy", corner: "bottom-left" })] };
    }
    return { content: [text("ok")] };
  }
  const last = lastToolResult(p)!;
  if (last.name === "list_running_games") return { content: [toolUse("attach_to_game", { pid: JSON.parse(last.result)[0].pid })] };
  return { content: [text("done")] };
});

let hub: Awaited<ReturnType<typeof createHub>>;
let port: number;
let game: ChildProcessWithoutNullStreams;
let dash: WebSocket;
const inbox: any[] = [];

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const lastState = () => inbox.filter((m) => m.type === "state").at(-1);
async function chat(message: string) {
  const start = inbox.length;
  dash.send(JSON.stringify({ type: "chat", text: message }));
  await waitFor(() => inbox.slice(start).some((m) => m.type === "agent" && m.event.type === "turn_end"), "turn end");
}

before(async () => {
  hub = await createHub({ root, dataDir, port: 0, lan: false, token: "t", brain: { model: "fake", createStream: model.factory } });
  port = (hub.server.address() as AddressInfo).port;
  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless", "--offline"]);
  await readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]().next();
  dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
  dash.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((r) => dash.once("open", r));
});

after(() => {
  dash?.close();
  game?.kill();
  hub?.close();
});

test("the default theme applies before any game is attached", async () => {
  const state = await waitFor(lastState, "state");
  assert.equal(state.theme.source, "default");
});

test("a screenshot palette is used for a new game until something is chosen on purpose", async () => {
  await chat("attach to the dungeon game");
  assert.equal(hub.games.session?.target.name, "Scruff's Dungeon");
  dash.send(JSON.stringify({ type: "suggest_theme", theme: { accent: "#3aa0ff", background: "#081018", text: "#e6f0ff" } }));
  await waitFor(() => lastState()?.theme.source === "auto", "auto theme");
  assert.equal(lastState().theme.accent, "#3aa0ff");
});

test("the AI styles the overlay for this game; unreadable colors get fixed; it's saved", async () => {
  await chat("style the overlay to fit this game");
  const theme = await waitFor(() => (lastState()?.theme.source === "ai" ? lastState().theme : null), "ai theme");
  assert.equal(theme.font, "fantasy");
  assert.equal(theme.corner, "bottom-left");
  assert.ok(contrast(theme.text, theme.background) >= 4.5, "text was made readable");
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "themes.json"), "utf8"));
  assert.equal(saved["scruff's dungeon"].accent, "#e0a526");

  // Screenshot suggestions no longer override it.
  dash.send(JSON.stringify({ type: "suggest_theme", theme: { accent: "#00ff00" } }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(lastState().theme.accent, "#e0a526");
});

test("the theme follows the game: default when detached, saved one when attached again", async () => {
  hub.games.detach();
  await waitFor(() => lastState()?.theme.source === "default", "default after detach");
  await hub.games.attach(game.pid!);
  await waitFor(() => lastState()?.theme.source === "ai", "saved theme after re-attach");
});

test("push-to-talk audio is transcribed locally and sent to the AI", { timeout: 300_000 }, async (t) => {
  const wav = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "speech-16k.wav"));
  const start = inbox.length;
  dash.send(JSON.stringify({ type: "voice", pcm: wav.subarray(44).toString("base64") }));
  const outcome = await waitFor(
    () => inbox.slice(start).find((m) => m.type === "transcript" || (m.type === "toast" && m.level === "error")),
    "transcript",
    280_000,
  );
  if (outcome.type === "toast") return t.skip(`voice model unavailable: ${outcome.text}`);
  assert.match(outcome.text.toLowerCase(), /ask not what your country can do for you/);
  await waitFor(() => heard.some((h) => /fellow americans/i.test(h)), "the AI hearing it");
  assert.ok(inbox.slice(start).some((m) => m.type === "voice_status" && m.text === "Transcribing…"));
});

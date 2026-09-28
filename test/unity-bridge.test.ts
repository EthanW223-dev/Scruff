import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createHub } from "../src/hub/create.ts";
import { fakeModel, text } from "./fake-model.ts";

// The Unity bridge's own code (bridge/src: WebSocket client, JSON, reflection) running under Mono
// and connected to a real Scruff hub, with a stand-in game model instead of Unity. Needs Mono
// (apt install mono-mcs mono-runtime); skipped without it.

const root = path.resolve(import.meta.dirname, "..");
const hasMono = (() => {
  try {
    execFileSync("mcs", ["--version"], { stdio: "ignore" });
    execFileSync("mono", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let hub: Awaited<ReturnType<typeof createHub>>;
let game: ChildProcess;
let client: Client;

async function bridge(tool: string, input: Record<string, unknown>) {
  const result = await client.callTool({ name: "use_game_adapter", arguments: { tool: `unity__${tool}`, input } });
  const out = (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
  return { ok: !result.isError, out, json: () => JSON.parse(out) };
}

before(async () => {
  if (!hasMono) return;
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-bridge-test-"));
  const exe = path.join(build, "FakeGame.exe");
  execFileSync("mcs", [
    "-nologo",
    `-out:${exe}`,
    ...["Json.cs", "WebSocketClient.cs", "Reflect.cs"].map((f) => path.join(root, "bridge", "src", f)),
    path.join(root, "test", "fixtures", "bridge", "FakeGame.cs"),
  ]);
  hub = await createHub({
    root,
    port: 0,
    lan: false,
    token: "t",
    dataDir: build,
    brain: { model: "test", createStream: fakeModel(() => ({ content: [text("ok")] })).factory },
    jev: null,
  });
  const port = (hub.server.address() as AddressInfo).port;
  game = spawn("mono", [exe, `ws://127.0.0.1:${port}/ws/adapter`], { stdio: "inherit" });
  for (let i = 0; i < 100 && !hub.adapters.state().some((a) => a.prefix === "unity"); i++) await new Promise((r) => setTimeout(r, 100));
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

after(async () => {
  await client?.close();
  game?.kill();
  hub?.close();
});

test("the bridge connects to Scruff as the 'unity' adapter", { skip: !hasMono && "needs Mono" }, () => {
  assert.deepEqual(
    hub.adapters.state().find((a) => a.prefix === "unity")?.tools,
    ["get", "set", "call", "echo"],
  );
});

test("reads and changes anything: statics, nested, private, auto-properties, list items", { skip: !hasMono && "needs Mono" }, async () => {
  let r = await bridge("set", { type: "GameManager", path: "Instance.money", value: 999 });
  assert.deepEqual(r.json(), { before: 50, after: 999 });
  r = await bridge("set", { type: "GameManager", path: "Instance.player.stats.maxHealth", value: 250 });
  assert.deepEqual(r.json(), { before: 100, after: 250 });
  r = await bridge("set", { type: "GameManager", path: "Instance.player.jumpHeight", value: 10 });
  assert.deepEqual(r.json(), { before: 2, after: 10 }, "private fields too");
  r = await bridge("set", { type: "GameManager", path: "instance.Player.Gold", value: 7 });
  assert.deepEqual(r.json(), { before: 0, after: 7 }, "any case; auto-properties");
  r = await bridge("set", { type: "GameManager", path: "Instance.player.items[1].count", value: 42 });
  assert.deepEqual(r.json(), { before: 1, after: 42 });
  r = await bridge("get", { type: "FakeGame.GameManager", path: "Instance.player.items" });
  assert.deepEqual(r.json().value.items.map((i: any) => i.fields), [{ name: "soup", count: 3 }, { name: "water", count: 42 }]);
});

test("converts values: vectors (written back through structs), colors, enums, text", { skip: !hasMono && "needs Mono" }, async () => {
  let r = await bridge("set", { type: "GameManager", path: "Instance.player.position.y", value: 7.5 });
  assert.deepEqual(r.json().after, 7.5);
  r = await bridge("get", { type: "GameManager", path: "Instance.player.position" });
  assert.deepEqual(r.json().value, { x: 1, y: 7.5, z: 3 }, "the struct was written back");
  r = await bridge("set", { type: "GameManager", path: "Instance.player.position", value: [4, 5, 6] });
  assert.deepEqual(r.json().after, { x: 4, y: 5, z: 6 });
  for (const [value, expected] of [
    ["red", { r: 1, g: 0, b: 0, a: 1 }],
    ["#00ff0080", { r: 0, g: 1, b: 0, a: 0.502 }],
    [[255, 128, 0], { r: 1, g: 0.502, b: 0, a: 1 }],
    [[0.2, 0.4, 0.6, 0.5], { r: 0.2, g: 0.4, b: 0.6, a: 0.5 }],
  ] as const) {
    r = await bridge("set", { type: "GameManager", path: "Instance.player.tint", value });
    assert.deepEqual(r.json().after, expected, JSON.stringify(value));
  }
  r = await bridge("set", { type: "GameManager", path: "Instance.player.mode", value: "fly" });
  assert.deepEqual(r.json(), { before: "Walk", after: "Fly" });
  const motto = "Scruff wuz here ✓ \"quoted\" \\ back\nslash";
  r = await bridge("set", { type: "GameManager", path: "Instance.player.motto", value: motto });
  assert.equal(r.json().after, motto);
});

test("calls the game's own methods", { skip: !hasMono && "needs Mono" }, async () => {
  let r = await bridge("call", { type: "GameManager", path: "Instance.player", method: "AddItem", args: ["soup", 5] });
  assert.deepEqual(r.json(), { result: 8 });
  r = await bridge("call", { type: "GameManager", path: "Instance.player", method: "heal", args: [500] });
  assert.ok(r.ok);
  r = await bridge("get", { type: "GameManager", path: "Instance.player.health" });
  assert.equal(r.json().value, 250, "healed up to the new max health");
});

test("mistakes come back as helpful errors", { skip: !hasMono && "needs Mono" }, async () => {
  let r = await bridge("set", { type: "GameManager", path: "Instance.player.speeed", value: 9 });
  assert.equal(r.ok, false);
  assert.match(r.out, /no "speeed".*Did you mean: speed/);
  r = await bridge("call", { type: "GameManager", path: "Instance.player", method: "AddItems", args: [] });
  assert.match(r.out, /no method "AddItems".*AddItem/);
  r = await bridge("set", { type: "GameManager", path: "Instance.player.mode", value: "teleport" });
  assert.match(r.out, /isn't one of Walk, Fly, Swim/);
  r = await bridge("set", { type: "GameManager", path: "Instance.player.stats.Armor", value: 99 });
  assert.match(r.out, /read-only/);
  r = await bridge("get", { type: "NoSuchClass", path: "x" });
  assert.match(r.out, /No type named "NoSuchClass"/);
});

test("big messages cross in both directions (64-bit WebSocket frame lengths)", { skip: !hasMono && "needs Mono" }, async () => {
  const big = "x".repeat(70_000) + "é";
  const r = await bridge("echo", { text: big });
  assert.equal(r.out, big);
});

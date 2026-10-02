import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AdapterRegistry } from "../src/hub/adapters.ts";
import { connectedBridge } from "../src/hub/bridges.ts";
import { GameManager } from "../src/hub/game.ts";
import { LinkManager, conditionMet, fill, linkTools, numberFrom } from "../src/hub/links.ts";
import type { HubTool } from "../src/hub/tools.ts";
import { GameSession } from "../src/memory/session.ts";
import { decode, encode, type ProcessBackend } from "../src/memory/types.ts";

// Game links: two games connected at once (bridges side by side, memory places that outlive
// attaching to another game), with rules that carry changes from one to the other.

/** A game bridge talking to the registry the way the real ones do, over a fake socket. */
class FakeBridge extends EventEmitter {
  calls: { tool: string; input: Record<string, unknown> }[] = [];
  constructor(
    registry: AdapterRegistry,
    name: string,
    private tools: Record<string, (input: Record<string, unknown>) => unknown>,
  ) {
    super();
    registry.handle(this);
    this.emit(
      "message",
      JSON.stringify({ type: "hello", name, game: "unity", tools: Object.keys(tools).map((n) => ({ name: n })) }),
    );
  }
  send(data: string) {
    const msg = JSON.parse(data);
    if (msg.type !== "call") return;
    this.calls.push({ tool: msg.tool, input: msg.input });
    const content = this.tools[msg.tool](msg.input);
    setImmediate(() => this.emit("message", JSON.stringify({ type: "result", id: msg.id, ok: true, content })));
  }
  event(text: string) {
    this.emit("message", JSON.stringify({ type: "event", text }));
  }
  disconnect() {
    this.emit("close");
  }
}

/** A process's memory: a few int32s and floats at fixed addresses. */
function fakeMemory(pid: number, values: Record<number, number>, type: "int32" | "float" = "int32"): ProcessBackend & { values: Record<number, number> } {
  return {
    pid,
    values,
    regions: () => [],
    read(address, buf) {
      if (!(address in values)) return 0;
      encode(values[address], type).copy(buf);
      return buf.length;
    },
    write(address, buf) {
      if (!(address in values)) return false;
      values[address] = decode(buf, 0, type);
      return true;
    },
    close() {},
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !check(); t += 20) await wait(20);
  assert.ok(check(), "timed out waiting");
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-links-"));
  const adapters = new AdapterRegistry();
  const games = new GameManager();
  const memories = new Map<number, ProcessBackend>();
  const alive = new Set<number>();
  const links = new LinkManager({
    file: path.join(dir, "links.json"),
    adapters,
    games,
    pollMs: 30,
    openBackend: (pid) => memories.get(pid)!,
    processAlive: (pid) => alive.has(pid),
  });
  const tools = Object.fromEntries(linkTools(links, games, adapters).map((t) => [t.name, t])) as Record<string, HubTool>;
  const run = async (name: string, input: unknown) => {
    const out = await tools[name].run(input, { signal: new AbortController().signal, progress() {} });
    return typeof out === "string" ? out : JSON.stringify(out);
  };
  /** Attach Telos to a fake game through memory, with values on its Mods list. */
  const attach = (pid: number, name: string, labels: Record<string, [number, number]>) => {
    const values = Object.fromEntries(Object.values(labels).map(([addr, v]) => [addr, v]));
    const mem = fakeMemory(pid, values);
    memories.set(pid, mem);
    alive.add(pid);
    games.session?.close("detached");
    const session = new GameSession({ pid, name }, mem);
    for (const [label, [addr]] of Object.entries(labels)) session.watchAddress(addr, "int32", label);
    games.session = session;
    games.emit("update");
    return mem;
  };
  return { dir, adapters, games, links, run, attach, alive, memories };
}

test("conditions fire on the change or the crossing, not while a value stays put", () => {
  assert.equal(conditionMet("decreases", 10, 9), true);
  assert.equal(conditionMet("decreases", 9, 10), false);
  assert.equal(conditionMet("increases", 9, 10), true);
  assert.equal(conditionMet("changes", 9, 9), false);
  assert.equal(conditionMet("below", 25, 15, 20), true);
  assert.equal(conditionMet("below", 15, 10, 20), false, "already below: no second fire");
  assert.equal(conditionMet("above", 90, 101, 100), true);
  assert.equal(conditionMet("equals", 1, 0, 0), true);
});

test("placeholders: a lone one stays a number, math works, text gets filled in", () => {
  const f = { value: 40, old: 50, delta: -10, event: "Scene loaded: Bunker" };
  assert.equal(fill("{delta}", f), -10);
  assert.equal(fill("{delta*-2}", f), 20);
  assert.equal(fill("{value + 5}", f), 45);
  assert.deepEqual(fill({ count: "{delta*-1}", note: "was {old}, now {value}", list: ["{event}"] }, f), {
    count: 10,
    note: "was 50, now 40",
    list: ["Scene loaded: Bunker"],
  });
  assert.throws(() => fill("{event}", { value: 1 }), /has no value here/);
});

test("numbers come out of bridge replies in their usual shapes", () => {
  assert.equal(numberFrom("42"), 42);
  assert.equal(numberFrom(JSON.stringify({ path: "Instance.money", value: 12.5 })), 12.5);
  assert.equal(numberFrom(JSON.stringify({ before: 1, after: 7 })), 7);
  assert.equal(numberFrom(JSON.stringify({ value: { value: "3" } })), 3);
  assert.equal(numberFrom("health is 80 now"), 80);
  assert.equal(numberFrom(JSON.stringify({ name: "x" })), null);
});

test("two bridged games at once: health dropping in one spawns enemies in the other", async () => {
  const { adapters, links, run } = setup();
  let health = 100;
  const a = new FakeBridge(adapters, "Unity bridge: 60 Seconds! Reatomized", { get: () => ({ path: "hp", value: health }) });
  const b = new FakeBridge(adapters, "Unity bridge: Dungeon Party", { spawn: () => "spawned", get: () => 0 });
  assert.deepEqual(adapters.state().map((x) => x.prefix), ["unity", "unity2"], "both connected side by side");

  const out = await run("link_games", {
    description: "When I get hurt in 60 Seconds, spawn that many zombies in Dungeon Party",
    when: { game: "60 seconds", tool: "get", input: { type: "Player", path: "hp" }, condition: "decreases" },
    then: [{ game: "unity2", tool: "spawn", input: { id: 7, count: "{delta*-1}" } }],
    cooldown_seconds: 0,
  });
  assert.match(out, /#1/);
  // Stored by name, so it survives the games connecting in a different order next time.
  assert.equal(links.list()[0].then[0].kind === "bridge" && links.list()[0].then[0].game, "Unity bridge: Dungeon Party");

  await until(() => a.calls.length >= 2); // baseline taken
  health = 97;
  await until(() => b.calls.some((c) => c.tool === "spawn"));
  assert.deepEqual(b.calls.find((c) => c.tool === "spawn")!.input, { id: 7, count: 3 });
  health = 99; // healing doesn't fire a "decreases" link
  await wait(150);
  assert.equal(b.calls.filter((c) => c.tool === "spawn").length, 1);
  assert.equal(links.list()[0].fired, 1);
  links.close();
});

test("events from one game's bridge trigger another game", async () => {
  const { adapters, links, run } = setup();
  const a = new FakeBridge(adapters, "Unity bridge: Game A", { get: () => 0 });
  const b = new FakeBridge(adapters, "Unity bridge: Game B", { call: () => "ok" });
  await run("link_games", {
    description: "New level in A gives a bonus in B",
    when: { game: "Game A", event: "scene loaded" },
    then: [{ game: "Game B", tool: "call", input: { type: "Bonus", method: "Give", args: ["{event}"] } }],
  });
  a.event("Scene loaded: Bunker");
  await until(() => b.calls.length === 1);
  assert.deepEqual(b.calls[0].input, { type: "Bonus", method: "Give", args: ["Scene loaded: Bunker"] });
  // Events from other games don't count.
  b.event("Scene loaded: Somewhere");
  await wait(80);
  assert.equal(b.calls.length, 1);
  links.close();
});

test("memory links join a game attached earlier with the one attached now, and mirrored values don't ping-pong", async () => {
  const setupRef = setup();
  const { links, run, attach, alive } = setupRef;
  const memA = attach(1001, "GameA.exe", { money: [0x1000, 50] });
  const memB = attach(2002, "GameB.exe", { coins: [0x2000, 5] }); // Telos moved on to B; A keeps running

  const out = await run("link_games", {
    description: "Money in A goes into coins in B",
    when: { game: "GameA", value: "money", condition: "changes" },
    then: [{ game: "attached", value: "coins", add: "{delta}" }],
    cooldown_seconds: 0,
  });
  assert.match(out, /GameA\.exe and GameB\.exe.*until that game closes/);
  await run("link_games", {
    description: "Coins in B go back into money in A",
    when: { game: "attached", value: "coins" },
    then: [{ game: "GameA.exe", value: "money", add: "{delta}" }],
    cooldown_seconds: 0,
  });

  await wait(150); // both baselines
  memA.values[0x1000] = 60; // +10 in A
  await until(() => memB.values[0x2000] === 15);
  await wait(300);
  assert.equal(memA.values[0x1000], 60, "B's change was the link's own: it didn't echo back into A");
  assert.equal(memB.values[0x2000], 15);
  // B is the attached game: the link's change there shows up in Changes, undoable.
  const { games } = setupRef;
  assert.deepEqual(
    games.session!.changes.map((c) => [c.label, c.before, c.after]),
    [["coins", 5, 15]],
  );

  // The player spends 5 coins in B: A follows.
  memB.values[0x2000] = 10;
  await until(() => memA.values[0x1000] === 55);
  await wait(300);
  assert.equal(memB.values[0x2000], 10);

  // Game A closes: the link says why it stopped instead of writing anywhere.
  alive.delete(1001);
  await until(() => Boolean(links.list()[0].lastError));
  assert.match(links.list()[0].lastError!, /closed.*find money again/);
  links.close();
});

test("links are saved and come back when Telos restarts; pause and remove work", async () => {
  const { dir, adapters, games, links, run } = setup();
  new FakeBridge(adapters, "Unity bridge: Game A", { get: () => 1 });
  new FakeBridge(adapters, "Unity bridge: Game B", { set: () => "ok" });
  await run("link_games", {
    description: "A changes → B set",
    when: { game: "Game A", tool: "get", input: {} },
    then: [{ game: "Game B", tool: "set", input: { path: "x", value: "{value}" } }],
  });
  assert.match(await run("pause_link", { id: 1 }), /Paused/);
  links.close();

  const again = new LinkManager({ file: path.join(dir, "links.json"), adapters, games, pollMs: 1000 });
  assert.equal(again.list().length, 1);
  assert.equal(again.list()[0].enabled, false);
  assert.equal(again.list()[0].description, "A changes → B set");
  assert.match(again.describe(), /#1 \(paused\)/);
  again.remove(1);
  assert.equal(again.list().length, 0);
  again.close();
});

test("helpful errors: unknown games, missing values, a threshold without a number", async () => {
  const { adapters, links, run, attach } = setup();
  new FakeBridge(adapters, "Unity bridge: Game A", { get: () => 1 });
  await assert.rejects(run("link_games", { description: "x", when: { game: "Nope", event: "x" }, then: [{ game: "Game A", tool: "get" }] }), /No connected game called "Nope".*Game A/);
  await assert.rejects(run("link_games", { description: "x", when: { game: "attached", value: "hp" }, then: [{ game: "Game A", tool: "get" }] }), /need Telos attached/);
  attach(3003, "GameC.exe", { health: [0x10, 5] });
  await assert.rejects(run("link_games", { description: "x", when: { game: "attached", value: "hp" }, then: [{ game: "Game A", tool: "get" }] }), /No value called "hp".*health/);
  await assert.rejects(run("link_games", { description: "x", when: { game: "Game A", tool: "get", condition: "below" }, then: [{ game: "Game A", tool: "get" }] }), /needs a threshold/);
  await assert.rejects(run("link_games", { description: "x", when: { game: "Game A", tool: "get" }, then: [{ game: "Game A", tool: "fly" }] }), /no tool "fly".*get/);
  await assert.rejects(run("link_games", { description: "x", when: { game: "GameZ", value: "gold" }, then: [{ game: "Game A", tool: "get" }] }), /hasn't attached to "GameZ".*GameC/);
  links.close();
});

test("the bridge status belongs to the attached game, not any connected game", () => {
  const adapters = new AdapterRegistry();
  const profile = { exe: "C:/Games/60Seconds/60Seconds.exe", installDir: "C:/Games/60Seconds", name: "60 Seconds! Reatomized", engine: "Unity (Mono)", codeFiles: [], codeKind: null, saveDirs: [], configFiles: [], notes: [] };
  new FakeBridge(adapters, "Unity bridge: Dungeon Party", { get: () => 0 });
  assert.equal(connectedBridge(profile, adapters), null, "another Unity game's bridge isn't this game's");
  new FakeBridge(adapters, "Unity bridge: 60 Seconds! Reatomized", { get: () => 0 });
  assert.equal(connectedBridge(profile, adapters), "unity2");
  assert.equal(connectedBridge({ ...profile, engine: "Godot" }, adapters), null);
});

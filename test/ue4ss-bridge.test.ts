import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildProfile, type UserDirs } from "../src/games/profile.ts";
import { installUe4ssBridge, removeUe4ssBridge, ue4ssBridgeState } from "../src/games/ue4ss.ts";
import { createHub } from "../src/hub/create.ts";
import { fakeModel, text } from "./fake-model.ts";

// The Unreal bridge as a UE4SS Lua mod: installing it into a game that has UE4SS (and only
// then), and the real main.lua running under Lua 5.4 with a stand-in for UE4SS, reached through
// Telos's file relay as the "unreal" adapter. Needs lua5.4 for the live part.

const root = path.resolve(import.meta.dirname, "..");
const MOD = path.join(root, "bridge-ue4ss", "TelosBridge");
const hasLua = (() => {
  try {
    execFileSync("lua5.4", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const MODS_TXT = "CheatManagerEnablerMod : 1\r\nConsoleEnablerMod : 0\r\nKeybinds : 1\r\n";

function fakeUnreal(layout: "new" | "old" | "none") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "telos-ue4ss-"));
  const dirs: UserDirs = { home: path.join(tmp, "home"), appData: path.join(tmp, "a"), localAppData: path.join(tmp, "l") };
  const win64 = path.join(tmp, "Lumen", "Lumen", "Binaries", "Win64");
  fs.mkdirSync(win64, { recursive: true });
  const exe = path.join(win64, "Lumen-Win64-Shipping.exe");
  fs.writeFileSync(exe, "");
  let mods = "";
  if (layout !== "none") {
    const ue = layout === "new" ? path.join(win64, "ue4ss") : win64;
    mods = path.join(ue, "Mods");
    fs.mkdirSync(path.join(mods, "Keybinds", "Scripts"), { recursive: true });
    fs.writeFileSync(path.join(ue, "UE4SS.dll"), "");
    fs.writeFileSync(path.join(win64, "dwmapi.dll"), "");
    fs.writeFileSync(path.join(mods, "mods.txt"), MODS_TXT);
  }
  return { tmp, win64, mods, profile: buildProfile(exe, dirs) };
}

test("installs as a UE4SS mod (newer ue4ss/ layout) and comes out exactly", () => {
  const { mods, profile } = fakeUnreal("new");
  assert.equal(profile.engine, "Unreal Engine");
  assert.deepEqual(ue4ssBridgeState(profile), { present: true, installed: false, modsDir: mods });

  const report = installUe4ssBridge(profile, { modSource: MOD });
  assert.equal(report.updated, false);
  assert.equal(fs.readFileSync(path.join(mods, "TelosBridge", "Scripts", "main.lua"), "utf8"), fs.readFileSync(path.join(MOD, "Scripts", "main.lua"), "utf8"));
  assert.ok(fs.existsSync(path.join(mods, "TelosBridge", "relay", ".keep")));
  // Its line goes before Keybinds, keeping the file's Windows line endings; no second way of enabling it.
  assert.equal(fs.readFileSync(path.join(mods, "mods.txt"), "utf8"), "CheatManagerEnablerMod : 1\r\nConsoleEnablerMod : 0\r\nTelosBridge : 1\r\nKeybinds : 1\r\n");
  assert.ok(!fs.existsSync(path.join(mods, "TelosBridge", "enabled.txt")));
  assert.equal(ue4ssBridgeState(profile, path.join(MOD, "Scripts", "main.lua")).installed, true);

  // Again (an update): still one line.
  assert.equal(installUe4ssBridge(profile, { modSource: MOD }).updated, true);
  assert.equal(fs.readFileSync(path.join(mods, "mods.txt"), "utf8").match(/TelosBridge/g)!.length, 1);

  fs.writeFileSync(path.join(mods, "TelosBridge", "Scripts", "main.lua"), "-- older");
  assert.equal(ue4ssBridgeState(profile, path.join(MOD, "Scripts", "main.lua")).outdated, true);

  removeUe4ssBridge(profile);
  assert.equal(fs.readFileSync(path.join(mods, "mods.txt"), "utf8"), MODS_TXT);
  assert.deepEqual(fs.readdirSync(mods).sort(), ["Keybinds", "mods.txt"]);
  assert.throws(() => removeUe4ssBridge(profile), /isn't installed/);
});

test("older UE4SS (files next to the exe) works too; without UE4SS, Telos explains and changes nothing", () => {
  const old = fakeUnreal("old");
  installUe4ssBridge(old.profile, { modSource: MOD });
  assert.ok(fs.existsSync(path.join(old.win64, "Mods", "TelosBridge", "Scripts", "main.lua")));

  const none = fakeUnreal("none");
  const state = ue4ssBridgeState(none.profile);
  assert.equal(state.present, false);
  assert.match(state.reason!, /github\.com\/UE4SS-RE\/RE-UE4SS\/releases.*Binaries\/Win64/);
  assert.throws(() => installUe4ssBridge(none.profile, { modSource: MOD }), /UE4SS isn't in this game yet/);
  assert.deepEqual(fs.readdirSync(none.win64), ["Lumen-Win64-Shipping.exe"]);
});

// ---------------------------------------------------------------- live, through the hub

let lua: ChildProcess | undefined;
let hub: Awaited<ReturnType<typeof createHub>> | undefined;
after(() => {
  lua?.kill();
  hub?.close();
});

test("the mod runs in the game and Telos reaches it as the 'unreal' adapter", { skip: !hasLua && "needs lua5.4" }, async () => {
  const { mods, profile } = fakeUnreal("new");
  installUe4ssBridge(profile, { modSource: MOD });
  const relay = path.join(mods, "TelosBridge", "relay");
  // A request left from an earlier session must not run again when the game starts.
  fs.writeFileSync(path.join(relay, "request.json"), JSON.stringify({ key: "old:1", id: "x", tool: "console", input: { command: "quit" } }));

  lua = spawn("lua5.4", [path.join(root, "test", "fixtures", "ue4ss", "harness.lua"), path.join(mods, "TelosBridge", "Scripts", "main.lua"), "60"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  hub = await createHub({
    root,
    port: 0,
    lan: false,
    token: "t",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "telos-ue4ss-hub-")),
    brain: { model: "test", createStream: fakeModel(() => ({ content: [text("ok")] })).factory },
    jev: null,
  });
  // Attaching to the game is what starts its relay.
  hub.games.profile = profile;
  hub.games.emit("update");
  for (let i = 0; i < 150 && !hub.adapters.find("unreal"); i++) await new Promise((r) => setTimeout(r, 50));
  const adapter = hub.adapters.state().find((a) => a.prefix === "unreal");
  assert.ok(adapter, "connected through the relay");
  assert.equal(adapter!.name, "UE4SS bridge: Lumen");
  assert.deepEqual(adapter!.tools, ["player", "find", "inspect", "get", "set", "call", "teleport", "world", "console"]);
  const state = hub.games.state();
  assert.equal((state.profile!.bridge as { via?: string }).via, "UE4SS");

  const call = async (tool: string, input: Record<string, unknown> = {}) => {
    const out = await hub!.adapters.callTool("unreal", tool, input);
    return JSON.parse(typeof out === "string" ? out : JSON.stringify(out));
  };
  const world = () => fs.readFileSync(path.join(relay, "world.txt"), "utf8");

  const me = await call("player");
  assert.equal(me.pawn.class, "Character");
  assert.deepEqual(me.location, { X: 100, Y: 200, Z: 50 });

  const zombies = await call("find", { name: "zombie" });
  assert.deepEqual(zombies.map((z: { name: string }) => z.name), ["BP_Zombie_C_1", "BP_Zombie_C_2"]);
  const characters = await call("find", { class: "Character" });
  assert.equal(characters.length, 3, "the class's default object is left out");

  const inspected = await call("inspect", { id: me.pawn.id });
  assert.deepEqual(
    inspected.properties.map((p: { name: string; type: string; value: unknown }) => [p.name, p.type, p.value]),
    [["Health", "FloatProperty", 100], ["PlayerName", "StrProperty", "Hero"], ["bHidden", "BoolProperty", false]],
    "its own properties, then inherited ones",
  );

  assert.deepEqual(await call("set", { id: me.pawn.id, property: "Health", value: 999 }), { property: "Health", before: 100, after: 999 });
  assert.deepEqual(await call("get", { id: me.pawn.id, property: "Health" }), { property: "Health", value: 999 });
  await call("call", { id: me.pawn.id, function: "Jump" });
  await call("teleport", { x: 5, y: 6, z: 7 });
  assert.deepEqual(await call("world", { time_dilation: 0.5, gravity_z: -300 }), { time_dilation: 0.5, gravity_z: -300 });
  await call("console", { command: "fov 100" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(world(), "health=999 jumps=1 x=5 dilation=0.5 gravity=-300 set=true console=fov 100", "and the old request never ran");

  await assert.rejects(call("get", { id: 999, property: "Health" }), /No object with id 999.*find again/);
  await assert.rejects(call("call", { id: me.pawn.id, function: "Fly" }), /has no function Fly/);

  // Game events come through the relay (for the AI and game links).
  const seen: string[] = [];
  hub.adapters.on("event", (e: { text: string }) => seen.push(e.text));
  fs.writeFileSync(path.join(relay, "fire-hook"), "");
  for (let i = 0; i < 80 && !seen.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ["Player spawned (new level or respawn)"]);

  // The game quits: the adapter goes away once the mod stops beating.
  fs.writeFileSync(path.join(relay, "stop"), "");
  for (let i = 0; i < 300 && hub.adapters.find("unreal"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.adapters.find("unreal"), null);
});

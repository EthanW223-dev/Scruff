import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildProfile, type UserDirs } from "../src/games/profile.ts";
import {
  installUnrealBridge,
  removeUnrealBridge,
  unrealBridgeState,
} from "../src/games/unreal.ts";

const BRIDGE = path.resolve(import.meta.dirname, "..", "bridge-unreal", "TelosBridgeUE.dll");

function fakeExe(file: string) {
  const buf = Buffer.alloc(0x200);
  buf.write("MZ", 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "latin1");
  buf.writeUInt16LE(0x8664, 0x84);
  fs.writeFileSync(file, buf);
}

function fakeUnreal() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-unreal-"));
  const dirs: UserDirs = { home: path.join(tmp, "home"), appData: path.join(tmp, "a"), localAppData: path.join(tmp, "l") };
  const root = path.join(tmp, "UEGame");
  const exeDir = path.join(root, "Binaries", "Win64");
  fs.mkdirSync(exeDir, { recursive: true });
  fakeExe(path.join(exeDir, "UEGame-Win64-Shipping.exe"));
  return { root, profile: buildProfile(path.join(exeDir, "UEGame-Win64-Shipping.exe"), dirs) };
}

test("Unreal games are detected and start unsupported-but-installable", () => {
  const { profile } = fakeUnreal();
  assert.equal(profile.engine, "Unreal Engine");
  const state = unrealBridgeState(profile);
  assert.equal(state.supported, true);
  assert.equal(state.installed, false);
  assert.match(state.reason!, /unverified/);
});

test("non-Unreal games are refused", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-notunreal-"));
  const dirs: UserDirs = { home: path.join(tmp, "home"), appData: path.join(tmp, "a"), localAppData: path.join(tmp, "l") };
  fs.mkdirSync(tmp, { recursive: true });
  fakeExe(path.join(tmp, "Game.exe"));
  const profile = buildProfile(path.join(tmp, "Game.exe"), dirs);
  assert.equal(unrealBridgeState(profile).supported, false);
  assert.throws(() => installUnrealBridge(profile, { bridgeDll: BRIDGE }), /Unreal/);
});

test("staging writes the DLL, hub URL and loader guide; removal takes it all out", () => {
  const { profile } = fakeUnreal();
  const dir = profile.installDir;
  const report = installUnrealBridge(profile, { bridgeDll: BRIDGE });
  assert.equal(report.bridgeInstalled, true);
  assert.equal(report.arch, "x64");
  const staged = path.join(dir, "TelosBridgeUE");
  assert.ok(fs.existsSync(path.join(staged, "TelosBridgeUE.dll")), "DLL staged");
  assert.match(fs.readFileSync(path.join(staged, "hub.txt"), "utf8"), /ws:\/\/127\.0\.0\.1:\d+\/ws\/adapter/);
  assert.match(fs.readFileSync(path.join(staged, "LOAD-THIS-FIRST.txt"), "utf8"), /inject/i);
  assert.match(report.next, /unverified/);

  const state = unrealBridgeState(profile, BRIDGE);
  assert.equal(state.installed, true);
  assert.equal(state.outdated, undefined);

  const removed = removeUnrealBridge(profile);
  assert.ok(removed.removed.length > 0);
  assert.ok(!fs.existsSync(staged), "staged folder gone");
  assert.ok(!fs.existsSync(path.join(dir, ".scruff-bridge.json")), "manifest gone");
  assert.equal(unrealBridgeState(profile).installed, false);
});

test("an older staged bridge is spotted as outdated", () => {
  const { profile } = fakeUnreal();
  const old = path.join(profile.installDir, "..", "OldUE.dll");
  fs.writeFileSync(old, "ue bridge 1.0");
  installUnrealBridge(profile, { bridgeDll: old });
  assert.equal(unrealBridgeState(profile, BRIDGE).outdated, true);
  assert.equal(unrealBridgeState(profile, old).outdated, undefined);
  removeUnrealBridge(profile);
});

test("refuses to touch a Unity bridge manifest", () => {
  const { profile } = fakeUnreal();
  fs.writeFileSync(
    path.join(profile.installDir, ".scruff-bridge.json"),
    JSON.stringify({ version: 1, installedAt: "x", bridge: "mono", bepinexByScruff: true, files: [], backups: [] }),
  );
  assert.throws(() => installUnrealBridge(profile, { bridgeDll: BRIDGE }), /mono/);
  assert.throws(() => removeUnrealBridge(profile), /mono/);
});

test("a player-installed loader is detected", () => {
  const { profile } = fakeUnreal();
  fs.writeFileSync(path.join(profile.installDir, "dwmapi.dll"), "ue4ss proxy");
  const state = unrealBridgeState(profile);
  assert.equal(state.loader, "dwmapi.dll");
});

test("a loader next to the game's exe (Binaries/Win64, where UE4SS goes) is detected too", () => {
  const { profile } = fakeUnreal();
  fs.writeFileSync(path.join(path.dirname(profile.exe), "dwmapi.dll"), "ue4ss proxy");
  assert.equal(unrealBridgeState(profile).loader, "dwmapi.dll");
});

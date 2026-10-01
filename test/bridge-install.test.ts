import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bridgeState, exeArch, installBridge, removeBridge } from "../src/games/bepinex.ts";
import { buildProfile, type UserDirs } from "../src/games/profile.ts";
import { readZip, writeZip } from "../src/games/zip.ts";

// Installing the Unity bridge into a (fake) Mono Unity game: BepInEx from a download, the
// bridge plugin, and exact removal that leaves the player's own files alone.

const BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "ScruffBridge.dll");

function fakeExe(file: string, machine: number) {
  const buf = Buffer.alloc(0x200);
  buf.write("MZ", 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "latin1");
  buf.writeUInt16LE(machine, 0x84);
  fs.writeFileSync(file, buf);
}

function fakeGame(opts: { il2cpp?: boolean; x86?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-bridge-"));
  const dirs: UserDirs = { home: path.join(tmp, "home"), appData: path.join(tmp, "a"), localAppData: path.join(tmp, "l") };
  const install = path.join(tmp, "Game");
  const data = path.join(install, "Game_Data");
  fs.mkdirSync(path.join(data, "Managed"), { recursive: true });
  fakeExe(path.join(install, "Game.exe"), opts.x86 ? 0x14c : 0x8664);
  fs.writeFileSync(path.join(install, "UnityPlayer.dll"), "");
  if (opts.il2cpp) {
    fs.rmSync(path.join(data, "Managed"), { recursive: true });
    fs.mkdirSync(path.join(data, "il2cpp_data", "Metadata"), { recursive: true });
    fs.writeFileSync(path.join(data, "il2cpp_data", "Metadata", "global-metadata.dat"), "");
  } else {
    fs.writeFileSync(path.join(data, "Managed", "Assembly-CSharp.dll"), "");
  }
  return { install, profile: buildProfile(path.join(install, "Game.exe"), dirs) };
}

const bepinexZip = (arch = "x64") =>
  writeZip({
    "winhttp.dll": `doorstop ${arch}`,
    "doorstop_config.ini": "[General]\nenabled=true\n",
    "changelog.txt": "BepInEx 5",
    "BepInEx/core/BepInEx.dll": "core",
    "BepInEx/core/0Harmony.dll": "harmony",
  });

/** Every file under a folder, relative, sorted. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

test("zip round trip, and the exe's bitness", () => {
  const files = readZip(writeZip({ "a.txt": "hello", "dir/b.bin": Buffer.alloc(100_000, 7) }));
  assert.deepEqual(files.map((f) => f.name), ["a.txt", "dir/b.bin"]);
  assert.equal(files[0].data().toString(), "hello");
  assert.equal(files[1].data().length, 100_000);
  const { profile } = fakeGame({ x86: true });
  assert.equal(exeArch(profile.exe), "x86");
});

test("installs BepInEx and the bridge; removing takes out exactly that and puts the player's file back", async () => {
  const { install, profile } = fakeGame();
  assert.deepEqual(bridgeState(profile), { supported: true, installed: false, existingBepInEx: false });
  const before = tree(install);
  // Something of the player's is where BepInEx goes: it must survive.
  fs.writeFileSync(path.join(install, "doorstop_config.ini"), "players own");
  const zipFile = path.join(install, "..", "bepinex.zip");
  fs.writeFileSync(zipFile, bepinexZip());

  const report = await installBridge(profile, { bridgeDll: BRIDGE, bepinexZip: zipFile, port: 7790 });
  assert.equal(report.installedBepInEx, true);
  assert.match(report.next, /Restart the game/);
  const files = tree(install);
  for (const f of [
    "winhttp.dll",
    "BepInEx/core/BepInEx.dll",
    "BepInEx/plugins/ScruffBridge/ScruffBridge.dll",
    "BepInEx/config/BepInEx.cfg",
    "BepInEx/config/dev.scruff.bridge.cfg",
    ".scruff-bridge.json",
    "doorstop_config.ini.scruff-backup",
  ]) {
    assert.ok(files.includes(f), `${f} installed`);
  }
  assert.ok(fs.readFileSync(path.join(install, "BepInEx/plugins/ScruffBridge/ScruffBridge.dll")).equals(fs.readFileSync(BRIDGE)));
  assert.match(fs.readFileSync(path.join(install, "BepInEx/config/BepInEx.cfg"), "utf8"), /HideManagerGameObject = true/);
  assert.match(fs.readFileSync(path.join(install, "BepInEx/config/dev.scruff.bridge.cfg"), "utf8"), /7790/);
  assert.equal(bridgeState(profile).installed, true);

  // BepInEx writes logs and caches of its own once the game runs.
  fs.mkdirSync(path.join(install, "BepInEx", "cache"), { recursive: true });
  fs.writeFileSync(path.join(install, "BepInEx", "LogOutput.log"), "log");

  const removed = removeBridge(profile);
  assert.equal(removed.keptBepInEx, false);
  assert.equal(removed.restored, 1);
  assert.deepEqual(tree(install), [...before, "doorstop_config.ini"].sort(), "back to how it was");
  assert.equal(fs.readFileSync(path.join(install, "doorstop_config.ini"), "utf8"), "players own");
});

test("a game that already has BepInEx and other mods keeps them", async () => {
  const { install, profile } = fakeGame();
  fs.mkdirSync(path.join(install, "BepInEx", "core"), { recursive: true });
  fs.writeFileSync(path.join(install, "BepInEx", "core", "BepInEx.dll"), "theirs");
  fs.mkdirSync(path.join(install, "BepInEx", "plugins", "SomeoneElsesMod"), { recursive: true });
  fs.writeFileSync(path.join(install, "BepInEx", "plugins", "SomeoneElsesMod", "Mod.dll"), "mod");
  assert.equal(bridgeState(profile).existingBepInEx, true);

  const report = await installBridge(profile, {
    bridgeDll: BRIDGE,
    fetch: () => {
      throw new Error("no download needed");
    },
  });
  assert.equal(report.installedBepInEx, false);
  assert.equal(fs.readFileSync(path.join(install, "BepInEx", "core", "BepInEx.dll"), "utf8"), "theirs");

  const removed = removeBridge(profile);
  assert.equal(removed.keptBepInEx, true);
  assert.ok(!fs.existsSync(path.join(install, "BepInEx", "plugins", "ScruffBridge")));
  assert.ok(fs.existsSync(path.join(install, "BepInEx", "plugins", "SomeoneElsesMod", "Mod.dll")));
  assert.equal(fs.readFileSync(path.join(install, "BepInEx", "core", "BepInEx.dll"), "utf8"), "theirs");
});

test("downloads the newest stable BepInEx 5 for the game's bitness", async () => {
  const { profile } = fakeGame({ x86: true });
  const asked: string[] = [];
  const fakeFetch = (async (url: string) => {
    asked.push(url);
    if (url.includes("api.github.com")) {
      return Response.json([
        { tag_name: "v6.0.0-pre.2", prerelease: true, assets: [{ name: "BepInEx-Unity.Mono-win-x86-6.0.0-pre.2.zip", browser_download_url: "https://x/6.zip" }] },
        {
          tag_name: "v5.4.23.3",
          prerelease: false,
          assets: [
            { name: "BepInEx_win_x64_5.4.23.3.zip", browser_download_url: "https://x/x64.zip" },
            { name: "BepInEx_win_x86_5.4.23.3.zip", browser_download_url: "https://x/x86.zip" },
          ],
        },
      ]);
    }
    return new Response(new Uint8Array(bepinexZip("x86")));
  }) as unknown as typeof fetch;
  const report = await installBridge(profile, { bridgeDll: BRIDGE, fetch: fakeFetch });
  assert.equal(report.bepinexSource, "https://x/x86.zip");
  assert.deepEqual(asked.slice(1), ["https://x/x86.zip"]);
});

test("IL2CPP games are supported: BepInEx 6 IL2CPP zip installs the IL2CPP bridge", async () => {
  const { install, profile } = fakeGame({ il2cpp: true });
  const state = bridgeState(profile);
  assert.equal(state.supported, true);
  assert.equal(state.installed, false);

  const il2cppZip = writeZip({
    "winhttp.dll": "doorstop",
    "BepInEx/core/BepInEx.Unity.IL2CPP.dll": "core6",
    "BepInEx/core/Il2CppInterop.Runtime.dll": "interop",
  });
  const zipFile = path.join(install, "..", "bepinex6.zip");
  fs.writeFileSync(zipFile, il2cppZip);
  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");

  const report = await installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: zipFile });
  assert.equal(report.installedBepInEx, true);
  assert.match(report.next, /bindings/);
  const plugin = path.join(install, "BepInEx", "plugins", "ScruffBridge", "TelosBridge.IL2CPP.dll");
  assert.ok(fs.existsSync(plugin), "IL2CPP bridge plugin installed");
  assert.ok(fs.existsSync(path.join(install, "BepInEx", "core", "BepInEx.Unity.IL2CPP.dll")));
  assert.equal(bridgeState(profile, IL2CPP_BRIDGE).installed, true);
  assert.equal(bridgeState(profile, IL2CPP_BRIDGE).outdated, undefined);

  const removed = removeBridge(profile);
  assert.equal(removed.keptBepInEx, false);
  assert.ok(!fs.existsSync(path.join(install, "BepInEx")));
});

test("IL2CPP picks the BepInEx 6 IL2CPP pre-release from the release list", async () => {
  const { profile } = fakeGame({ il2cpp: true });
  const asked: string[] = [];
  const fakeFetch = (async (url: string) => {
    asked.push(url);
    if (url.includes("api.github.com")) {
      return Response.json([
        { tag_name: "v5.4.23.3", prerelease: false, assets: [{ name: "BepInEx_win_x64_5.4.23.3.zip", browser_download_url: "https://x/5.zip" }] },
        { tag_name: "v6.0.0-pre.2", prerelease: true, assets: [{ name: "BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip", browser_download_url: "https://x/6il2cpp.zip" }] },
      ]);
    }
    return new Response(
      new Uint8Array(
        writeZip({
          "winhttp.dll": "doorstop",
          "BepInEx/core/BepInEx.Unity.IL2CPP.dll": "core6",
        }),
      ),
    );
  }) as unknown as typeof fetch;
  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");
  const report = await installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, fetch: fakeFetch });
  assert.equal(report.bepinexSource, "https://x/6il2cpp.zip");
});

test("a BepInEx 5 zip is refused for IL2CPP games, and the wrong installed core fails loudly", async () => {
  const { install, profile } = fakeGame({ il2cpp: true });
  const five = path.join(install, "..", "bepinex5.zip");
  fs.writeFileSync(five, bepinexZip());
  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");
  await assert.rejects(installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: five }), /BepInEx 6 IL2CPP/);

  // BepInEx 5 already in the game folder: don't install 6 alongside it.
  const { profile: p2 } = fakeGame({ il2cpp: true });
  fs.mkdirSync(path.join(p2.installDir, "BepInEx", "core"), { recursive: true });
  fs.writeFileSync(path.join(p2.installDir, "BepInEx", "core", "BepInEx.dll"), "v5 core");
  await assert.rejects(installBridge(p2, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: five }), /already has BepInEx 5/);
});

test("refuses non-BepInEx downloads and zips that reach outside the game folder", async () => {
  const { install, profile } = fakeGame();
  const bogus = path.join(install, "..", "bogus.zip");
  fs.writeFileSync(bogus, writeZip({ "readme.txt": "not bepinex" }));
  await assert.rejects(installBridge(profile, { bridgeDll: BRIDGE, bepinexZip: bogus }), /doesn't look like a BepInEx/);
  const evil = path.join(install, "..", "evil.zip");
  fs.writeFileSync(evil, writeZip({ "winhttp.dll": "x", "BepInEx/core/BepInEx.dll": "x", "../../outside.dll": "x" }));
  await assert.rejects(installBridge(profile, { bridgeDll: BRIDGE, bepinexZip: evil }), /outside the game folder/);
  assert.ok(!fs.existsSync(path.join(install, "..", "..", "outside.dll")));
  assert.ok(!fs.existsSync(path.join(install, "winhttp.dll")), "nothing written from a bad zip");
});

test("an older installed bridge is spotted and updated once the game has quit", async () => {
  const { GameManager } = await import("../src/hub/game.ts");
  const { install, profile } = fakeGame();
  const old = path.join(install, "..", "OldBridge.dll");
  fs.writeFileSync(old, "bridge 1.0");
  const zipFile = path.join(install, "..", "bepinex.zip");
  fs.writeFileSync(zipFile, bepinexZip());
  await installBridge(profile, { bridgeDll: old, bepinexZip: zipFile });
  assert.equal(bridgeState(profile, BRIDGE).outdated, true, "differs from the bridge Telos ships");
  assert.equal(bridgeState(profile, old).outdated, undefined);

  const games = new GameManager();
  games.profile = profile;
  games.bridgeDll = BRIDGE;
  const notices: string[] = [];
  games.on("notice", (t: string) => notices.push(t));
  assert.equal(await games.updateBridge(1), true);
  assert.match(notices[0], /Updated the Telos bridge/);
  assert.equal(bridgeState(profile, BRIDGE).outdated, undefined);
  assert.ok(fs.readFileSync(path.join(install, "BepInEx/plugins/ScruffBridge/ScruffBridge.dll")).equals(fs.readFileSync(BRIDGE)));
  assert.equal(await games.updateBridge(1), false, "nothing to do when current");
  // Removal still takes everything out: the update didn't lose the record.
  removeBridge(profile);
  assert.ok(!fs.existsSync(path.join(install, "BepInEx")));
  assert.ok(!fs.existsSync(path.join(install, "winhttp.dll")));
});

test("a first install works while the game runs (the bridge loads at the next start)", async () => {
  const { install, profile } = fakeGame();
  const zipFile = path.join(install, "..", "bepinex.zip");
  fs.writeFileSync(zipFile, bepinexZip());
  const report = await installBridge(profile, { bridgeDll: BRIDGE, bepinexZip: zipFile, isRunning: async () => true });
  assert.equal(report.installedBepInEx, true);
  assert.equal(bridgeState(profile).installed, true);
});

test("updating a bridge the running game has loaded is refused up front, without touching files", async () => {
  const { install, profile } = fakeGame();
  const zipFile = path.join(install, "..", "bepinex.zip");
  fs.writeFileSync(zipFile, bepinexZip());
  const old = path.join(install, "..", "OldBridge.dll");
  fs.writeFileSync(old, "bridge 1.0");
  await installBridge(profile, { bridgeDll: old, bepinexZip: zipFile });
  await assert.rejects(
    installBridge(profile, { bridgeDll: BRIDGE, isRunning: async () => true }),
    /running with the bridge loaded.*Quit the game fully/,
  );
  const plugin = path.join(install, "BepInEx", "plugins", "ScruffBridge", "ScruffBridge.dll");
  assert.equal(fs.readFileSync(plugin, "utf8"), "bridge 1.0", "the old one is untouched");
});

test("installs fine when the game is not running", async () => {
  const { install, profile } = fakeGame();
  const zipFile = path.join(install, "..", "bepinex.zip");
  fs.writeFileSync(zipFile, bepinexZip());
  const report = await installBridge(profile, { bridgeDll: BRIDGE, bepinexZip: zipFile, isRunning: async () => false });
  assert.equal(report.installedBepInEx, true);
});

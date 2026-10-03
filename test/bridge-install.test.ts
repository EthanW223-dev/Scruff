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

const BE_PAGE = `<a href="/projects/bepinex_be/787/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.787%2B7cb1246.zip">x64</a>
<a href="/projects/bepinex_be/788/BepInEx-Unity.IL2CPP-win-x86-6.0.0-be.788%2B5b766a3.zip">x86</a>
<a href="/projects/bepinex_be/788/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.788%2B5b766a3.zip">x64</a>
<a href="/projects/bepinex_be/788/BepInEx-Unity.Mono-win-x64-6.0.0-be.788%2B5b766a3.zip">mono</a>`;

/** A BepInEx 6 IL2CPP build as Telos sees it: its version in BepInEx.Core.dll, the metadata range in LibCpp2IL.dll. */
function be6Zip(build: string, maxMetadata: number, extra: Record<string, string> = {}) {
  // .NET stores the message as UTF-16, here at an odd offset like in the real DLL.
  const lib = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x00]), Buffer.from(`Unsupported metadata version found! We support 23-${maxMetadata}, got `, "utf16le")]);
  return writeZip({
    "winhttp.dll": "doorstop",
    "doorstop_config.ini": "[General]\nenabled = true\n",
    "dotnet/coreclr.dll": `coreclr for ${build}`,
    "BepInEx/core/BepInEx.Unity.IL2CPP.dll": "core6",
    "BepInEx/core/BepInEx.Core.dll": `MZ...6.0.0-${build}+abc123...`,
    "BepInEx/core/LibCpp2IL.dll": lib.toString("latin1"),
    ...extra,
  });
}

/** Unity 2022.3+: IL2CPP metadata v31 (global-metadata.dat: magic 0xFAB11BAF, then the version). */
function setMetadataVersion(install: string, version: number) {
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0xfab11baf, 0);
  head.writeInt32LE(version, 4);
  fs.writeFileSync(path.join(install, "Game_Data", "il2cpp_data", "Metadata", "global-metadata.dat"), head);
}

test("IL2CPP takes the newest bleeding-edge BepInEx 6 build for the game's bitness (GitHub's are too old)", async () => {
  const { profile } = fakeGame({ il2cpp: true });
  const asked: string[] = [];
  const fakeFetch = (async (url: string) => {
    asked.push(url);
    if (url === "https://builds.bepinex.dev/projects/bepinex_be") return new Response(BE_PAGE);
    return new Response(new Uint8Array(be6Zip("be.788", 106)));
  }) as unknown as typeof fetch;
  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");
  const report = await installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, fetch: fakeFetch, archOverride: "x64" });
  assert.equal(report.bepinexSource, "https://builds.bepinex.dev/projects/bepinex_be/788/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.788%2B5b766a3.zip");
  assert.ok(!asked.some((u) => u.includes("api.github.com")), "the GitHub releases aren't used for IL2CPP");

  // The build list unreachable: a known-good build.
  const { profile: p2 } = fakeGame({ il2cpp: true, x86: true });
  const offline = (async (url: string) =>
    url.endsWith("bepinex_be") ? new Response("down", { status: 503 }) : new Response(new Uint8Array(be6Zip("be.788", 106)))) as unknown as typeof fetch;
  const r2 = await installBridge(p2, { bridgeDll: IL2CPP_BRIDGE, fetch: offline });
  assert.match(r2.bepinexSource!, /bepinex_be\/788\/BepInEx-Unity\.IL2CPP-win-x86-6\.0\.0-be\.788/);
});

test("an IL2CPP game whose BepInEx is too old for its Unity (metadata v31 vs 23-29) gets BepInEx updated, keeping the player's mods", async () => {
  const { install, profile } = fakeGame({ il2cpp: true });
  setMetadataVersion(install, 31);
  // The player's BepInEx be.697 (as in Schedule I): another mod, their settings, what it generated, and its failed start.
  for (const e of readZip(be6Zip("be.697", 29))) {
    fs.mkdirSync(path.dirname(path.join(install, e.name)), { recursive: true });
    fs.writeFileSync(path.join(install, e.name), e.data());
  }
  const mine = { "BepInEx/plugins/OtherMod.dll": "someone's mod", "BepInEx/config/BepInEx.cfg": "[Logging.Console]\nEnabled = false\n", "BepInEx/interop/Assembly-CSharp.dll": "stale" };
  for (const [file, data] of Object.entries(mine)) {
    fs.mkdirSync(path.dirname(path.join(install, file)), { recursive: true });
    fs.writeFileSync(path.join(install, file), data);
  }
  fs.writeFileSync(path.join(install, "BepInEx", "LogOutput.log"), "[Error  :InteropManager] ... System.FormatException: Unsupported metadata version found! We support 23-29, got 31\n");

  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");
  const before = bridgeState(profile, IL2CPP_BRIDGE);
  assert.deepEqual(before.bepinexTooOld, { build: "be.697", supports: "23-29", needs: 31 });
  assert.match(before.reason!, /be\.697.*metadata v31; it reads 23-29.*won't start/);

  // Not while the game runs (its BepInEx files are locked).
  await assert.rejects(
    installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: "unused", isRunning: async () => true }),
    /is running.*Quit the game fully/,
  );

  const newZip = path.join(install, "..", "be788.zip");
  fs.writeFileSync(newZip, be6Zip("be.788", 106, { "BepInEx/config/BepInEx.cfg": "[Logging.Console]\nEnabled = true\n" }));
  const report = await installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: newZip, archOverride: "x64", isRunning: async () => false });
  assert.deepEqual(report.updatedBepInEx, { from: "be.697", to: "be.788" });
  assert.equal(report.installedBepInEx, false);
  assert.match(report.next, /first start.*minute or two/);

  const read = (f: string) => fs.readFileSync(path.join(install, f), "utf8");
  assert.equal(read("dotnet/coreclr.dll"), "coreclr for be.788", "BepInEx's own files replaced");
  assert.equal(read("BepInEx/plugins/OtherMod.dll"), "someone's mod", "the player's mods stay");
  assert.equal(read("BepInEx/config/BepInEx.cfg"), mine["BepInEx/config/BepInEx.cfg"], "and their settings");
  assert.ok(!fs.existsSync(path.join(install, "BepInEx", "interop")), "the old build's generated files are regenerated");
  assert.ok(!fs.existsSync(path.join(install, "BepInEx", "LogOutput.log")));
  assert.ok(fs.existsSync(path.join(install, "BepInEx", "plugins", "ScruffBridge", "TelosBridge.IL2CPP.dll")));

  const after = bridgeState(profile, IL2CPP_BRIDGE);
  assert.equal(after.bepinexTooOld, undefined);
  assert.equal(after.installed, true);
  assert.equal(after.existingBepInEx, true, "still the player's BepInEx");
  assert.equal(removeBridge(profile).keptBepInEx, true);
  assert.equal(read("BepInEx/plugins/OtherMod.dll"), "someone's mod");
});

test("a BepInEx that already reads the game's metadata is left as it is", async () => {
  const { install, profile } = fakeGame({ il2cpp: true });
  setMetadataVersion(install, 31);
  for (const e of readZip(be6Zip("be.753", 31))) {
    fs.mkdirSync(path.dirname(path.join(install, e.name)), { recursive: true });
    fs.writeFileSync(path.join(install, e.name), e.data());
  }
  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");
  assert.equal(bridgeState(profile, IL2CPP_BRIDGE).bepinexTooOld, undefined);
  const report = await installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: "never-downloaded.zip" });
  assert.equal(report.updatedBepInEx, undefined);
  assert.equal(fs.readFileSync(path.join(install, "dotnet", "coreclr.dll"), "utf8"), "coreclr for be.753");
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

test("a game that runs MelonLoader is left alone: no BepInEx next to it, with the reason", async () => {
  const { install } = fakeGame();
  fs.mkdirSync(path.join(install, "MelonLoader", "net35"), { recursive: true });
  fs.writeFileSync(path.join(install, "MelonLoader", "net35", "MelonLoader.dll"), "ml");
  fs.writeFileSync(path.join(install, "version.dll"), "ml proxy");
  const profile = buildProfile(path.join(install, "Game.exe"), { home: install, appData: install, localAppData: install });
  assert.ok(profile.notes.some((n) => /MelonLoader/.test(n)));

  const state = bridgeState(profile, BRIDGE);
  assert.equal(state.supported, false);
  assert.equal(state.otherLoader, "MelonLoader");
  assert.match(state.reason ?? "", /MelonLoader.*Memory editing/s);

  const before = tree(install);
  await assert.rejects(installBridge(profile, { bridgeDll: BRIDGE, bepinexZip: "unused.zip", archOverride: "x64" }), /already uses MelonLoader/);
  assert.deepEqual(tree(install), before, "nothing was written");

  // An empty leftover MelonLoader folder doesn't count.
  fs.rmSync(path.join(install, "MelonLoader", "net35"), { recursive: true });
  assert.equal(bridgeState(profile, BRIDGE).supported, true);
});

test("an installed bridge that isn't connected says why, from BepInEx's log", async () => {
  const { bridgeLog } = await import("../src/games/bepinex.ts");
  const { install, profile } = fakeGame({ il2cpp: true });
  const IL2CPP_BRIDGE = path.resolve(import.meta.dirname, "..", "bridge", "TelosBridge.IL2CPP.dll");
  const zip = path.join(install, "..", "be6.zip");
  fs.writeFileSync(zip, be6Zip("be.788", 106));
  await installBridge(profile, { bridgeDll: IL2CPP_BRIDGE, bepinexZip: zip });
  const logFile = path.join(install, "BepInEx", "LogOutput.log");
  const said = (log: string | null) => {
    if (log === null) fs.rmSync(logFile, { force: true });
    else fs.writeFileSync(logFile, log);
    return bridgeLog(install);
  };

  assert.equal(said(null).state, "no-log");
  assert.equal(bridgeState(profile, IL2CPP_BRIDGE).log?.state, "no-log", "the dashboard gets it too");

  // What the old bridge did in Schedule I: a Unity call that doesn't exist in IL2CPP games.
  const crash = said(
    "[Message:   BepInEx] Chainloader initialized\n[Info   :   BepInEx] Loading [Scruff Bridge 1.1.0]\n" +
      "[Error  :   BepInEx] Error loading [Scruff Bridge 1.1.0]: System.MissingMethodException: Method not found: 'Void UnityEngine.Events.UnityAction`2..ctor(System.Object, IntPtr)'.\n" +
      "   at ScruffBridge.Runner.Begin(String hubUrl, ManualLogSource log)\n",
  );
  assert.equal(crash.state, "failed");
  assert.match(crash.message, /crashed.*MissingMethodException: Method not found/);

  const failedStart = said("[Error  :Scruff Bridge] Telos bridge failed to start: System.TypeLoadException: Could not load type 'X'\n");
  assert.equal(failedStart.state, "failed");
  assert.match(failedStart.message, /TypeLoadException/);

  const waiting = said("[Info   :Scruff Bridge] Telos bridge 1.2.0 (IL2CPP) started; connecting to ws://127.0.0.1:7777/ws/adapter\n[Info   :Scruff Bridge] Waiting for Telos (Connection refused)\n");
  assert.equal(waiting.state, "waiting");
  assert.match(waiting.message, /can't reach Telos \(Connection refused\).*Keep Telos open/);

  assert.equal(said("[Info   :Scruff Bridge] Waiting for Telos (x)\n[Info   :Scruff Bridge] Connected to Telos.\n").state, "connected");

  const setup = said("[Error  :InteropManager] Failed to generate Il2Cpp interop assemblies: Cpp2IL.Core.Exceptions.LibCpp2ILInitializationException\n");
  assert.equal(setup.state, "setup-failed");
  assert.match(setup.message, /couldn't set itself up.*Failed to generate/);

  assert.match(said("[Message:   BepInEx] Chainloader startup complete\n").message, /didn't load the Telos bridge/);
  assert.match(said("[Message:InteropManager] Running Cpp2IL to generate dummy assemblies\n").message, /still setting up/);
});

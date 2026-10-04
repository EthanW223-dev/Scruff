import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectMinecraft, isJavaExe, isPrivateFile } from "../src/games/minecraft.ts";
import { buildProfile, describeProfile, type UserDirs } from "../src/games/profile.ts";
import { builderTools } from "../src/hub/buildtools.ts";
import { GameManager } from "../src/hub/game.ts";
import { gameFileTools } from "../src/hub/gamefiles.ts";
import { Marketplace, Thunderstore, marketplaceTools } from "../src/hub/marketplace.ts";
import { ModderKnowledge } from "../src/hub/modder.ts";
import { engineModSupport } from "../src/hub/mods.ts";
import { Workshop, type WorkshopJob } from "../src/hub/workshop.ts";
import { splitWindowsCommandLine } from "../src/memory/cmdline.ts";
import { processLaunch } from "../src/memory/platform.ts";
import { checkAttachSafety, onlineGame } from "../src/memory/safety.ts";

// Minecraft: Java Edition runs as the Java runtime (javaw.exe), so its exe's folder is Java's, not
// the game's. Telos knows it by its launch (main class, --gameDir, version) and its window title,
// and points everything at the game directory: worlds, mods, settings. The launcher's sign-in
// file sits in that folder too, and never reaches the AI.

const root = path.resolve(import.meta.dirname, "..");
const PLUGIN = path.join(root, "vendor", "universal-modder");
const FAKE = path.join(root, "test", "fixtures", "claude-code", "fake-claude.mjs");
const ctx = { signal: new AbortController().signal, progress() {} };
const SECRET = "eyJhbGciOiJIUzI1NiJ9.player-session-token";

/** A player's PC: a launcher's Java runtime and a .minecraft with a world, mods and the launcher's files. */
function pc() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "telos-mc-"));
  const dirs: UserDirs = { home: path.join(tmp, "home"), appData: path.join(tmp, "home", "AppData", "Roaming"), localAppData: path.join(tmp, "home", "AppData", "Local") };
  const javaw = path.join(dirs.localAppData, "Packages", "Microsoft.4297127D64EC6", "LocalCache", "Local", "runtime", "java-runtime-delta", "bin", "javaw.exe");
  fs.mkdirSync(path.dirname(javaw), { recursive: true });
  fs.writeFileSync(javaw, "MZ");
  const mc = path.join(dirs.appData, ".minecraft");
  for (const d of ["saves/New World/region", "mods", "config", "versions/fabric-loader-0.16.10-26.3", "versions/26.3", "bin/natives"]) {
    fs.mkdirSync(path.join(mc, d), { recursive: true });
  }
  fs.writeFileSync(path.join(mc, "saves", "New World", "level.dat"), Buffer.from([10, 0, 0, 0]));
  fs.writeFileSync(path.join(mc, "options.txt"), "fov:0.0\nrenderDistance:12\n");
  fs.writeFileSync(path.join(mc, "config", "sodium-options.json"), "{}");
  fs.writeFileSync(path.join(mc, "mods", "fabric-api-0.119.0+26.3.jar"), "PK");
  fs.writeFileSync(path.join(mc, "launcher_profiles.json"), JSON.stringify({ profiles: {} }));
  fs.writeFileSync(path.join(mc, "launcher_accounts_microsoft_store.json"), JSON.stringify({ accounts: { a: { accessToken: SECRET } } }));
  fs.writeFileSync(path.join(mc, "launcher_accounts.json"), JSON.stringify({ accounts: { a: { accessToken: SECRET } } }));
  return { tmp, dirs, javaw, mc };
}

/** The official launcher's command line for a Fabric profile, as Windows reports it. */
function fabricCommandLine(javaw: string, mc: string): string {
  return (
    `"${javaw}" -Xss1M "-Djava.library.path=${path.join(mc, "bin", "natives")}" -Dminecraft.launcher.brand=minecraft-launcher ` +
    `-cp "${path.join(mc, "libraries", "a.jar")}" net.fabricmc.loader.impl.launch.knot.KnotClient --username Steve ` +
    `--version fabric-loader-0.16.10-26.3 --gameDir "${mc}" --assetsDir "${path.join(mc, "assets")}" --assetIndex 29 ` +
    `--uuid 0f3b --accessToken ${SECRET} --clientId x --userType msa --versionType release`
  );
}

test("Minecraft from the official launcher: the game directory, version, Fabric, worlds and settings", () => {
  const { dirs, javaw, mc } = pc();
  const args = splitWindowsCommandLine(fabricCommandLine(javaw, mc));
  const p = buildProfile(javaw, dirs, { title: "Minecraft* 26.3", args });
  assert.equal(p.name, "Minecraft");
  assert.equal(p.engine, "Minecraft (Java)");
  assert.equal(p.exe, javaw, "still the process that runs it");
  assert.equal(p.installDir, mc);
  assert.deepEqual(p.saveDirs, [path.join(mc, "saves")]);
  assert.deepEqual(p.configFiles.sort(), [path.join(mc, "config", "sodium-options.json"), path.join(mc, "options.txt")]);
  assert.equal(p.codeKind, null);
  assert.match(p.notes[0], /Minecraft: Java Edition 26\.3 running Fabric 0\.16\.10: mods go in .*mods \(1 there now\)/);
  assert.match(p.notes.join(" "), /Loader versions installed in the launcher: fabric-loader-0\.16\.10-26\.3/);
  assert.match(p.notes.join(" "), /garbage collection/);
  // The session token in the command line is read past, never kept.
  assert.ok(!JSON.stringify(p).includes(SECRET));
  const described = describeProfile(p);
  assert.match(described, /Game files: Minecraft, Minecraft \(Java\), installed at .*\.minecraft\./);
  assert.match(described, /running Fabric 0\.16\.10/);
  assert.ok(!described.includes(SECRET));
});

test("other launches: the title alone, Prism instances, the folder it runs in, NeoForge and Forge", () => {
  const { tmp, dirs, javaw, mc } = pc();
  // Windows wouldn't give the command line: the title says it's Minecraft, the game is in .minecraft.
  const plain = buildProfile(javaw, dirs, { title: "Minecraft 1.21.4 - Singleplayer" });
  assert.equal(plain.installDir, mc);
  assert.match(plain.notes[0], /Minecraft: Java Edition 1\.21\.4, no mod loader running \(though 1 mod sits in mods\/\)/);

  // Prism Launcher: its own main class, the game's arguments on stdin; natives sit beside the instance's minecraft/.
  const inst = path.join(dirs.appData, "PrismLauncher", "instances", "Fabulously Optimized");
  fs.mkdirSync(path.join(inst, "minecraft", "saves"), { recursive: true });
  fs.mkdirSync(path.join(inst, "natives"), { recursive: true });
  const prism = buildProfile("/usr/lib/jvm/java-21/bin/java", dirs, {
    args: ["/usr/lib/jvm/java-21/bin/java", `-Djava.library.path=${path.join(inst, "natives")}`, "-cp", "NewLaunch.jar", "org.prismlauncher.EntryPoint"],
  });
  assert.equal(prism.engine, "Minecraft (Java)");
  assert.equal(prism.installDir, path.join(inst, "minecraft"));

  // Linux: the folder the game runs in, when nothing else says.
  const cwd = path.join(tmp, "some-instance");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "options.txt"), "");
  const linux = buildProfile("/usr/bin/java", dirs, { args: ["java", "-cp", "client.jar", "net.minecraft.client.main.Main", "--accessToken", SECRET], cwd });
  assert.equal(linux.installDir, cwd);

  const neo = detectMinecraft(javaw, { args: ["cpw.mods.bootstraplauncher.BootstrapLauncher", "--fml.neoForgeVersion", "21.1.77", "--fml.mcVersion", "1.21.1"] }, dirs);
  assert.deepEqual([neo?.loader, neo?.loaderVersion, neo?.version], ["NeoForge", "21.1.77", "1.21.1"]);
  const forge = detectMinecraft(javaw, { args: ["--gameDir", mc, "--version", "1.20.1-forge-47.3.0", "--assetIndex", "5"] }, dirs);
  assert.deepEqual([forge?.loader, forge?.loaderVersion], ["Forge", "47.3.0"]);
  const quilt = detectMinecraft(javaw, { args: ["--gameDir", mc, "--version", "quilt-loader-0.26.4-1.21.1"] }, dirs);
  assert.deepEqual([quilt?.loader, quilt?.loaderVersion, quilt?.version], ["Quilt", "0.26.4", "1.21.1"]);
});

test("only Minecraft: other Java programs, the launcher, Bedrock and ordinary games keep their own profiles", () => {
  const { dirs, javaw } = pc();
  assert.equal(detectMinecraft(javaw, { title: "IntelliJ IDEA", args: ["-cp", "idea.jar", "com.intellij.idea.Main"] }, dirs), null);
  assert.equal(detectMinecraft(javaw, { title: "Minecraft Launcher" }, dirs), null);
  assert.equal(detectMinecraft("C:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe", { title: "Minecraft" }, dirs), null);
  assert.equal(buildProfile(javaw, dirs, { title: "Some Java Game" }).engine, "Unknown");
  assert.ok(isJavaExe("C:\\Program Files\\Java\\bin\\javaw.exe") && isJavaExe("/usr/bin/java") && !isJavaExe("C:\\Games\\javagame.exe"));
});

test("Windows command lines split the way programs see them", () => {
  assert.deepEqual(splitWindowsCommandLine(String.raw`"C:\Program Files\Java\bin\javaw.exe" -Xmx2G "-Djava.library.path=C:\Users\a b\natives" --gameDir "C:\Users\a b\.minecraft"`), [
    String.raw`C:\Program Files\Java\bin\javaw.exe`,
    "-Xmx2G",
    String.raw`-Djava.library.path=C:\Users\a b\natives`,
    "--gameDir",
    String.raw`C:\Users\a b\.minecraft`,
  ]);
  assert.deepEqual(splitWindowsCommandLine(String.raw`a\\b "c\"d" e\\"f g" "" h`), [String.raw`a\\b`, 'c"d', String.raw`e\f g`, "", "h"]);
});

test("the launcher's sign-in files never reach the AI: game file tools, the builder's tools", async () => {
  const { tmp, dirs, javaw, mc } = pc();
  assert.ok(isPrivateFile(String.raw`C:\Users\a\AppData\Roaming\.minecraft\launcher_accounts.json`));
  assert.ok(isPrivateFile(path.join(mc, "launcher_accounts_microsoft_store.json")));
  assert.ok(!isPrivateFile(path.join(mc, "launcher_profiles.json")), "the builder may need the launcher's profiles (a Fabric profile)");

  const games = new GameManager();
  games.profile = buildProfile(javaw, dirs, { args: splitWindowsCommandLine(fabricCommandLine(javaw, mc)) });
  const tools = Object.fromEntries(gameFileTools(games, path.join(tmp, "backups")).map((t) => [t.name, t]));
  const run = async (name: string, input: unknown) => String(await tools[name].run(input, ctx));
  const listing = await run("list_game_files", { where: "install" });
  assert.match(listing, /options\.txt/);
  assert.match(listing, /launcher_profiles\.json/);
  assert.ok(!listing.includes("launcher_accounts"), "not even listed");
  await assert.rejects(run("read_game_file", { path: path.join(mc, "launcher_accounts.json") }), /sign-in file/);
  assert.match(await run("read_game_file", { path: path.join(mc, "options.txt") }), /renderDistance:12/);
  const info = JSON.parse(await run("game_info", {}));
  assert.equal(info.install_dir, mc);
  assert.ok(!JSON.stringify(info).includes(SECRET));

  const build = Object.fromEntries(builderTools({ cwd: mc, roots: [mc], readOnlyRoots: [PLUGIN], env: process.env, pluginDir: PLUGIN }).map((t) => [t.name, t]));
  const b = async (name: string, input: unknown) => String(await build[name].run(input, ctx));
  await assert.rejects(b("read_file", { path: "launcher_accounts.json" }), /sign-in file/);
  await assert.rejects(b("write_file", { path: "launcher_accounts.json", content: "{}" }), /sign-in file/);
  assert.ok(!(await b("search_files", { pattern: "accessToken" })).includes(SECRET), "search skips them too");
});

test("Minecraft single-player is fine; a server or Realm isn't", () => {
  const mc = { pid: 7, name: "javaw.exe" };
  for (const title of ["Minecraft* 26.3", "Minecraft 1.21.4 - Singleplayer", "Minecraft 1.21.4 - Multiplayer (LAN)"]) {
    assert.equal(checkAttachSafety({ ...mc, title }, []).ok, true, title);
  }
  for (const title of ["Minecraft 1.21.4 - Multiplayer (3rd-party Server)", "Minecraft* 1.20.1 - Minecraft Realms"]) {
    const v = checkAttachSafety({ ...mc, title }, []);
    assert.equal(v.ok, false, title);
    assert.match(v.reason!, /single-player worlds/);
  }
  assert.equal(onlineGame("C:\\x\\runtime\\bin\\javaw.exe"), undefined, "the mod builder takes it");
});

test("the chat AI hears what works in Minecraft, the builder gets its playbook, the marketplace points elsewhere", async () => {
  const { dirs, javaw, mc } = pc();
  const profile = buildProfile(javaw, dirs, { args: splitWindowsCommandLine(fabricCommandLine(javaw, mc)) });
  const s = engineModSupport(profile.engine, false);
  assert.equal(s.tier, "minecraft");
  assert.match(s.note, /\/give @s/);
  assert.match(s.note, /build_mod/);
  assert.match(s.note, /rarely stick/);
  assert.equal(new ModderKnowledge(PLUGIN).playbookFor(profile), "minecraft.md");

  // Thunderstore's mods are Unity mods: nothing to search, nothing to install into .minecraft.
  const store = new Thunderstore({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "telos-mc-cache-")), base: "http://127.0.0.1:9" });
  const m = new Marketplace({ store, profile: () => profile, isRunning: async () => false });
  assert.deepEqual(await m.search("minimap"), []);
  assert.match(m.snapshot().error ?? "", /Modrinth or CurseForge/);
  assert.match(m.snapshot().elsewhere ?? "", /Modrinth or CurseForge/, "the Player mods window says so instead of offering the store");
  await assert.rejects(m.install("BepInEx-BepInExPack"), /aren't on Thunderstore/);
  const [find] = marketplaceTools(m, () => profile);
  assert.match(String(await find.run({ query: "minimap" }, ctx)), /Modrinth or CurseForge/);
  assert.ok(!fs.existsSync(path.join(mc, "BepInEx")));
});

test("a Minecraft mod build works in the game directory", async () => {
  const { tmp, dirs, javaw, mc } = pc();
  const profile = buildProfile(javaw, dirs, { title: "Minecraft* 26.3", args: splitWindowsCommandLine(fabricCommandLine(javaw, mc)) });
  const log = path.join(tmp, "calls.jsonl");
  const ws = new Workshop({
    dataDir: tmp,
    pluginDir: PLUGIN,
    mcpUrl: "http://127.0.0.1:7777/mcp",
    home: dirs.home,
    builder: () => ({
      kind: "claude-code",
      label: "Claude Code",
      launch: { command: process.platform === "win32" ? process.execPath : FAKE, env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STEP_MS: "5" } },
    }),
  });
  if (process.platform === "win32") return; // the fake builder runs as a script here
  const job: WorkshopJob = ws.start(profile, "A staff that shoots lightning where you look");
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => job.status !== "running" && (clearInterval(iv), resolve()), 20);
  });
  assert.equal(job.status, "done");
  const [call] = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const dirsGiven = call.args.flatMap((a: string, i: number) => (call.args[i - 1] === "--add-dir" ? [a] : []));
  assert.ok(dirsGiven.includes(mc), `--add-dir ${mc}`);
  assert.ok(!dirsGiven.some((d: string) => d.includes("runtime")), "not the Java runtime's folder");
  assert.match(call.stdin, /Minecraft \(Java\)/);
  assert.match(call.stdin, /running Fabric 0\.16\.10/);
  assert.ok(!call.stdin.includes(SECRET));
});

test("the attached process's own launch: every argument and the folder it runs in (Linux)", { skip: process.platform !== "linux" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-launch-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--gameDir", dir, "--version", "26.3"], { cwd: dir });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const launch = await processLaunch(child.pid!);
    assert.deepEqual(launch.args?.slice(-4), ["--gameDir", dir, "--version", "26.3"]);
    assert.equal(launch.cwd, fs.realpathSync(dir));
  } finally {
    child.kill();
  }
});

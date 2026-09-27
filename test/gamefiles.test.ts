import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { buildProfile, type UserDirs } from "../src/games/profile.ts";
import { GameManager, memoryTools } from "../src/hub/game.ts";
import { gameFileTools } from "../src/hub/gamefiles.ts";
import type { HubTool } from "../src/hub/tools.ts";

// A fake Unity game laid out like 60 Seconds! Reatomized: install folder with app.info and
// Managed/Assembly-CSharp.dll, and a save folder under AppData/LocalLow/<company>/<product>.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-game-"));
const dirs: UserDirs = {
  home: path.join(tmp, "home"),
  appData: path.join(tmp, "home", "AppData", "Roaming"),
  localAppData: path.join(tmp, "home", "AppData", "Local"),
};
const install = path.join(tmp, "Steam", "60 Seconds Reatomized");
const exe = path.join(install, "60Seconds.exe");
const saveDir = path.join(dirs.home, "AppData", "LocalLow", "Robot Gentleman", "60 Seconds! Reatomized");
const saveFile = path.join(saveDir, "save_1.json");

fs.mkdirSync(path.join(install, "60Seconds_Data", "Managed"), { recursive: true });
fs.writeFileSync(exe, "");
fs.writeFileSync(path.join(install, "UnityPlayer.dll"), "");
fs.writeFileSync(path.join(install, "60Seconds_Data", "app.info"), "Robot Gentleman\n60 Seconds! Reatomized\n");
// A real (tiny, MIT-licensed) .NET assembly stands in for the game's code.
fs.copyFileSync(
  path.join(import.meta.dirname, "fixtures", "dotnet", "Microsoft.Bcl.HashCode.dll"),
  path.join(install, "60Seconds_Data", "Managed", "Assembly-CSharp.dll"),
);
fs.mkdirSync(saveDir, { recursive: true });
fs.writeFileSync(saveFile, JSON.stringify({ day: 12, soup: 4.75, water: 3 }, null, 2));

let game: ChildProcessWithoutNullStreams;
const games = new GameManager();
let tools: Record<string, HubTool>;
const call = async (name: string, input: unknown = {}) => {
  const out = await tools[name].run(input, { signal: new AbortController().signal, progress() {} });
  return typeof out === "string" ? out : JSON.stringify(out);
};

before(async () => {
  // A real session (the demo game), with the fake install standing in for its files.
  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless", "--offline"]);
  await readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]().next();
  await games.attach(game.pid!);
  games.profile = buildProfile(exe, dirs);
  tools = Object.fromEntries([...memoryTools(games), ...gameFileTools(games, path.join(tmp, "backups"))].map((t) => [t.name, t]));
});

after(() => {
  games.detach();
  game?.kill();
});

test("picking a game reads its files: engine, real name, save folder", () => {
  const p = games.profile!;
  assert.equal(p.engine, "Unity (Mono)");
  assert.equal(p.name, "60 Seconds! Reatomized");
  assert.equal(p.codeKind, "dotnet");
  assert.deepEqual(p.saveDirs, [saveDir]);
  assert.ok(p.notes.some((n) => n.includes("HKEY_CURRENT_USER\\Software\\Robot Gentleman")));
});

test("search_game_code shows the game's variables and how to scan them", async () => {
  const out = JSON.parse(await call("search_game_code", { query: "length" }));
  assert.deepEqual(out.matches[0], { field: "System.HashCode._length", type: "uint", scan_as: "int32" });
  assert.match(await call("search_game_code", { query: "soup" }), /No variables mention "soup"/);
});

test("saves can be listed, read, edited with a backup, and the edit undone", async () => {
  const listed = JSON.parse(await call("list_game_files", { where: "saves" }));
  assert.equal(listed[0].path, saveFile);
  assert.match(await call("read_game_file", { path: saveFile }), /"soup": 4.75/);

  const edited = await call("edit_game_file", { path: saveFile, find: '"soup": 4.75', replace: '"soup": 99', label: "Soup cans" });
  assert.match(edited, /Backup:/);
  assert.equal(JSON.parse(fs.readFileSync(saveFile, "utf8")).soup, 99);
  const change = games.session!.changes.at(-1)!;
  assert.equal(change.file?.path, saveFile);

  assert.match(await call("undo_change", {}), /Restored .*save_1.json from its backup/);
  assert.equal(JSON.parse(fs.readFileSync(saveFile, "utf8")).soup, 4.75);
});

test("files outside the game's folders are off limits", async () => {
  await assert.rejects(() => call("read_game_file", { path: "/etc/passwd" }), /outside the game's/);
  await assert.rejects(() => call("read_game_file", { path: path.join(install, "..", "..", "secret.txt") }), /outside the game's/);
  await assert.rejects(() => call("edit_game_file", { path: saveFile, find: "not there", replace: "x" }), /isn't in the file/);
});

test("Unreal games: project name, root folder and Saved/ locations", () => {
  const root = path.join(tmp, "Epic", "Cool Game");
  const ueExe = path.join(root, "CoolGame", "Binaries", "Win64", "CoolGame-Win64-Shipping.exe");
  fs.mkdirSync(path.dirname(ueExe), { recursive: true });
  fs.writeFileSync(ueExe, "");
  const saves = path.join(dirs.localAppData, "CoolGame", "Saved", "SaveGames");
  fs.mkdirSync(saves, { recursive: true });
  const p = buildProfile(ueExe, dirs);
  assert.equal(p.engine, "Unreal Engine");
  assert.equal(p.name, "CoolGame");
  assert.equal(p.installDir, root);
  assert.deepEqual(p.saveDirs, [saves]);
});

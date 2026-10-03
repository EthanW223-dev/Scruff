import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { buildProfile } from "../src/games/profile.ts";
import { writeZip } from "../src/games/zip.ts";
import { createHub } from "../src/hub/create.ts";
import { LoaderConflict, Marketplace, Thunderstore, gameLoader, marketplaceTools, parseDependency, placeFiles, readMods } from "../src/hub/marketplace.ts";

// The mod marketplace: other players' mods from Thunderstore, added with everything they need.
// A stand-in Thunderstore serves a recorded listing (Schedule I's, trimmed) and small packages
// laid out like the real ones (MelonLoader, a MelonLoader mod, BepInExPack, BepInEx mods).

const ctx = { signal: new AbortController().signal, progress() {} };
const LISTING = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "thunderstore", "schedule-i-listing.json"), "utf8"));

const meta = (name: string, deps: string[] = []) => ({ "manifest.json": JSON.stringify({ name, version_number: "1.0.0", dependencies: deps }), "icon.png": "png", "README.md": "readme" });
const PACKAGES: Record<string, { version: string; deps: string[]; files: Record<string, string> }> = {
  "LavaGang-MelonLoader": { version: "0.7.0", deps: [], files: { "version.dll": "ml proxy", "MelonLoader/net35/MelonLoader.dll": "ml core" } },
  "DazUki-LaundryApp": { version: "1.1.8", deps: ["LavaGang-MelonLoader-0.7.0"], files: { "Mods/LaundryApp.dll": "laundry", "CHANGELOG.md": "log" } },
  "BepInEx-BepInExPack": {
    version: "5.4.2100",
    deps: [],
    files: {
      "BepInExPack/winhttp.dll": "doorstop",
      "BepInExPack/doorstop_config.ini": "[General]",
      "BepInExPack/BepInEx/core/BepInEx.dll": "bepinex 5",
      "BepInExPack/BepInEx/config/BepInEx.cfg": "pack config",
    },
  },
  "notnotnotswipez-MoreCompany": { version: "1.14.0", deps: ["BepInEx-BepInExPack-5.4.2100"], files: { "BepInEx/plugins/MoreCompany.dll": "more company" } },
  "Tester-Lib": { version: "2.0.0", deps: ["BepInEx-BepInExPack-5.4.2100"], files: { "plugins/Lib.dll": "lib", "config/Lib.cfg": "lib config" } },
  "Tester-UsesLib": { version: "1.0.0", deps: ["Tester-Lib-2.0.0"], files: { "UsesLib.dll": "uses lib", "assets/sprite.png": "sprite" } },
  "Tester-Evil": { version: "1.0.0", deps: ["BepInEx-BepInExPack-5.4.2100"], files: { "plugins/../../../escape.dll": "evil" } },
};

let server: http.Server;
let base: string;
const downloads: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (url.pathname === "/api/experimental/community/") {
      return send({
        pagination: { next_link: null },
        results: [
          { identifier: "lethal-company", name: "Lethal Company" },
          { identifier: "schedule-i", name: "Schedule I" },
        ],
      });
    }
    let m = /^\/api\/cyberstorm\/listing\/([^/]+)\/$/.exec(url.pathname);
    if (m) {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const results = LISTING.results.filter((r: any) => !q || `${r.name} ${r.description}`.toLowerCase().includes(q));
      return send({ count: results.length, next: null, previous: null, results });
    }
    m = /^\/api\/experimental\/package\/([^/]+)\/([^/]+)\/(?:([^/]+)\/)?$/.exec(url.pathname);
    if (m) {
      const id = `${m[1]}-${m[2]}`;
      const p = PACKAGES[id];
      if (!p) return send({ detail: "Not found." }, 404);
      const v = { version_number: m[3] ?? p.version, dependencies: p.deps, download_url: `${base}/package/download/${m[1]}/${m[2]}/${m[3] ?? p.version}/`, icon: `${base}/icons/${id}.png`, description: id };
      return send(m[3] ? v : { latest: v });
    }
    m = /^\/package\/download\/([^/]+)\/([^/]+)\/([^/]+)\/$/.exec(url.pathname);
    if (m) {
      const id = `${m[1]}-${m[2]}`;
      downloads.push(id);
      const p = PACKAGES[id];
      return send(writeZip({ ...meta(m[2], p.deps), ...p.files }));
    }
    send("not found", 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A fake Unity game folder. */
function game(name: string, opts: { il2cpp?: boolean; telosBepInEx?: boolean; ownBepInEx?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-market-"));
  const install = path.join(dir, name);
  const data = path.join(install, `${name}_Data`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(install, "UnityPlayer.dll"), "");
  fs.writeFileSync(path.join(install, `${name}.exe`), "MZ");
  if (opts.il2cpp) {
    fs.mkdirSync(path.join(data, "il2cpp_data", "Metadata"), { recursive: true });
    fs.writeFileSync(path.join(data, "il2cpp_data", "Metadata", "global-metadata.dat"), "");
    fs.writeFileSync(path.join(install, "GameAssembly.dll"), "");
  } else {
    fs.mkdirSync(path.join(data, "Managed"), { recursive: true });
    fs.writeFileSync(path.join(data, "Managed", "Assembly-CSharp.dll"), "");
  }
  if (opts.telosBepInEx || opts.ownBepInEx) {
    const files = ["winhttp.dll", "BepInEx/core/BepInEx.Core.dll", "BepInEx/plugins/ScruffBridge/TelosBridge.IL2CPP.dll"];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(install, f)), { recursive: true });
      fs.writeFileSync(path.join(install, f), "x");
    }
    if (opts.telosBepInEx) fs.writeFileSync(path.join(install, ".scruff-bridge.json"), JSON.stringify({ version: 1, bridge: "il2cpp", bepinexByScruff: true, files, backups: [] }));
    if (opts.ownBepInEx) {
      fs.mkdirSync(path.join(install, "BepInEx", "plugins", "SomeoneElsesMod"), { recursive: true });
      fs.writeFileSync(path.join(install, ".scruff-bridge.json"), JSON.stringify({ version: 1, bridge: "il2cpp", bepinexByScruff: false, files: [], backups: [] }));
    }
  }
  const profile = buildProfile(path.join(install, `${name}.exe`), { home: dir, appData: dir, localAppData: dir });
  return { install, profile, dir };
}

function market(profile: any, cacheDir?: string) {
  const store = new Thunderstore({ cacheDir: cacheDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "telos-market-cache-")), base });
  const notices: string[] = [];
  const m = new Marketplace({ store, profile: () => profile, isRunning: async () => false });
  m.on("notice", (t: string) => notices.push(t));
  return { m, store, notices };
}

const has = (install: string, rel: string) => fs.existsSync(path.join(install, rel));

test("finds the game's Thunderstore community and its mods, flagging what won't work here", async () => {
  const { profile } = game("Schedule I", { il2cpp: true });
  const { m } = market(profile);
  const mods = await m.search("");
  const s = m.snapshot();
  assert.deepEqual(s.community, { identifier: "schedule-i", name: "Schedule I" });
  assert.ok(!mods.some((x) => x.name === "r2modman"), "mod manager apps aren't mods");
  assert.equal(mods.find((x) => x.id === "LavaGang-MelonLoader")?.loader, "melonloader");
  assert.match(mods.find((x) => x.id === "Universal-MoreGuns")?.warning ?? "", /Mono version of the game; yours is IL2CPP/);
  assert.equal(mods.find((x) => x.id === "DazUki-LaundryApp")?.warning, undefined);
  assert.match(mods.find((x) => x.id === "DazUki-LaundryApp")!.url, /thunderstore\.io\/c\/schedule-i\/p\/DazUki\/LaundryApp/);
  assert.deepEqual((await m.search("laundering")).map((x) => x.id), ["DazUki-LaundryApp"]);

  const lonely = market(game("Totally Unknown Game").profile).m;
  await lonely.search("");
  assert.match(lonely.snapshot().error ?? "", /no community on Thunderstore yet/);
});

test("adding a MelonLoader mod to a game without a loader brings MelonLoader along; removing takes out just the mod", async () => {
  const { install, profile } = game("Schedule I", { il2cpp: true });
  const { m, notices } = market(profile);
  const res = await m.install("DazUki-LaundryApp");
  assert.deepEqual(res.added, ["LavaGang-MelonLoader 0.7.0", "DazUki-LaundryApp 1.1.8"]);
  assert.ok(has(install, "version.dll") && has(install, "MelonLoader/net35/MelonLoader.dll"), "MelonLoader in the game folder");
  assert.equal(fs.readFileSync(path.join(install, "Mods/LaundryApp.dll"), "utf8"), "laundry");
  assert.ok(!has(install, "manifest.json") && !has(install, "icon.png") && !has(install, "Mods/CHANGELOG.md"), "no package metadata in the game");
  assert.equal(gameLoader(install), "melonloader");
  assert.match(notices.at(-1) ?? "", /Added LavaGang-MelonLoader 0\.7\.0, DazUki-LaundryApp 1\.1\.8 to Schedule I\. Start the game.*first start/);
  const s = m.snapshot();
  assert.deepEqual(s.installed.filter((i) => i.explicit).map((i) => i.id), ["DazUki-LaundryApp"]);

  const removed = m.remove("DazUki-LaundryApp");
  assert.deepEqual(removed.removed, ["DazUki-LaundryApp"]);
  assert.ok(!has(install, "Mods"), "its file and the emptied folder are gone");
  assert.ok(has(install, "version.dll"), "the loader stays for other mods");
  assert.deepEqual(Object.keys(readMods(install).mods), ["LavaGang-MelonLoader"]);
});

test("a MelonLoader mod in a game with Telos's BepInEx: asks first, then switches loaders", async () => {
  const { install, profile } = game("Schedule I", { il2cpp: true, telosBepInEx: true });
  const { m } = market(profile);
  const res = await m.install("DazUki-LaundryApp");
  assert.deepEqual(res.added, []);
  const pending = m.snapshot().pending!;
  assert.equal(pending.id, "DazUki-LaundryApp");
  assert.match(pending.message, /runs on MelonLoader, but Schedule I has BepInEx, which Telos added.*Switching takes Telos's bridge and BepInEx out/);
  assert.ok(has(install, "BepInEx/core"), "nothing changed before the OK");

  await m.confirmSwitch("DazUki-LaundryApp");
  assert.ok(!has(install, "BepInEx") && !has(install, "winhttp.dll") && !has(install, ".scruff-bridge.json"), "Telos's BepInEx and bridge are out");
  assert.ok(has(install, "Mods/LaundryApp.dll") && has(install, "version.dll"));
  assert.equal(m.snapshot().pending, null);
});

test("the player's own BepInEx mods are never swapped out for a MelonLoader mod", async () => {
  const { install, profile } = game("Schedule I", { il2cpp: true, ownBepInEx: true });
  const { m } = market(profile);
  await assert.rejects(m.install("DazUki-LaundryApp"), (err: Error) => err instanceof LoaderConflict && !err.canSwitch && /other mods use BepInEx/.test(err.message));
  assert.ok(has(install, "BepInEx/plugins/SomeoneElsesMod") && !has(install, "version.dll"));
});

test("BepInEx mods: the pack goes in the game folder, mods in their own plugin folders, dependencies come and go with them", async () => {
  const { install, profile } = game("Lethal Company");
  const { m } = market(profile);
  const res = await m.install("notnotnotswipez-MoreCompany");
  assert.deepEqual(res.added, ["BepInEx-BepInExPack 5.4.2100", "notnotnotswipez-MoreCompany 1.14.0"]);
  assert.ok(has(install, "winhttp.dll") && has(install, "doorstop_config.ini") && has(install, "BepInEx/core/BepInEx.dll"), "the pack's folder is unwrapped");
  assert.ok(!has(install, "BepInExPack"));
  assert.equal(fs.readFileSync(path.join(install, "BepInEx/plugins/notnotnotswipez-MoreCompany/MoreCompany.dll"), "utf8"), "more company");

  // A mod with a library: loose files go in its plugin folder, config into BepInEx/config.
  await m.install("Tester-UsesLib");
  assert.ok(has(install, "BepInEx/plugins/Tester-UsesLib/UsesLib.dll") && has(install, "BepInEx/plugins/Tester-UsesLib/assets/sprite.png"));
  assert.ok(has(install, "BepInEx/plugins/Tester-Lib/Lib.dll") && has(install, "BepInEx/config/Lib.cfg"));
  assert.throws(() => m.remove("Tester-Lib"), /needed by UsesLib/);
  assert.deepEqual(m.remove("Tester-UsesLib").removed.sort(), ["Tester-Lib", "Tester-UsesLib"], "its library goes with it");
  assert.ok(!has(install, "BepInEx/plugins/Tester-Lib") && !has(install, "BepInEx/config/Lib.cfg"));
  assert.ok(has(install, "BepInEx/plugins/notnotnotswipez-MoreCompany/MoreCompany.dll"), "other mods stay");
});

test("a game that already has BepInEx keeps it: the pack isn't put over it", async () => {
  const { install, profile } = game("Lethal Company", { telosBepInEx: true });
  fs.mkdirSync(path.join(install, "BepInEx", "config"), { recursive: true });
  fs.writeFileSync(path.join(install, "BepInEx", "config", "BepInEx.cfg"), "telos config");
  const { m } = market(profile);
  const res = await m.install("notnotnotswipez-MoreCompany");
  assert.deepEqual(res.added, ["notnotnotswipez-MoreCompany 1.14.0"]);
  assert.equal(fs.readFileSync(path.join(install, "BepInEx/config/BepInEx.cfg"), "utf8"), "telos config");
  assert.equal(fs.readFileSync(path.join(install, "winhttp.dll"), "utf8"), "x", "the existing loader is untouched");
});

test("a player's file in the way is kept and put back; a package can't write outside the game", async () => {
  const { install, profile } = game("Lethal Company");
  fs.mkdirSync(path.join(install, "BepInEx", "plugins", "Tester-Lib"), { recursive: true });
  fs.writeFileSync(path.join(install, "BepInEx", "plugins", "Tester-Lib", "Lib.dll"), "the player's own build");
  const { m } = market(profile);
  await m.install("Tester-Lib");
  assert.equal(fs.readFileSync(path.join(install, "BepInEx/plugins/Tester-Lib/Lib.dll"), "utf8"), "lib");
  m.remove("Tester-Lib");
  assert.equal(fs.readFileSync(path.join(install, "BepInEx/plugins/Tester-Lib/Lib.dll"), "utf8"), "the player's own build");

  const before = Object.keys(readMods(install).mods);
  await assert.rejects(m.install("Tester-Evil"), /Refusing Tester-Evil: it has a file outside the game folder's layout/);
  assert.deepEqual(Object.keys(readMods(install).mods), before);
  assert.ok(!fs.existsSync(path.join(install, "escape.dll")) && !fs.existsSync(path.join(install, "..", "..", "escape.dll")));
  assert.ok(!has(install, "BepInEx/plugins/Tester-Evil"), "nothing of it was written");
});

test("downloads only come from Thunderstore", async () => {
  const store = new Thunderstore({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "telos-dl-")), fetch: (async () => new Response("zip")) as typeof fetch });
  await assert.rejects(store.download({ id: "A-B", version: "1.0.0", dependencies: [], downloadUrl: "https://evil.example/mod.zip" }), /only come from Thunderstore/);
  await assert.rejects(store.download({ id: "A-B", version: "1.0.0", dependencies: [], downloadUrl: "http://thunderstore.io/x.zip" }), /isn't https/);
  assert.deepEqual(parseDependency("BepInEx-BepInExPack-5.4.2100"), { id: "BepInEx-BepInExPack", version: "5.4.2100" });
  // r2modman's layout for a mod with everything.
  const placed = placeFiles(
    "A-Mod",
    Object.entries({ "BepInEx/patchers/P.dll": "", "monomod/M.dll": "", "core/C.dll": "", "readme.md": "", "x/y.bin": "" }).map(([name, d]) => ({ name, data: () => Buffer.from(d) })),
    "bepinex",
  ).map((f) => f.to);
  assert.deepEqual(placed, ["BepInEx/patchers/A-Mod/P.dll", "BepInEx/monomod/A-Mod/M.dll", "BepInEx/core/C.dll", "BepInEx/plugins/A-Mod/x/y.bin"]);
});

test("the chat AI finds and shows mods but can't install them", async () => {
  const { profile } = game("Schedule I", { il2cpp: true });
  const { m } = market(profile);
  const tools = Object.fromEntries(marketplaceTools(m, () => profile).map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ["find_mods", "installed_mods"]);
  const found = JSON.parse(String(await tools.find_mods.run({ query: "laundering" }, ctx)));
  assert.equal(found.community, "Schedule I");
  assert.deepEqual(found.mods.map((x: any) => x.id), ["DazUki-LaundryApp"]);
  assert.match(found.next, /Add button/);
  assert.deepEqual(m.snapshot().results.map((x) => x.id), ["DazUki-LaundryApp"], "shown in the Marketplace window");
  await m.install("DazUki-LaundryApp");
  const inst = JSON.parse(String(await tools.installed_mods.run({}, ctx)));
  assert.equal(inst.loader, "melonloader");
  assert.deepEqual(inst.mods.map((x: any) => [x.id, x.added_by_player]), [["LavaGang-MelonLoader", false], ["DazUki-LaundryApp", true]]);
});

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return p;
}

test("in the hub: the overlay's Add button installs, and the window's state follows", async () => {
  const { install, profile, dir } = game("Schedule I", { il2cpp: true });
  const port = await freePort();
  const brain = { model: "unused", createStream: () => { throw new Error("unused"); } } as any;
  const hub = await createHub({ root: path.resolve(import.meta.dirname, ".."), port, lan: false, token: "t", brain, dataDir: dir, jev: null, thunderstore: new Thunderstore({ cacheDir: path.join(dir, "cache"), base }) });
  try {
    hub.games.profile = profile;
    const dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    const states: any[] = [];
    dash.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "state") states.push(msg);
    });
    await new Promise((r) => dash.once("open", r));
    const until = async (ok: (s: any) => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!states.some(ok) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
      return states.find(ok);
    };
    dash.send(JSON.stringify({ type: "market_search", query: "" }));
    assert.ok(await until((s) => s.market?.results?.length > 0 && s.market.community?.identifier === "schedule-i"));
    dash.send(JSON.stringify({ type: "market_install", id: "DazUki-LaundryApp" }));
    const done = await until((s) => s.market?.installed?.some((i: any) => i.id === "DazUki-LaundryApp"));
    assert.ok(done, "installed shows up in the window");
    assert.ok(has(install, "Mods/LaundryApp.dll"));
    dash.close();
  } finally {
    hub.close();
  }
});

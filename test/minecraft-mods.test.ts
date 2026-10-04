import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { buildProfile, type GameProfile, type UserDirs } from "../src/games/profile.ts";
import { writeZip } from "../src/games/zip.ts";
import { createHub } from "../src/hub/create.ts";
import { Marketplace, Thunderstore, marketplaceTools, readMods } from "../src/hub/marketplace.ts";
import { CurseForge, CurseForgeKey, Modrinth, jarInfo, type McFile } from "../src/hub/minecraftmods.ts";

// Minecraft's mods, from Modrinth and CurseForge, through Telos's marketplace. A stand-in for both
// stores serves their API's shapes (Modrinth's recorded from the real API) and real jars; the
// game is a .minecraft on disk. Telos picks the file for the exact version and loader, brings the
// mods it requires, skips ones already in mods/, checks hashes, and removes exactly what it added.

const ctx = { signal: new AbortController().signal, progress() {} };
const FIXTURES = path.join(import.meta.dirname, "fixtures", "modrinth");
const KEY = "cf-test-key-123";

/** A Fabric (or Forge) mod jar with the given id. */
const fabricJar = (id: string, extra = "") => writeZip({ "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id, version: "1.0.0" }), [`${id}/Main.class`]: `class ${id}${extra}` });
const forgeJar = (id: string) => writeZip({ "META-INF/mods.toml": `modLoader="javafml"\n[[mods]]\nmodId="${id}"\n`, [`${id}/Main.class`]: "x" });
const sha = (algo: string, buf: Buffer) => createHash(algo).update(buf).digest("hex");

// ---- the stand-in stores ----
const JARS: Record<string, Buffer> = {
  "modmenu-21.0.0.jar": fabricJar("modmenu"),
  "fabric-api-0.161.0+26.3.jar": fabricJar("fabric-api"),
  "placeholder-api-3.2.0+26.3.jar": fabricJar("placeholder-api"),
  "sodium-forge.jar": forgeJar("sodium"),
  "tampered.jar": fabricJar("tampered"),
  "jei-cf.jar": fabricJar("jei"),
  "appleskin-cf.jar": fabricJar("appleskin"),
  "cloth-config-cf.jar": fabricJar("cloth-config"),
};
let base = "";
const seen: { url: string; key?: string }[] = [];
let server: http.Server;

/** Modrinth's projects: id → title, versions (for fabric 26.3), and what each requires. */
const MR: Record<string, { title: string; slug: string; file?: string; requires?: string[]; badHash?: boolean }> = {
  mOgUt4GM: { title: "Mod Menu", slug: "modmenu", file: "modmenu-21.0.0.jar", requires: ["eXts2L7r", "P7dR8mSH"] },
  P7dR8mSH: { title: "Fabric API", slug: "fabric-api", file: "fabric-api-0.161.0+26.3.jar" },
  eXts2L7r: { title: "Text Placeholder API", slug: "placeholder-api", file: "placeholder-api-3.2.0+26.3.jar" },
  AANobbMI: { title: "Sodium", slug: "sodium", file: "sodium-forge.jar" },
  tamperd1: { title: "Tampered", slug: "tampered", file: "tampered.jar", badHash: true },
  oldonly1: { title: "Old Only", slug: "old-only" },
  needsold: { title: "Needs Old", slug: "needs-old", file: "tampered.jar", requires: ["oldonly1"] },
};
const CF: Record<number, { name: string; file?: string; requires?: number[]; noDistribution?: boolean }> = {
  238222: { name: "Just Enough Items", file: "jei-cf.jar", requires: [348521] },
  348521: { name: "Cloth Config API", file: "cloth-config-cf.jar" },
  248787: { name: "AppleSkin", file: "appleskin-cf.jar", noDistribution: true },
};

function send(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined });
    const p = url.pathname;
    // Files.
    if (p.startsWith("/files/")) {
      const jar = JARS[decodeURIComponent(p.slice(7))];
      if (!jar) return send(res, {}, 404);
      res.writeHead(200, { "Content-Type": "application/java-archive" });
      return res.end(jar);
    }
    // Modrinth.
    if (p === "/v2/search") return send(res, JSON.parse(fs.readFileSync(path.join(FIXTURES, "search-mod-menu-26.3.json"), "utf8")));
    let m = /^\/v2\/project\/([^/]+)$/.exec(p);
    if (m && MR[m[1]]) return send(res, { id: m[1], title: MR[m[1]].title, slug: MR[m[1]].slug, icon_url: null });
    m = /^\/v2\/project\/([^/]+)\/version$/.exec(p);
    if (m && MR[m[1]]) {
      const proj = MR[m[1]];
      const loaders = JSON.parse(url.searchParams.get("loaders") ?? "[]");
      const versions = JSON.parse(url.searchParams.get("game_versions") ?? "[]");
      if (!proj.file || !loaders.includes("fabric") || versions[0] !== "26.3") return send(res, []);
      const jar = JARS[proj.file];
      return send(res, [
        {
          id: `${m[1]}-v`,
          version_number: "1.0.0",
          version_type: "release",
          files: [{ url: `${base}/files/${encodeURIComponent(proj.file)}`, filename: proj.file, primary: true, hashes: { sha1: sha("sha1", jar), sha512: proj.badHash ? "0".repeat(128) : sha("sha512", jar) } }],
          dependencies: (proj.requires ?? []).map((r) => ({ project_id: r, version_id: null, dependency_type: "required" })).concat([{ project_id: "optional1", version_id: null, dependency_type: "optional" }]),
        },
      ]);
    }
    // CurseForge: every call needs the key.
    if (p.startsWith("/v1/")) {
      if (req.headers["x-api-key"] !== KEY) return send(res, {}, 403);
      if (p === "/v1/mods/search") {
        const mods = Object.entries(CF).map(([id, c]) => cfMod(Number(id), c));
        return send(res, { data: mods, pagination: { index: 0, pageSize: 20, resultCount: mods.length, totalCount: mods.length } });
      }
      m = /^\/v1\/mods\/(\d+)$/.exec(p);
      if (m && CF[Number(m[1])]) return send(res, { data: cfMod(Number(m[1]), CF[Number(m[1])]) });
      m = /^\/v1\/mods\/(\d+)\/files$/.exec(p);
      if (m && CF[Number(m[1])]) {
        const c = CF[Number(m[1])];
        if (url.searchParams.get("gameVersion") !== "26.3" || url.searchParams.get("modLoaderType") !== "4" || !c.file) return send(res, { data: [] });
        const jar = JARS[c.file];
        const file = (id: number, date: string, releaseType: number) => ({
          id,
          displayName: `${c.name} ${id}`,
          fileName: c.file,
          fileDate: date,
          releaseType,
          isAvailable: true,
          downloadUrl: c.noDistribution ? null : `${base}/files/${encodeURIComponent(c.file!)}`,
          hashes: [{ value: sha("md5", jar), algo: 2 }, { value: sha("sha1", jar), algo: 1 }],
          dependencies: (c.requires ?? []).map((r) => ({ modId: r, relationType: 3 })).concat([{ modId: 999, relationType: 2 }]),
        });
        // A newer beta and an older release: the release is the one.
        return send(res, { data: [file(2, "2026-09-01T00:00:00Z", 1), file(3, "2026-09-20T00:00:00Z", 2)] });
      }
    }
    send(res, {}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

function cfMod(id: number, c: (typeof CF)[number]) {
  return {
    id,
    name: c.name,
    slug: c.name.toLowerCase().replace(/ /g, "-"),
    summary: `${c.name} for Minecraft`,
    downloadCount: 1000 * id,
    dateModified: "2026-09-01T00:00:00Z",
    allowModDistribution: !c.noDistribution,
    links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${id}` },
    logo: { thumbnailUrl: `${base}/icon.png` },
    authors: [{ name: "someone" }],
    categories: [{ name: "Utility" }],
  };
}

/** A .minecraft running Fabric 26.3 (or vanilla), with the player's own Fabric API already in mods/. */
function minecraft(opts: { loader?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "telos-mcmods-"));
  const dirs: UserDirs = { home: tmp, appData: tmp, localAppData: tmp };
  const mc = path.join(tmp, ".minecraft");
  fs.mkdirSync(path.join(mc, "mods"), { recursive: true });
  fs.mkdirSync(path.join(mc, "saves"), { recursive: true });
  fs.writeFileSync(path.join(mc, "mods", "fabric-api-0.150.0+26.3.jar"), fabricJar("fabric-api", "players-own"));
  const args = ["--gameDir", mc, "--version", opts.loader === false ? "26.3" : "fabric-loader-0.16.10-26.3", "--assetIndex", "29"];
  if (opts.loader !== false) args.unshift("net.fabricmc.loader.impl.launch.knot.KnotClient");
  const profile = buildProfile(path.join(tmp, "runtime", "bin", "javaw.exe"), dirs, { args, title: "Minecraft* 26.3" });
  const cfKey = new CurseForgeKey(path.join(tmp, "data", "curseforge.json"), {});
  const stores = [
    new Modrinth({ cacheDir: path.join(tmp, "cache"), base }),
    new CurseForge({ key: () => cfKey.get(), cacheDir: path.join(tmp, "cache"), base }),
  ];
  const notices: string[] = [];
  const m = new Marketplace({
    store: new Thunderstore({ cacheDir: path.join(tmp, "ts"), base: "http://127.0.0.1:9" }),
    profile: () => profile,
    isRunning: async () => false,
    minecraft: { stores, curseforgeKey: cfKey },
  });
  m.on("notice", (t: string) => notices.push(t));
  return { tmp, mc, profile, m, cfKey, stores, notices };
}

const jars = (mc: string) => fs.readdirSync(path.join(mc, "mods")).sort();

test("Modrinth's real responses: search, the version for the game, and what it requires", async () => {
  const calls: string[] = [];
  const realSearch = fs.readFileSync(path.join(FIXTURES, "search-mod-menu-26.3.json"), "utf8");
  const realVersions = fs.readFileSync(path.join(FIXTURES, "modmenu-versions-fabric-26.3.json"), "utf8");
  const stub = (async (url: string | URL) => {
    calls.push(String(url));
    const u = String(url);
    const body = u.includes("/search?") ? realSearch : u.endsWith("/project/mOgUt4GM") ? JSON.stringify({ title: "Mod Menu", slug: "modmenu", icon_url: null }) : realVersions;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const mr = new Modrinth({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "mr-")), fetch: stub });
  const res = await mr.search("mod menu", { version: "26.3", loader: "Fabric" }, 1);
  assert.equal(res.mods[0].id, "modrinth:mOgUt4GM");
  assert.equal(res.mods[0].name, "Mod Menu");
  assert.equal(res.mods[0].namespace, "Prospector");
  assert.equal(res.mods[0].url, "https://modrinth.com/mod/modmenu");
  const facets = JSON.parse(new URL(calls[0]).searchParams.get("facets")!);
  assert.deepEqual(facets, [["project_type:mod"], ["categories:fabric"], ["versions:26.3"]]);
  assert.equal(new URL(calls[0]).searchParams.get("index"), "relevance");

  const f = await mr.file("modrinth:mOgUt4GM", { version: "26.3", loader: "Fabric" });
  assert.equal(f.version, "21.0.0", "the release, not the newer beta");
  assert.equal(f.filename, "modmenu-21.0.0.jar");
  assert.equal(f.url, "https://cdn.modrinth.com/data/mOgUt4GM/versions/kyy7dbrZ/modmenu-21.0.0.jar");
  assert.equal(f.hash?.algo, "sha512");
  assert.deepEqual(f.requires.map((r) => r.id).sort(), ["modrinth:P7dR8mSH", "modrinth:eXts2L7r"]);
  // Quilt runs Fabric mods: both count.
  await mr.file("modrinth:mOgUt4GM", { version: "26.3", loader: "Quilt" });
  assert.deepEqual(JSON.parse(new URL(calls.at(-1)!).searchParams.get("loaders")!), ["quilt", "fabric"]);
});

test("adding a Minecraft mod: its file for the exact version and loader, what it requires, not what's already there", async () => {
  const { mc, m, notices, profile } = minecraft();
  assert.deepEqual(profile.minecraft, { version: "26.3", loader: "Fabric", loaderVersion: "0.16.10" });
  const s = m.snapshot();
  assert.equal(s.minecraft?.source, "modrinth");
  assert.deepEqual(s.minecraft?.sources.map((x) => [x.id, Boolean(x.problem)]), [["modrinth", false], ["curseforge", true]]);

  const found = await m.search("mod menu");
  assert.equal(found[0].id, "modrinth:mOgUt4GM");
  const r = await m.install("modrinth:mOgUt4GM");
  assert.deepEqual(r.added, ["Text Placeholder API 1.0.0", "Mod Menu 1.0.0"]);
  assert.match(r.note, /Fabric API was already there/);
  assert.match(notices.at(-1)!, /Start Minecraft with Fabric to load them/);
  // The player's own Fabric API stays the only copy: two would stop the game.
  assert.deepEqual(jars(mc), ["fabric-api-0.150.0+26.3.jar", "modmenu-21.0.0.jar", "placeholder-api-3.2.0+26.3.jar"]);
  const record = readMods(mc).mods;
  assert.equal(record["modrinth:mOgUt4GM"].explicit, true);
  assert.equal(record["modrinth:eXts2L7r"].explicit, false);
  assert.deepEqual(record["modrinth:mOgUt4GM"].files, ["mods/modmenu-21.0.0.jar"]);
  assert.equal(m.snapshot().results.find((x) => x.id === "modrinth:mOgUt4GM")?.installed, "1.0.0");
  // Adding it again puts the same file back in place: still one copy.
  await m.install("modrinth:mOgUt4GM");
  assert.deepEqual(jars(mc), ["fabric-api-0.150.0+26.3.jar", "modmenu-21.0.0.jar", "placeholder-api-3.2.0+26.3.jar"]);
  // A mod the player put in themselves isn't added twice.
  fs.writeFileSync(path.join(mc, "mods", "my-modmenu.jar"), fabricJar("modmenu"));
  const fresh = minecraft();
  fs.writeFileSync(path.join(fresh.mc, "mods", "my-modmenu.jar"), fabricJar("modmenu"));
  await assert.rejects(fresh.m.install("modrinth:mOgUt4GM"), /Mod Menu is already in the mods folder \(mods\/my-modmenu\.jar\)/);
  fs.rmSync(path.join(mc, "mods", "my-modmenu.jar"));

  // Removing takes out the mod and what came with it; the player's own jar stays.
  const gone = m.remove("modrinth:mOgUt4GM");
  assert.deepEqual(gone.removed.sort(), ["modrinth:eXts2L7r", "modrinth:mOgUt4GM"]);
  assert.match(gone.note, /^Removed (Mod Menu, Text Placeholder API|Text Placeholder API, Mod Menu) from Minecraft\./);
  assert.deepEqual(jars(mc), ["fabric-api-0.150.0+26.3.jar"]);
  assert.ok(!fs.existsSync(path.join(mc, ".telos-mods.json")));
});

test("what Telos refuses: a bad hash, the wrong loader's jar, a missing version, another host, no loader", async () => {
  const { mc, m, stores } = minecraft();
  await assert.rejects(m.install("modrinth:tamperd1"), /doesn't match the file Modrinth lists/);
  await assert.rejects(m.install("modrinth:AANobbMI"), /isn't a Fabric mod \(it's for Forge \/ NeoForge\)/);
  await assert.rejects(m.install("modrinth:needsold"), /Needs Old needs Old Only, which has no version for Minecraft 26\.3 with Fabric/);
  assert.deepEqual(jars(mc), ["fabric-api-0.150.0+26.3.jar"], "nothing written by a failed add");
  assert.match(m.snapshot().error ?? "", /Old Only/);

  // Outside tests, downloads only come from the store's own hosts, over https.
  const real = new Modrinth({ cacheDir: path.join(mc, "..", "c2"), fetch: (async () => new Response("x")) as typeof fetch });
  const evil: McFile = { id: "modrinth:x", name: "X", version: "1", filename: "x.jar", url: "https://evil.example/x.jar", requires: [] };
  await assert.rejects(real.download(evil), /only come from Modrinth/);
  await assert.rejects(real.download({ ...evil, url: "http://cdn.modrinth.com/x.jar" }), /isn't https/);
  const cf = new CurseForge({ key: () => "k", cacheDir: path.join(mc, "..", "c3"), fetch: (async () => new Response("x")) as typeof fetch });
  await assert.rejects(cf.download({ ...evil, url: "https://cdn.modrinth.com/x.jar" }), /only come from CurseForge/);
  assert.equal(stores.length, 2);

  // No loader running: browsing works, adding says what's missing.
  const vanilla = minecraft({ loader: false });
  assert.equal(vanilla.profile.minecraft?.loader, undefined);
  assert.ok((await vanilla.m.search("")).length > 0);
  await assert.rejects(vanilla.m.install("modrinth:mOgUt4GM"), /without a mod loader.*Install Fabric for 26\.3/);
});

test("CurseForge: asks for a key, keeps it private, follows required mods, respects authors who block downloads", async () => {
  const { tmp, mc, m, cfKey } = minecraft();
  await m.setSource("curseforge");
  let s = m.snapshot();
  assert.equal(s.minecraft?.source, "curseforge");
  assert.match(s.error ?? "", /needs an API key.*console\.curseforge\.com/);
  assert.equal(s.results.length, 0);
  assert.ok(!seen.some((c) => c.url.startsWith("/v1/")), "no call without a key");

  await assert.rejects(m.setCurseForgeKey("paste your key here"), /doesn't look like/);
  await m.setCurseForgeKey(`  "${KEY}"  `);
  assert.equal(cfKey.get(), KEY);
  assert.equal(cfKey.source, "saved");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(tmp, "data", "curseforge.json")).mode & 0o777, 0o600);
  s = m.snapshot();
  assert.equal(s.error, null);
  assert.deepEqual(s.results.map((x) => x.name).sort(), ["AppleSkin", "Cloth Config API", "Just Enough Items"]);
  assert.match(s.results.find((x) => x.name === "AppleSkin")?.warning ?? "", /only allows downloads on CurseForge's site/);
  assert.ok(!JSON.stringify(s).includes(KEY), "the key never goes to the dashboard");
  const search = new URL(seen.filter((c) => c.url.startsWith("/v1/mods/search")).at(-1)!.url, "http://x");
  assert.deepEqual(
    ["gameId", "classId", "gameVersion", "modLoaderType"].map((k) => search.searchParams.get(k)),
    ["432", "6", "26.3", "4"],
  );
  assert.ok(seen.filter((c) => c.url.startsWith("/v1/")).every((c) => c.key === KEY));

  const r = await m.install("curseforge:238222");
  assert.deepEqual(r.added, ["Cloth Config API Cloth Config API 2", "Just Enough Items Just Enough Items 2"], "the release file, with its required mod");
  assert.ok(jars(mc).includes("jei-cf.jar") && jars(mc).includes("cloth-config-cf.jar"));
  await assert.rejects(m.install("curseforge:248787"), /only allows downloads on CurseForge's site: get it at https:\/\/www\.curseforge\.com/);

  // The chat AI's view: the store, the target, the mods.
  const [find, installed] = marketplaceTools(m, () => m["opts"].profile());
  const out = JSON.parse(String(await find.run({ query: "jei" }, ctx)));
  assert.equal(out.store, "CurseForge");
  assert.equal(out.for, "Minecraft 26.3 with Fabric");
  assert.equal(out.mods[0].installed, "Just Enough Items 2");
  const back = JSON.parse(String(await find.run({ query: "mod menu", source: "modrinth" }, ctx)));
  assert.equal(back.store, "Modrinth");
  assert.equal(JSON.parse(String(await installed.run({}, ctx))).loader, "Fabric");

  await m.setCurseForgeKey(null);
  assert.equal(cfKey.get(), null);
  assert.ok(!fs.existsSync(path.join(tmp, "data", "curseforge.json")));
});

test("jar metadata: Fabric, Quilt, Forge and NeoForge mod ids", () => {
  assert.deepEqual(jarInfo(fabricJar("sodium")), { ids: ["sodium"], loaders: ["Fabric", "Quilt"] });
  assert.deepEqual(jarInfo(writeZip({ "fabric.mod.json": JSON.stringify({ id: "a", provides: ["b"] }) })).ids, ["a", "b"]);
  assert.deepEqual(jarInfo(writeZip({ "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "q", provides: [{ id: "qq" }] } }) })), { ids: ["q", "qq"], loaders: ["Quilt"] });
  assert.deepEqual(jarInfo(forgeJar("jei")), { ids: ["jei"], loaders: ["Forge", "NeoForge"] });
  assert.deepEqual(jarInfo(writeZip({ "META-INF/neoforge.mods.toml": `[[mods]]\nmodId = "create"\n[[dependencies.create]]\nmodId="minecraft"\n` })), { ids: ["create"], loaders: ["NeoForge"] });
});

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return p;
}

test("in the hub: the window switches stores and takes a CurseForge key; the key never comes back", async () => {
  const { tmp, profile, stores } = minecraft();
  const port = await freePort();
  const brain = { model: "unused", createStream: () => { throw new Error("unused"); } } as any;
  const hub = await createHub({ root: path.resolve(import.meta.dirname, ".."), port, lan: false, token: "t", brain, dataDir: path.join(tmp, "hubdata"), jev: null, minecraftStores: stores });
  try {
    hub.games.profile = profile as GameProfile;
    const dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    const raw: string[] = [];
    const states: any[] = [];
    dash.on("message", (data) => {
      raw.push(String(data));
      const msg = JSON.parse(String(data));
      if (msg.type === "state") states.push(msg);
    });
    await new Promise((r) => dash.once("open", r));
    const until = async (ok: (s: any) => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!states.some(ok) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
      return states.find(ok);
    };
    dash.send(JSON.stringify({ type: "market_search", query: "" }));
    assert.ok(await until((s) => s.market?.minecraft?.source === "modrinth" && s.market.results.length > 0));
    dash.send(JSON.stringify({ type: "market_source", source: "curseforge" }));
    assert.ok(await until((s) => s.market?.minecraft?.source === "curseforge" && /API key/.test(s.market.error ?? "")));
    // The hub's own CurseForge (its own key file) is a separate one from the stand-in's; the stand-in reads the test's key.
    dash.send(JSON.stringify({ type: "market_curseforge_key", key: KEY }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!raw.some((r) => r.includes(KEY)), "the key never goes back to the dashboard");
    dash.close();
  } finally {
    hub.close();
  }
});

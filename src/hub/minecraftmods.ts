import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeJoin } from "../games/bepinex.ts";
import type { Loader } from "../games/minecraft.ts";
import { readZip } from "../games/zip.ts";
import type { InstalledMod, MarketMod } from "./marketplace.ts";

/**
 * Minecraft's mod stores. Minecraft mods are single .jar files in the game directory's mods/
 * folder, built for one game version and one loader (Fabric, Quilt, Forge, NeoForge). Players
 * get them from Modrinth (open API) and CurseForge (needs an API key, and some authors allow
 * downloads only on CurseForge's own site). Telos picks the file for the player's exact version
 * and loader, adds the mods it requires, skips ones already in mods/ (by the mod id inside the
 * jar: two copies of a mod stop the game), checks every download against the store's hash, and
 * records what it wrote in .telos-mods.json like the Thunderstore marketplace does.
 */

export type McSourceId = "modrinth" | "curseforge";

export interface McTarget {
  version: string;
  loader: Loader;
}

/** One mod file, ready to download. */
export interface McFile {
  /** "modrinth:<project id>" or "curseforge:<mod id>". */
  id: string;
  name: string;
  version: string;
  filename: string;
  url: string;
  hash?: { algo: "sha1" | "sha512"; value: string };
  /** The mods it can't run without, with a specific version when the store pins one. */
  requires: { id: string; pinned?: string }[];
  icon?: string;
  page?: string;
}

/** A store of Minecraft mods. */
export interface McStore {
  readonly id: McSourceId;
  readonly name: string;
  /** Why it can't be used right now (no API key), or null. */
  problem(): string | null;
  search(query: string, target: Partial<McTarget>, page: number): Promise<{ count: number; mods: MarketMod[] }>;
  /** The file of a mod for this game version and loader (or a pinned version of it). */
  file(id: string, target: McTarget, pinned?: string): Promise<McFile>;
  download(f: McFile): Promise<Buffer>;
}

const PAGE = 20;
const MAX_JAR = 100 * 1024 * 1024;
const UA = "Telos/0.1 (game mod overlay)";

/** What a store calls each loader. Quilt runs Fabric mods too. */
const MODRINTH_LOADERS: Record<Loader, string[]> = { Fabric: ["fabric"], Quilt: ["quilt", "fabric"], Forge: ["forge"], NeoForge: ["neoforge"] };
/** CurseForge's ModLoaderType numbers. */
const CF_LOADER: Record<Loader, number[]> = { Fabric: [4], Quilt: [5, 4], Forge: [1], NeoForge: [6] };
const CF_MINECRAFT = 432;
const CF_MODS = 6;

type Fetch = typeof fetch;

/** Shared download: https only, from the store's own hosts, hash-checked, cached on disk. */
async function fetchJar(
  f: McFile,
  o: { fetch?: Fetch; cacheDir: string; hosts: RegExp; store: string; test: boolean },
): Promise<Buffer> {
  const key = `${f.filename.replace(/[^\w.+-]+/g, "_")}-${(f.hash?.value ?? "nohash").slice(0, 12)}`;
  const cached = path.join(o.cacheDir, "minecraft", key);
  if (f.hash && fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (digest(buf, f.hash.algo) === f.hash.value.toLowerCase()) return buf;
  }
  const url = new URL(f.url);
  if (!o.test) {
    if (url.protocol !== "https:") throw new Error("Refusing a download that isn't https.");
    if (!o.hosts.test(url.hostname)) throw new Error(`Refusing to download from ${url.hostname}: mods only come from ${o.store}.`);
  }
  const res = await (o.fetch ?? fetch)(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Downloading ${f.name} failed: ${res.status}`);
  if (!o.test && res.url && !o.hosts.test(new URL(res.url).hostname)) throw new Error(`The download went somewhere other than ${o.store}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_JAR) throw new Error(`${f.name} is too big (${Math.round(buf.length / 1e6)} MB).`);
  if (f.hash && digest(buf, f.hash.algo) !== f.hash.value.toLowerCase()) {
    throw new Error(`${f.name}'s download doesn't match the file ${o.store} lists (damaged or tampered with): not added.`);
  }
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, buf);
  return buf;
}

const digest = (buf: Buffer, algo: "sha1" | "sha512") => createHash(algo).update(buf).digest("hex");

/** Modrinth (modrinth.com): an open API, no key. */
export class Modrinth implements McStore {
  readonly id = "modrinth" as const;
  readonly name = "Modrinth";
  private projects = new Map<string, { title: string; icon?: string; slug: string }>();

  constructor(private opts: { cacheDir: string; fetch?: Fetch; base?: string }) {}

  problem(): null {
    return null;
  }

  private async get<T>(p: string): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.base ?? "https://api.modrinth.com"}/v2${p}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Modrinth answered ${res.status}`);
    return (await res.json()) as T;
  }

  async search(query: string, target: Partial<McTarget>, page: number): Promise<{ count: number; mods: MarketMod[] }> {
    const facets: string[][] = [["project_type:mod"]];
    if (target.loader) facets.push(MODRINTH_LOADERS[target.loader].map((l) => `categories:${l}`));
    if (target.version) facets.push([`versions:${target.version}`]);
    const q = new URLSearchParams({ facets: JSON.stringify(facets), index: query ? "relevance" : "downloads", offset: String((page - 1) * PAGE), limit: String(PAGE) });
    if (query) q.set("query", query);
    type Hit = { project_id: string; slug: string; title: string; description: string; author: string; icon_url?: string | null; downloads: number; follows: number; categories: string[]; date_modified: string };
    const res = await this.get<{ hits: Hit[]; total_hits: number }>(`/search?${q}`);
    return {
      count: res.total_hits,
      mods: res.hits.map((h) => {
        this.projects.set(h.project_id, { title: h.title, icon: h.icon_url ?? undefined, slug: h.slug });
        return {
          id: `modrinth:${h.project_id}`,
          namespace: h.author,
          name: h.title,
          description: h.description,
          icon: h.icon_url ?? undefined,
          downloads: h.downloads,
          rating: h.follows,
          categories: h.categories,
          updated: h.date_modified,
          url: `https://modrinth.com/mod/${h.slug}`,
          source: "modrinth",
        };
      }),
    };
  }

  private async project(pid: string): Promise<{ title: string; icon?: string; slug: string }> {
    const hit = this.projects.get(pid);
    if (hit) return hit;
    const p = await this.get<{ title: string; icon_url?: string | null; slug: string }>(`/project/${encodeURIComponent(pid)}`);
    const info = { title: p.title, icon: p.icon_url ?? undefined, slug: p.slug };
    this.projects.set(pid, info);
    return info;
  }

  async file(id: string, target: McTarget, pinned?: string): Promise<McFile> {
    const pid = id.replace(/^modrinth:/, "");
    const info = await this.project(pid);
    type Version = {
      id: string;
      version_number: string;
      version_type: string;
      files: { url: string; filename: string; primary: boolean; hashes: { sha1?: string; sha512?: string } }[];
      dependencies: { project_id: string | null; version_id: string | null; dependency_type: string }[];
    };
    let v: Version | undefined;
    if (pinned) v = await this.get<Version>(`/version/${encodeURIComponent(pinned)}`);
    else {
      const q = new URLSearchParams({ loaders: JSON.stringify(MODRINTH_LOADERS[target.loader]), game_versions: JSON.stringify([target.version]) });
      const list = await this.get<Version[]>(`/project/${encodeURIComponent(pid)}/version?${q}`);
      v = list.find((x) => x.version_type === "release") ?? list[0];
    }
    if (!v) throw new NoFile(`${info.title} has no version for Minecraft ${target.version} with ${target.loader} on Modrinth.`);
    const f = v.files.find((x) => x.primary) ?? v.files[0];
    if (!f) throw new NoFile(`${info.title} ${v.version_number} has no file to download.`);
    const requires: McFile["requires"] = [];
    for (const d of v.dependencies) {
      if (d.dependency_type !== "required") continue;
      // A dependency named only by its version: find the project it belongs to.
      const dpid = d.project_id ?? (d.version_id ? (await this.get<{ project_id: string }>(`/version/${encodeURIComponent(d.version_id)}`)).project_id : null);
      if (dpid) requires.push({ id: `modrinth:${dpid}`, ...(d.version_id ? { pinned: d.version_id } : {}) });
    }
    return {
      id: `modrinth:${pid}`,
      name: info.title,
      version: v.version_number,
      filename: f.filename,
      url: f.url,
      hash: f.hashes.sha512 ? { algo: "sha512", value: f.hashes.sha512 } : f.hashes.sha1 ? { algo: "sha1", value: f.hashes.sha1 } : undefined,
      requires,
      icon: info.icon,
      page: `https://modrinth.com/mod/${info.slug}`,
    };
  }

  download(f: McFile): Promise<Buffer> {
    return fetchJar(f, { fetch: this.opts.fetch, cacheDir: this.opts.cacheDir, hosts: /(^|\.)modrinth\.com$/, store: "Modrinth", test: Boolean(this.opts.base) });
  }
}

/** CurseForge (curseforge.com): its API needs a key (free, from console.curseforge.com). */
export class CurseForge implements McStore {
  readonly id = "curseforge" as const;
  readonly name = "CurseForge";
  private mods = new Map<string, CfMod>();

  constructor(private opts: { key: () => string | null; cacheDir: string; fetch?: Fetch; base?: string }) {}

  problem(): string | null {
    return this.opts.key()
      ? null
      : "CurseForge needs an API key: get one free at console.curseforge.com (sign in, API keys), then paste it here.";
  }

  private async get<T>(p: string): Promise<T> {
    const key = this.opts.key();
    if (!key) throw new Error(this.problem()!);
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.base ?? "https://api.curseforge.com"}/v1${p}`, {
      headers: { "x-api-key": key, Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error("CurseForge turned the API key down: check it (console.curseforge.com) and paste it again.");
    if (!res.ok) throw new Error(`CurseForge answered ${res.status}`);
    return (await res.json()) as T;
  }

  async search(query: string, target: Partial<McTarget>, page: number): Promise<{ count: number; mods: MarketMod[] }> {
    const q = new URLSearchParams({
      gameId: String(CF_MINECRAFT),
      classId: String(CF_MODS),
      sortField: "2", // popularity
      sortOrder: "desc",
      index: String((page - 1) * PAGE),
      pageSize: String(PAGE),
    });
    if (query) q.set("searchFilter", query);
    if (target.version) q.set("gameVersion", target.version);
    // Quilt players mostly run Fabric mods: search those.
    if (target.loader) q.set("modLoaderType", String(target.loader === "Quilt" ? 4 : CF_LOADER[target.loader][0]));
    const res = await this.get<{ data: CfMod[]; pagination: { totalCount: number } }>(`/mods/search?${q}`);
    return {
      count: Math.min(res.pagination.totalCount, 10_000), // CurseForge pages no further
      mods: res.data.map((m) => {
        this.mods.set(String(m.id), m);
        return {
          id: `curseforge:${m.id}`,
          namespace: m.authors?.[0]?.name ?? "",
          name: m.name,
          description: m.summary,
          icon: m.logo?.thumbnailUrl ?? undefined,
          downloads: m.downloadCount,
          rating: m.thumbsUpCount ?? 0,
          categories: (m.categories ?? []).map((c) => c.name),
          updated: m.dateModified,
          url: pageOf(m),
          source: "curseforge",
          ...(m.allowModDistribution === false ? { warning: "Its author only allows downloads on CurseForge's site: Telos can't add it for you." } : {}),
        };
      }),
    };
  }

  private async mod(modId: string): Promise<CfMod> {
    const hit = this.mods.get(modId);
    if (hit) return hit;
    const m = (await this.get<{ data: CfMod }>(`/mods/${encodeURIComponent(modId)}`)).data;
    this.mods.set(modId, m);
    return m;
  }

  async file(id: string, target: McTarget, pinned?: string): Promise<McFile> {
    const modId = id.replace(/^curseforge:/, "");
    const m = await this.mod(modId);
    let file: CfFile | undefined;
    if (pinned) file = (await this.get<{ data: CfFile }>(`/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(pinned)}`)).data;
    else {
      for (const type of CF_LOADER[target.loader]) {
        const q = new URLSearchParams({ gameVersion: target.version, modLoaderType: String(type), pageSize: "50" });
        const files = (await this.get<{ data: CfFile[] }>(`/mods/${encodeURIComponent(modId)}/files?${q}`)).data
          .filter((f) => f.isAvailable !== false)
          .sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate));
        file = files.find((f) => f.releaseType === 1) ?? files[0];
        if (file) break;
      }
    }
    if (!file) throw new NoFile(`${m.name} has no file for Minecraft ${target.version} with ${target.loader} on CurseForge.`);
    if (!file.downloadUrl) {
      throw new Error(`${m.name}'s author only allows downloads on CurseForge's site: get it at ${pageOf(m)} and put the .jar in the mods folder.`);
    }
    const sha1 = file.hashes?.find((h) => h.algo === 1)?.value;
    return {
      id: `curseforge:${m.id}`,
      name: m.name,
      version: file.displayName || file.fileName,
      filename: file.fileName,
      url: file.downloadUrl,
      hash: sha1 ? { algo: "sha1", value: sha1 } : undefined,
      // 3: required.
      requires: (file.dependencies ?? []).filter((d) => d.relationType === 3).map((d) => ({ id: `curseforge:${d.modId}` })),
      icon: m.logo?.thumbnailUrl ?? undefined,
      page: pageOf(m),
    };
  }

  download(f: McFile): Promise<Buffer> {
    return fetchJar(f, { fetch: this.opts.fetch, cacheDir: this.opts.cacheDir, hosts: /(^|\.)forgecdn\.net$/, store: "CurseForge", test: Boolean(this.opts.base) });
  }
}

interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  thumbsUpCount?: number;
  dateModified: string;
  allowModDistribution?: boolean | null;
  links?: { websiteUrl?: string };
  logo?: { thumbnailUrl?: string } | null;
  authors?: { name: string }[];
  categories?: { name: string }[];
}

interface CfFile {
  id: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  releaseType: number; // 1 release, 2 beta, 3 alpha
  isAvailable?: boolean;
  downloadUrl: string | null;
  hashes?: { value: string; algo: number }[]; // 1: sha1, 2: md5
  dependencies?: { modId: number; relationType: number }[];
}

const pageOf = (m: CfMod) => m.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`;

/** A mod with no file for this game: worth saying plainly, not as a network error. */
export class NoFile extends Error {}

// ------------------------------------------------------------------ what's in mods/

/** The mod ids a jar declares (fabric.mod.json, quilt.mod.json, (neoforge.)mods.toml), and which loader it's for. */
export function jarInfo(buf: Buffer): { ids: string[]; loaders: Loader[] } {
  const entries = readZip(buf);
  const read = (name: string) => entries.find((e) => e.name === name)?.data().toString("utf8");
  const ids: string[] = [];
  const loaders: Loader[] = [];
  const fabric = read("fabric.mod.json");
  if (fabric) {
    loaders.push("Fabric", "Quilt");
    try {
      const j = JSON.parse(fabric.replace(/^﻿/, ""));
      if (typeof j.id === "string") ids.push(j.id);
      if (Array.isArray(j.provides)) ids.push(...j.provides.filter((x: unknown) => typeof x === "string"));
    } catch {
      // unreadable metadata: no ids to match on
    }
  }
  const quilt = read("quilt.mod.json");
  if (quilt) {
    loaders.push("Quilt");
    try {
      const j = JSON.parse(quilt).quilt_loader ?? {};
      if (typeof j.id === "string") ids.push(j.id);
      for (const p of j.provides ?? []) ids.push(typeof p === "string" ? p : p?.id);
    } catch {
      // as above
    }
  }
  for (const [file, loader] of [["META-INF/mods.toml", "Forge"], ["META-INF/neoforge.mods.toml", "NeoForge"]] as const) {
    const toml = read(file);
    if (!toml) continue;
    loaders.push(loader);
    // Before NeoForge 20.5 its mods used mods.toml too.
    if (loader === "Forge") loaders.push("NeoForge");
    for (const m of toml.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)) ids.push(m[1]);
  }
  return { ids: [...new Set(ids.filter(Boolean))].filter((i) => i !== "minecraft" && i !== "java"), loaders: [...new Set(loaders)] };
}

const jarCache = new Map<string, { stamp: string; ids: string[] }>();

/** Mod id → the jar in mods/ that has it. */
export function modsPresent(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const mods = path.join(dir, "mods");
  let files: string[] = [];
  try {
    files = fs.readdirSync(mods).filter((f) => f.toLowerCase().endsWith(".jar"));
  } catch {
    return out;
  }
  for (const f of files) {
    const full = path.join(mods, f);
    try {
      const st = fs.statSync(full);
      const stamp = `${st.size}:${st.mtimeMs}`;
      let hit = jarCache.get(full);
      if (!hit || hit.stamp !== stamp) {
        hit = { stamp, ids: st.size > MAX_JAR ? [] : jarInfo(fs.readFileSync(full)).ids };
        jarCache.set(full, hit);
      }
      for (const id of hit.ids) if (!out.has(id)) out.set(id, `mods/${f}`);
    } catch {
      // not a readable jar: nothing to match
    }
  }
  return out;
}

// ------------------------------------------------------------------ adding

export interface McInstallResult {
  added: InstalledMod[];
  /** Required mods the player already has (name → where). */
  already: { name: string; file: string }[];
}

/**
 * Works out a mod's files and the mods it requires, downloads and checks them all, then writes
 * them into mods/ (nothing is written if anything fails). `record` is the game's
 * .telos-mods.json; the caller saves it.
 */
export async function addMinecraftMod(
  dir: string,
  target: McTarget,
  store: McStore,
  id: string,
  record: Record<string, InstalledMod>,
  progress: (text: string) => void = () => {},
): Promise<McInstallResult> {
  progress("Checking what it needs…");
  const plan: McFile[] = [];
  const seen = new Set<string>();
  const visit = async (modId: string, pinned: string | undefined, neededBy: string | null, depth: number): Promise<void> => {
    if (seen.has(modId) || depth > 12) return;
    seen.add(modId);
    if (neededBy && record[modId]) return; // Telos added it before
    let f: McFile;
    try {
      f = await store.file(modId, target, pinned);
    } catch (err) {
      if (neededBy && err instanceof NoFile) throw new NoFile(`${neededBy} needs ${err.message.replace(/ has no /, ", which has no ")}`);
      throw err;
    }
    for (const r of f.requires) await visit(r.id, r.pinned, f.name, depth + 1);
    plan.push(f);
  };
  await visit(id, undefined, null, 0);
  const main = plan.at(-1)!;

  // Everything downloaded and checked before anything is written.
  const present = modsPresent(dir);
  const owned = new Map(Object.values(record).flatMap((m) => m.files.map((f) => [f, m.id] as const)));
  const ready: { f: McFile; buf: Buffer }[] = [];
  const already: McInstallResult["already"] = [];
  for (const f of plan) {
    progress(`Downloading ${f.name} ${f.version}…`);
    const buf = await store.download(f);
    let info: { ids: string[]; loaders: Loader[] };
    try {
      info = jarInfo(buf);
    } catch {
      throw new Error(`${f.name}'s download isn't a mod jar: not added.`);
    }
    if (!info.loaders.includes(target.loader)) {
      throw new Error(`${f.name} ${f.version} isn't a ${target.loader} mod (it's for ${info.loaders.join(" / ") || "no loader Telos knows"}): not added.`);
    }
    const have = info.ids.map((i) => present.get(i)).find((file) => file && owned.get(file) !== f.id);
    if (have) {
      if (f === main) throw new Error(`${f.name} is already in the mods folder (${have}).`);
      already.push({ name: f.name, file: have });
      continue;
    }
    ready.push({ f, buf });
  }

  const added: InstalledMod[] = [];
  for (const { f, buf } of ready) {
    progress(`Adding ${f.name}…`);
    const rel = `mods/${f.filename}`;
    if (/[\\/]/.test(f.filename) || !f.filename.toLowerCase().endsWith(".jar")) throw new Error(`Refusing ${f.name}: odd file name ${f.filename}.`);
    const full = safeJoin(dir, rel);
    const previous = record[f.id];
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.telos-part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, full);
    // An older version Telos added goes (a loaded one is renamed aside: mods/ only loads .jar files).
    for (const old of previous?.files ?? []) {
      if (old === rel) continue;
      const o = safeJoin(dir, old);
      try {
        fs.rmSync(o, { force: true });
      } catch {
        try {
          fs.renameSync(o, `${o}.old-${Date.now()}`);
        } catch {
          // stays until the game closes
        }
      }
    }
    const mod: InstalledMod = {
      id: f.id,
      name: f.name,
      version: f.version,
      icon: f.icon,
      files: [rel],
      backups: [],
      requires: f.requires.map((r) => r.id),
      explicit: f === main || previous?.explicit === true,
      installedAt: new Date().toISOString(),
    };
    record[f.id] = mod;
    added.push(mod);
  }
  return { added, already };
}

// ------------------------------------------------------------------ the CurseForge key

/** CurseForge's key: one pasted in the marketplace (kept in .scruff/curseforge.json) or CURSEFORGE_API_KEY. A pasted key wins. */
export class CurseForgeKey {
  private saved: string | null = null;

  constructor(
    private file: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    try {
      this.saved = clean(JSON.parse(fs.readFileSync(file, "utf8")).apiKey);
    } catch {
      this.saved = null;
    }
  }

  get(): string | null {
    return this.saved ?? clean(this.env.CURSEFORGE_API_KEY);
  }

  get source(): "saved" | "env" | null {
    return this.saved ? "saved" : clean(this.env.CURSEFORGE_API_KEY) ? "env" : null;
  }

  save(key: string | null): void {
    this.saved = clean(key);
    if (!this.saved) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ apiKey: this.saved }), { mode: 0o600 });
  }
}

/** Tolerates what people paste: spaces, quotes, placeholder text. */
function clean(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const k = key.trim().replace(/^["']|["']$/g, "").trim();
  if (!k || /^(your|paste|xxx|<)/i.test(k) || /\s/.test(k)) return null;
  return k;
}

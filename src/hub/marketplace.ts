import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hasMelonLoader, readManifest, removeBridge, replaceLoadedFile, safeJoin, unityFlavor } from "../games/bepinex.ts";
import type { GameProfile } from "../games/profile.ts";
import { readZip, type ZipEntry } from "../games/zip.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * The mod marketplace: other players' mods, ready to add. Mods come from Thunderstore
 * (thunderstore.io), the community mod store for Unity games: each game has its own community,
 * and every package says which mods it needs (dependencies) and is laid out for its mod loader
 * (BepInEx or MelonLoader). Telos adds a mod with everything it needs, in the layout r2modman
 * uses, and records every file it wrote (.telos-mods.json in the game folder) so removing it
 * takes out exactly that.
 *
 * Mods are other people's code: the player adds them with the Add button (the chat AI can find
 * and show mods, never install them).
 */

const API = "https://thunderstore.io";
const MANIFEST = ".telos-mods.json";
const MAX_ZIP = 400 * 1024 * 1024;
/** Downloads only come from Thunderstore and its CDN. */
const ALLOWED_HOSTS = /(^|\.)thunderstore\.io$/;
/** Thunderstore's mods are for Unity games and their loaders (BepInEx, MelonLoader); Minecraft's aren't there. */
const NOT_FOR_MINECRAFT =
  "Minecraft's mods aren't on Thunderstore: players get them from Modrinth or CurseForge, for their game and loader " +
  "version, into the mods folder. Telos can build one for you instead.";
const MOD_MANAGERS = /^(r2modman|GaleModManager|Gale|ThunderstoreModManager|r2modman_plus)$/i;
/** Package metadata, not game files. */
const META = /^(icon\.png|manifest\.json|readme\.md|changelog\.md|license(\.md|\.txt)?)$/i;

export type Loader = "bepinex" | "melonloader";

export interface Community {
  identifier: string;
  name: string;
}

export interface MarketMod {
  /** Owner-Name, Thunderstore's package id. */
  id: string;
  namespace: string;
  name: string;
  description: string;
  icon?: string;
  downloads: number;
  rating: number;
  categories: string[];
  updated: string;
  url: string;
  /** Why it may not work in this game (e.g. built for the other Unity backend). */
  warning?: string;
  /** The version Telos added, if it's in the game. */
  installed?: string;
  /** It's a mod loader itself (added automatically when a mod needs it). */
  loader?: Loader;
}

export interface InstalledMod {
  id: string;
  name: string;
  version: string;
  icon?: string;
  /** Game-relative paths Telos wrote. */
  files: string[];
  /** Files of the player's that were in the way, put back on removal. */
  backups: { file: string; backup: string }[];
  /** The mods it needs (ids). */
  requires: string[];
  /** The player added it (not only as another mod's dependency). */
  explicit: boolean;
  /** It's a mod loader (BepInEx pack, MelonLoader). */
  loader?: Loader;
  /** The loader it was installed for. */
  runsOn?: Loader;
  installedAt: string;
}

interface ModManifest {
  version: 1;
  mods: Record<string, InstalledMod>;
}

/** A package version: what installing it needs. */
interface PackageVersion {
  id: string;
  version: string;
  dependencies: string[];
  downloadUrl: string;
  icon?: string;
  description?: string;
}

/** Talks to Thunderstore. `fetch` and the base URL are swappable for tests. */
export class Thunderstore {
  private communitiesCache: Community[] | null = null;
  private versions = new Map<string, PackageVersion>();

  constructor(
    private opts: { cacheDir: string; fetch?: typeof fetch; base?: string },
  ) {}

  private get base(): string {
    return this.opts.base ?? API;
  }

  private async get<T>(url: string): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(url, { headers: { "User-Agent": "Telos (game mod overlay)" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Thunderstore answered ${res.status} for ${url.replace(this.base, "")}`);
    return (await res.json()) as T;
  }

  /** Every game on Thunderstore (cached for a day on disk). */
  async communities(): Promise<Community[]> {
    if (this.communitiesCache) return this.communitiesCache;
    const file = path.join(this.opts.cacheDir, "communities.json");
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < 24 * 3600_000) {
        return (this.communitiesCache = JSON.parse(fs.readFileSync(file, "utf8")) as Community[]);
      }
    } catch {
      // not cached yet
    }
    const all: Community[] = [];
    let url: string | null = `${this.base}/api/experimental/community/`;
    for (let pages = 0; url && pages < 50; pages++) {
      const page: { results: Community[]; pagination: { next_link: string | null } } = await this.get(url);
      all.push(...page.results.map((c) => ({ identifier: c.identifier, name: c.name })));
      url = page.pagination.next_link;
    }
    all.sort((a, b) => a.name.localeCompare(b.name));
    try {
      fs.mkdirSync(this.opts.cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
    } catch {
      // works without the cache
    }
    return (this.communitiesCache = all);
  }

  /** The community for a game: by its name (or its exe's), ignoring case, punctuation and ™. */
  async matchCommunity(profile: Pick<GameProfile, "name" | "exe">): Promise<Community | null> {
    const all = await this.communities();
    const names = [profile.name, path.basename(profile.exe).replace(/\.exe$/i, "")].map(norm).filter(Boolean);
    return all.find((c) => names.includes(norm(c.name)) || names.includes(norm(c.identifier))) ?? null;
  }

  async search(community: string, query = "", page = 1): Promise<{ count: number; mods: MarketMod[] }> {
    const q = new URLSearchParams({ ordering: query ? "most-downloaded" : "most-downloaded", page: String(page) });
    if (query) q.set("q", query);
    type Row = {
      namespace: string;
      name: string;
      description: string;
      icon_url?: string;
      download_count: number;
      rating_count: number;
      categories: { name: string }[];
      last_updated: string;
      is_deprecated?: boolean;
      is_nsfw?: boolean;
    };
    const res: { count: number; results: Row[] } = await this.get(`${this.base}/api/cyberstorm/listing/${encodeURIComponent(community)}/?${q}`);
    const mods = res.results
      // Mod manager apps (r2modman, Gale) are listed as packages but aren't mods: Telos is the manager here.
      .filter((r) => !r.is_nsfw && !r.is_deprecated && !MOD_MANAGERS.test(r.name))
      .map((r) => ({
        id: `${r.namespace}-${r.name}`,
        namespace: r.namespace,
        name: r.name,
        description: r.description,
        icon: r.icon_url,
        downloads: r.download_count,
        rating: r.rating_count,
        categories: r.categories.map((c) => c.name),
        updated: r.last_updated,
        url: `https://thunderstore.io/c/${community}/p/${r.namespace}/${r.name}/`,
      }));
    return { count: res.count, mods };
  }

  /** A package's latest version, or a given one. */
  async version(id: string, version?: string): Promise<PackageVersion> {
    const key = `${id}@${version ?? "latest"}`;
    const hit = this.versions.get(key);
    if (hit) return hit;
    const { namespace, name } = splitId(id);
    type V = { version_number: string; dependencies: string[]; download_url: string; icon?: string; description?: string };
    const v: V = version
      ? await this.get(`${this.base}/api/experimental/package/${namespace}/${name}/${version}/`)
      : (await this.get<{ latest: V }>(`${this.base}/api/experimental/package/${namespace}/${name}/`)).latest;
    const pv = { id, version: v.version_number, dependencies: v.dependencies ?? [], downloadUrl: v.download_url, icon: v.icon, description: v.description };
    this.versions.set(key, pv);
    return pv;
  }

  /** A package's zip (cached on disk by name and version). */
  async download(pv: PackageVersion): Promise<Buffer> {
    const file = path.join(this.opts.cacheDir, "packages", `${pv.id}-${pv.version}.zip`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const url = new URL(pv.downloadUrl);
    if (url.protocol !== "https:" && !this.opts.base) throw new Error("Refusing a download that isn't https.");
    if (!this.opts.base && !ALLOWED_HOSTS.test(url.hostname)) throw new Error(`Refusing to download from ${url.hostname}: mods only come from Thunderstore.`);
    const res = await (this.opts.fetch ?? fetch)(url, { headers: { "User-Agent": "Telos (game mod overlay)" }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`Downloading ${pv.id} failed: ${res.status}`);
    if (!this.opts.base && res.url && !ALLOWED_HOSTS.test(new URL(res.url).hostname)) throw new Error("The download went somewhere other than Thunderstore.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP) throw new Error(`${pv.id} is too big (${Math.round(buf.length / 1e6)} MB).`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf;
  }
}

/** "BepInEx-BepInExPack-5.4.2100" → id and version. Owners and names can't contain '-'; versions can't either. */
export function parseDependency(dep: string): { id: string; version: string } {
  const parts = dep.split("-");
  if (parts.length < 3) throw new Error(`Odd dependency: ${dep}`);
  return { id: `${parts[0]}-${parts[1]}`, version: parts.slice(2).join("-") };
}

function splitId(id: string): { namespace: string; name: string } {
  const i = id.indexOf("-");
  if (i <= 0) throw new Error(`Not a Thunderstore package id: ${id}`);
  return { namespace: id.slice(0, i), name: id.slice(i + 1) };
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Which loader a package is, if it is one. */
export function loaderPackage(id: string): Loader | undefined {
  if (/^LavaGang-MelonLoader$/i.test(id)) return "melonloader";
  if (/BepInExPack/i.test(id)) return "bepinex";
  return undefined;
}

/** Which loader the game has. */
export function gameLoader(dir: string): Loader | null {
  if (hasMelonLoader(dir) || (fs.existsSync(path.join(dir, "MelonLoader")) && fs.existsSync(path.join(dir, "version.dll")))) return "melonloader";
  if (fs.existsSync(path.join(dir, "BepInEx", "core"))) return "bepinex";
  return null;
}

/** The loader a mod's files are laid out for (when its dependencies don't say). */
function layoutLoader(entries: ZipEntry[]): Loader | null {
  const names = entries.map((e) => e.name);
  if (names.some((n) => /^(Mods|UserLibs|UserData)\//.test(n))) return "melonloader";
  if (names.some((n) => /^(BepInEx|plugins|patchers|monomod)\//i.test(n))) return "bepinex";
  return null;
}

/**
 * Where each file of a package goes in the game folder (r2modman's layout): BepInEx mods into
 * BepInEx/plugins/<Owner-Name>/…, MelonLoader mods into Mods/, loaders into the game folder.
 */
export function placeFiles(id: string, entries: ZipEntry[], loader: Loader): { from: ZipEntry; to: string }[] {
  const out: { from: ZipEntry; to: string }[] = [];
  const kind = loaderPackage(id);
  if (kind === "bepinex") {
    // The pack's files sit under a folder of their own (BepInExPack/…) next to the metadata.
    const prefix = entries.map((e) => /^(.*?)BepInEx\//.exec(e.name)?.[1]).find((p) => p !== undefined) ?? "";
    for (const e of entries) if (e.name.startsWith(prefix) && !META.test(e.name)) out.push({ from: e, to: e.name.slice(prefix.length) });
    return out.filter((f) => f.to);
  }
  if (kind === "melonloader") {
    for (const e of entries) if (!META.test(e.name)) out.push({ from: e, to: e.name });
    return out;
  }
  for (const e of entries) {
    const n = e.name;
    if (META.test(n)) continue;
    if (loader === "melonloader") {
      const m = /^(mods|plugins|userlibs|userdata)\/(.+)$/i.exec(n);
      if (m) out.push({ from: e, to: `${{ mods: "Mods", plugins: "Plugins", userlibs: "UserLibs", userdata: "UserData" }[m[1].toLowerCase() as "mods"]}/${m[2]}` });
      else if (!n.includes("/") && /\.dll$/i.test(n)) out.push({ from: e, to: `Mods/${n}` });
      else out.push({ from: e, to: `Mods/${n}` });
      continue;
    }
    const m = /^(?:bepinex\/)?(plugins|patchers|monomod|config|core)\/(.+)$/i.exec(n);
    if (m) {
      const sub = m[1].toLowerCase();
      out.push({ from: e, to: sub === "config" || sub === "core" ? `BepInEx/${sub}/${m[2]}` : `BepInEx/${sub}/${id}/${m[2]}` });
    } else {
      out.push({ from: e, to: `BepInEx/plugins/${id}/${n}` });
    }
  }
  return out;
}

export interface InstallPlan {
  id: string;
  /** Packages to add, dependencies first. */
  add: PackageVersion[];
  loader: Loader | null;
  /** What has to happen to the game's current loader first, if anything. */
  switchFrom?: { loader: Loader; reason: string };
}

export class LoaderConflict extends Error {
  constructor(
    message: string,
    readonly canSwitch: boolean,
  ) {
    super(message);
  }
}

export interface MarketplaceOptions {
  store: Thunderstore;
  profile: () => GameProfile | null;
  /** Whether the game's exe is running (switching loaders needs it closed). */
  isRunning?: (exe: string) => Promise<boolean>;
}

/** The Marketplace window's state, and adding/removing mods in the attached game. */
export class Marketplace extends EventEmitter {
  private community: Community | null = null;
  private communityFor = "";
  private query = "";
  private results: MarketMod[] = [];
  private count = 0;
  private page = 1;
  private busy: { id: string; text: string } | null = null;
  private error: string | null = null;
  /** A loader switch waiting for the player's OK. */
  private pending: { id: string; message: string } | null = null;

  constructor(private opts: MarketplaceOptions) {
    super();
  }

  private game(): GameProfile {
    const p = this.opts.profile();
    if (!p) throw new Error("Attach to a game first: the marketplace shows mods for the game you're playing.");
    if (p.engine === "Minecraft (Java)") throw new Error(NOT_FOR_MINECRAFT);
    return p;
  }

  snapshot() {
    const p = this.opts.profile();
    const installed = p ? Object.values(readMods(p.installDir).mods) : [];
    return {
      game: p?.name ?? null,
      /** Why this game's mods aren't Thunderstore's (Minecraft), or null. */
      elsewhere: p?.engine === "Minecraft (Java)" ? NOT_FOR_MINECRAFT : null,
      community: this.communityFor === p?.installDir ? this.community : null,
      query: this.query,
      count: this.count,
      page: this.page,
      results: this.results.map((m) => this.annotate(m, p, installed)),
      installed: installed.map((m) => ({ id: m.id, name: m.name, version: m.version, explicit: m.explicit, loader: m.loader, icon: m.icon })),
      loader: p ? gameLoader(p.installDir) : null,
      busy: this.busy,
      error: this.error,
      pending: this.pending,
    };
  }

  /** Flags what won't work in this game, and what's already in it. */
  private annotate(m: MarketMod, p: GameProfile | null, installed: InstalledMod[]): MarketMod {
    const out = { ...m };
    const have = installed.find((i) => i.id === m.id);
    if (have) out.installed = have.version;
    const flavor = p ? unityFlavor(p) : null;
    const cats = m.categories.map((c) => c.toLowerCase());
    if (flavor === "il2cpp" && cats.includes("mono") && !cats.includes("il2cpp")) out.warning = "Made for the Mono version of the game; yours is IL2CPP.";
    if (flavor === "mono" && cats.includes("il2cpp") && !cats.includes("mono")) out.warning = "Made for the IL2CPP version of the game; yours is Mono.";
    if (cats.includes("modpacks")) out.warning = out.warning ?? "A modpack: it adds many mods at once.";
    const kind = loaderPackage(m.id);
    if (kind) out.loader = kind;
    return out;
  }

  /** The game's Thunderstore community: matched by name, or the one the player picked. */
  async communityOf(p: GameProfile): Promise<Community | null> {
    if (this.communityFor !== p.installDir) {
      this.community = await this.opts.store.matchCommunity(p);
      this.communityFor = p.installDir;
      this.query = "";
      this.results = [];
      this.count = 0;
    }
    return this.community;
  }

  async setCommunity(identifier: string): Promise<void> {
    const p = this.game();
    const c = (await this.opts.store.communities()).find((x) => x.identifier === identifier);
    if (!c) throw new Error(`No Thunderstore community called ${identifier}.`);
    this.community = c;
    this.communityFor = p.installDir;
    await this.search("");
  }

  async communities(): Promise<Community[]> {
    return this.opts.store.communities();
  }

  /** page > 1 adds the next page to the results ("more"). */
  async search(query = this.query, page = 1): Promise<MarketMod[]> {
    if (this.opts.profile()?.engine === "Minecraft (Java)") {
      this.results = [];
      this.count = 0;
      this.error = NOT_FOR_MINECRAFT;
      this.emit("update");
      return [];
    }
    const p = this.game();
    this.error = null;
    try {
      const c = await this.communityOf(p);
      if (!c) {
        this.results = [];
        this.count = 0;
        this.error = `${p.name} has no community on Thunderstore yet. Pick the game from the list if it's there under another name, or ask Telos to build a mod.`;
        return [];
      }
      this.query = query.trim();
      const res = await this.opts.store.search(c.identifier, this.query, page);
      this.results = page > 1 ? [...this.results, ...res.mods.filter((m) => !this.results.some((r) => r.id === m.id))] : res.mods;
      this.count = res.count;
      this.page = page;
      return this.snapshot().results;
    } catch (err) {
      this.error = `Couldn't reach Thunderstore: ${(err as Error).message}`;
      throw new Error(this.error);
    } finally {
      this.emit("update");
    }
  }

  /** What adding a mod involves: its dependencies, its loader, and any clash with the game's loader. */
  async plan(id: string): Promise<InstallPlan> {
    const p = this.game();
    const installed = readMods(p.installDir).mods;
    const have = gameLoader(p.installDir);
    const add: PackageVersion[] = [];
    const seen = new Set<string>();
    // The loader the mod runs on: from its dependencies (a loader package, or a mod already in that runs on one).
    let needs: Loader | null = loaderPackage(id) ?? null;
    const visit = async (pkgId: string, version?: string, depth = 0): Promise<void> => {
      if (seen.has(pkgId) || depth > 12) return;
      seen.add(pkgId);
      if (pkgId !== id) {
        const kind = loaderPackage(pkgId);
        if (kind) {
          needs ??= kind;
          if (have === kind || installed[pkgId]) return; // the game has it already: never put a second copy over it
        } else if (installed[pkgId]) {
          needs ??= installed[pkgId].runsOn ?? null;
          return; // already in (any version: Thunderstore mods take newer)
        }
      }
      const pv = await this.opts.store.version(pkgId, version);
      for (const d of pv.dependencies) {
        const dep = parseDependency(d);
        await visit(dep.id, dep.version, depth + 1);
      }
      add.push(pv);
    };
    await visit(id);
    const target = add.at(-1)!;
    // No loader in its dependencies: the one its files are laid out for.
    if (!needs) needs = layoutLoader(readZip(await this.opts.store.download(target)));
    const plan: InstallPlan = { id, add, loader: needs };
    if (needs && have && needs !== have) {
      const bridge = readManifest(p.installDir);
      const telosBepInEx = have === "bepinex" && Boolean(bridge?.bepinexByScruff) && onlyTelosPlugins(p.installDir);
      const reason =
        have === "bepinex"
          ? telosBepInEx
            ? `This mod runs on MelonLoader, but ${p.name} has BepInEx, which Telos added for its live bridge. The two loaders don't work together. ` +
              "Switching takes Telos's bridge and BepInEx out (memory editing still works) and adds MelonLoader."
            : `This mod runs on MelonLoader, but ${p.name}'s other mods use BepInEx. The two loaders don't work together, so Telos won't add it.`
          : `This mod runs on BepInEx, but ${p.name}'s mods use MelonLoader. The two loaders don't work together, so Telos won't add it.`;
      if (!telosBepInEx || needs !== "melonloader") throw new LoaderConflict(reason, false);
      if (!add.some((v) => loaderPackage(v.id) === "melonloader")) throw new LoaderConflict(`${reason} But this mod doesn't bring MelonLoader along, so add LavaGang-MelonLoader first.`, false);
      plan.switchFrom = { loader: have, reason };
    }
    if (needs && !have && !add.some((v) => loaderPackage(v.id) === needs)) {
      throw new Error(
        needs === "bepinex"
          ? "This mod needs BepInEx. Install Telos's bridge first (it adds BepInEx), or add the game's BepInEx pack from the marketplace."
          : "This mod needs MelonLoader: add LavaGang-MelonLoader from the marketplace first.",
      );
    }
    return plan;
  }

  /**
   * Adds a mod and everything it needs. `switchLoader`: the player OK'd taking Telos's
   * BepInEx out for a MelonLoader mod.
   */
  async install(id: string, opts: { switchLoader?: boolean } = {}): Promise<{ added: string[]; note: string }> {
    const p = this.game();
    if (this.busy) throw new Error(`Still adding ${this.busy.id}.`);
    this.busy = { id, text: "Checking what it needs…" };
    this.error = null;
    this.pending = null;
    this.emit("update");
    try {
      const plan = await this.plan(id);
      if (plan.switchFrom) {
        if (!opts.switchLoader) {
          this.pending = { id, message: plan.switchFrom.reason };
          return { added: [], note: plan.switchFrom.reason };
        }
        if (this.opts.isRunning && (await this.opts.isRunning(p.exe))) throw new Error(`Quit ${p.name} first: its loader's files are in use while it runs.`);
        removeBridge(p);
      }
      // Everything downloaded and checked before anything is written: a bad package leaves the game as it was.
      const ready: { pv: PackageVersion; entries: ZipEntry[]; loader: Loader }[] = [];
      for (const pv of plan.add) {
        this.busy = { id, text: `Downloading ${pv.id} ${pv.version}…` };
        this.emit("update");
        const entries = readZip(await this.opts.store.download(pv));
        const kind = loaderPackage(pv.id);
        const loader = kind ?? plan.loader ?? gameLoader(p.installDir) ?? layoutLoader(entries);
        if (!loader) throw new Error(`Telos can't tell how ${pv.id} is meant to be installed (no BepInEx or MelonLoader layout).`);
        checkPackage(p.installDir, pv, entries, loader);
        ready.push({ pv, entries, loader });
      }
      const record = readMods(p.installDir);
      const added: string[] = [];
      for (const { pv, entries, loader } of ready) {
        this.busy = { id, text: `Adding ${pv.id}…` };
        this.emit("update");
        record.mods[pv.id] = writePackage(p.installDir, pv, entries, loader, {
          explicit: pv.id === id || record.mods[pv.id]?.explicit === true,
          previous: record.mods[pv.id],
        });
        writeMods(p.installDir, record);
        added.push(`${pv.id} ${pv.version}`);
      }
      const running = this.opts.isRunning ? await this.opts.isRunning(p.exe).catch(() => false) : false;
      const note =
        `Added ${added.join(", ")} to ${p.name}. ` +
        (running ? "Quit the game fully and start it again to load it." : "Start the game to load it.") +
        (plan.loader === "melonloader" && plan.add.some((v) => v.id === "LavaGang-MelonLoader") ? " MelonLoader's first start takes a minute or two." : "");
      this.emit("notice", note);
      return { added, note };
    } catch (err) {
      this.error = (err as Error).message;
      throw err;
    } finally {
      this.busy = null;
      this.emit("update");
    }
  }

  /** The player's go-ahead on a pending loader switch. */
  async confirmSwitch(id: string): Promise<{ added: string[]; note: string }> {
    if (this.pending?.id !== id) throw new Error("Nothing is waiting for that.");
    return this.install(id, { switchLoader: true });
  }

  cancelPending(): void {
    this.pending = null;
    this.emit("update");
  }

  /** Takes a mod out, and the dependencies nothing else needs any more (loaders stay). */
  remove(id: string): { removed: string[]; note: string } {
    const p = this.game();
    const record = readMods(p.installDir);
    const mod = record.mods[id];
    if (!mod) throw new Error(`${id} wasn't added by Telos.`);
    mod.explicit = false;
    // Keep what the remaining mods need; the rest of what came in as dependencies goes.
    const keep = new Set<string>();
    const walk = (m: InstalledMod) => {
      if (keep.has(m.id)) return;
      keep.add(m.id);
      for (const r of m.requires) if (record.mods[r]) walk(record.mods[r]);
    };
    for (const m of Object.values(record.mods)) if (m.explicit) walk(m);
    if (keep.has(id)) {
      const users = Object.values(record.mods).filter((m) => m.requires.includes(id) && keep.has(m.id)).map((m) => m.name);
      mod.explicit = true;
      throw new Error(`${mod.name} is needed by ${users.join(", ")}: remove ${users.length > 1 ? "those" : "that"} first.`);
    }
    const removed: string[] = [];
    let locked = false;
    for (const m of Object.values(record.mods)) {
      if (keep.has(m.id) || (m.loader && m.id !== id)) continue;
      locked = removeFiles(p.installDir, m) || locked;
      delete record.mods[m.id];
      removed.push(m.id);
    }
    writeMods(p.installDir, record);
    const note =
      `Removed ${removed.join(", ")} from ${p.name}.` + (locked ? " Some files are in use by the running game; they're switched off and go when it closes." : "");
    this.emit("notice", note);
    this.emit("update");
    return { removed, note };
  }
}

/** Whether BepInEx's plugins folder holds nothing but Telos's own bridge. */
function onlyTelosPlugins(dir: string): boolean {
  try {
    return fs.readdirSync(path.join(dir, "BepInEx", "plugins")).every((f) => f === "ScruffBridge");
  } catch {
    return true;
  }
}

export function readMods(dir: string): ModManifest {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as ModManifest;
    if (m && m.mods) return m;
  } catch {
    // none yet
  }
  return { version: 1, mods: {} };
}

function writeMods(dir: string, m: ModManifest): void {
  if (!Object.keys(m.mods).length) {
    fs.rmSync(path.join(dir, MANIFEST), { force: true });
    return;
  }
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2));
}

/** Throws when a package would write anywhere it shouldn't. */
function checkPackage(dir: string, pv: PackageVersion, entries: ZipEntry[], loader: Loader): { from: ZipEntry; to: string }[] {
  // No climbing out of where a file belongs ("../"), no absolute paths: a real package never needs them.
  const odd = entries.find((e) => /(^|\/)\.\.(\/|$)/.test(e.name) || /^(\/|[a-z]:)/i.test(e.name));
  if (odd) throw new Error(`Refusing ${pv.id}: it has a file outside the game folder's layout (${odd.name}).`);
  const placed = placeFiles(pv.id, entries, loader);
  for (const f of placed) safeJoin(dir, f.to);
  return placed;
}

/** Writes one package's files into the game folder. */
function writePackage(
  dir: string,
  pv: PackageVersion,
  entries: ZipEntry[],
  loader: Loader,
  opts: { explicit: boolean; previous?: InstalledMod },
): InstalledMod {
  const placed = checkPackage(dir, pv, entries, loader);
  const kind = loaderPackage(pv.id);
  const files: string[] = [];
  const backups = [...(opts.previous?.backups ?? [])];
  const owned = new Set(opts.previous?.files ?? []);
  for (const f of placed) {
    const full = safeJoin(dir, f.to);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full) && !owned.has(f.to)) {
      // A loader pack never overwrites the game's existing loader settings.
      if (kind && /(^|\/)config\//i.test(f.to)) continue;
      const backup = `${f.to}.telos-backup`;
      if (!fs.existsSync(safeJoin(dir, backup))) {
        fs.renameSync(full, safeJoin(dir, backup));
        backups.push({ file: f.to, backup });
      }
    }
    // A DLL the running game has loaded can't be overwritten, only moved aside.
    replaceLoadedFile(full, f.from.data());
    files.push(f.to);
  }
  // Files an older version had that this one doesn't.
  for (const old of opts.previous?.files ?? []) {
    if (!files.includes(old)) removeFile(safeJoin(dir, old));
  }
  return {
    id: pv.id,
    name: splitId(pv.id).name,
    version: pv.version,
    icon: pv.icon,
    files,
    backups,
    requires: pv.dependencies.map((d) => parseDependency(d).id),
    explicit: opts.explicit,
    ...(kind ? { loader: kind } : {}),
    runsOn: loader,
    installedAt: new Date().toISOString(),
  };
}

/** Removes a mod's files and puts back what it replaced. True when some were in use. */
function removeFiles(dir: string, m: InstalledMod): boolean {
  let locked = false;
  for (const rel of m.files) locked = !removeFile(safeJoin(dir, rel)) || locked;
  for (const b of m.backups) {
    const backup = safeJoin(dir, b.backup);
    if (fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, safeJoin(dir, b.file));
      } catch {
        locked = true;
      }
    }
  }
  // Folders the mod's files were in, now empty.
  const dirs = [...new Set(m.files.map((f) => path.dirname(f)))].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    for (let cur = d; cur && cur !== "."; cur = path.dirname(cur)) {
      try {
        fs.rmdirSync(safeJoin(dir, cur));
      } catch {
        break;
      }
    }
  }
  return locked;
}

/** Deletes a file; one the running game has loaded is renamed aside (inert) instead. False if it couldn't go yet. */
function removeFile(full: string): boolean {
  try {
    fs.rmSync(full, { force: true });
    return true;
  } catch {
    try {
      fs.renameSync(full, `${full}.old-${Date.now()}`);
    } catch {
      // stays until the game closes
    }
    return false;
  }
}

/** The chat AI's side: find and show mods (the player adds them), and list what's in. */
export function marketplaceTools(market: Marketplace, profile: () => GameProfile | null): HubTool[] {
  return [
    defineTool({
      name: "find_mods",
      description:
        "Find other players' ready-made mods for the attached game on Thunderstore (the community mod store for Unity " +
        "games), most downloaded first, and show them in the overlay's Marketplace window. The player adds one with its " +
        "Add button (Telos installs it with everything it needs); you can't install mods yourself. Empty query: the most " +
        "popular mods. Prefer an existing mod over building one with build_mod.",
      input: z.object({ query: z.string().optional().describe("What the mod should do, in a few words: 'minimap', 'more money', 'bigger storage'") }),
      readOnly: true,
      async run({ query }) {
        if (!profile()) throw new Error("Attach to the game first.");
        const mods = await market.search(query ?? "");
        const s = market.snapshot();
        if (!s.community) return s.error ?? "No Thunderstore community for this game.";
        return json({
          community: s.community.name,
          found: s.count,
          mods: mods.slice(0, 8).map((m) => ({
            id: m.id,
            what: m.description,
            downloads: m.downloads,
            ...(m.installed ? { installed: m.installed } : {}),
            ...(m.warning ? { warning: m.warning } : {}),
          })),
          game_loader: s.loader,
          next: "They're in the Marketplace window (Ctrl+T). Tell the player which look right and that they add one with its Add button.",
        });
      },
    }),
    defineTool({
      name: "installed_mods",
      description: "The marketplace mods Telos has added to the attached game (and the mod loader it uses).",
      input: z.object({}),
      readOnly: true,
      run() {
        const p = profile();
        if (!p) throw new Error("Attach to the game first.");
        const mods = Object.values(readMods(p.installDir).mods);
        return json({
          loader: gameLoader(p.installDir),
          mods: mods.map((m) => ({ id: m.id, version: m.version, added_by_player: m.explicit, ...(m.loader ? { loader: m.loader } : {}) })),
        });
      },
    }),
  ];
}

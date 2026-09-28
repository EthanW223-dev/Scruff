import fs from "node:fs";
import path from "node:path";
import type { GameProfile } from "./profile.ts";
import { readZip } from "./zip.ts";

/**
 * Installs Scruff's Unity bridge into a Unity (Mono) game: BepInEx 5, the standard Unity mod
 * loader, plus bridge/ScruffBridge.dll as its plugin. Everything added is listed in a manifest
 * in the game folder, so removing it takes out exactly that and nothing the player added.
 */

const MANIFEST = ".scruff-bridge.json";
const PLUGIN_DIR = path.join("BepInEx", "plugins", "ScruffBridge");
const RELEASES = "https://api.github.com/repos/BepInEx/BepInEx/releases?per_page=40";
const FALLBACK = "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_win_{arch}_5.4.23.2.zip";

export interface BridgeState {
  /** Can this game take the bridge at all? */
  supported: boolean;
  reason?: string;
  installed: boolean;
  /** BepInEx was already there before Scruff (the player mods this game). */
  existingBepInEx?: boolean;
}

interface Manifest {
  version: 1;
  installedAt: string;
  /** Scruff put BepInEx in; removing the bridge can take it out again. */
  bepinexByScruff: boolean;
  files: string[];
  backups: { file: string; backup: string }[];
}

export function bridgeState(profile: GameProfile): BridgeState {
  const dir = profile.installDir;
  const installed = fs.existsSync(path.join(dir, PLUGIN_DIR, "ScruffBridge.dll"));
  const existing = fs.existsSync(path.join(dir, "BepInEx", "core", "BepInEx.dll"));
  if (profile.engine === "Unity (Mono)") return { supported: true, installed, existingBepInEx: existing && !manifest(dir)?.bepinexByScruff };
  if (profile.engine === "Unity (IL2CPP)") {
    return { supported: false, installed, reason: "This Unity game is built with IL2CPP, which needs BepInEx 6; the bridge supports Mono Unity games so far." };
  }
  return { supported: false, installed, reason: `The bridge is for Unity games; this one is ${profile.engine}.` };
}

/** 32- or 64-bit, from the game exe's PE header. */
export function exeArch(exe: string): "x64" | "x86" {
  const fd = fs.openSync(exe, "r");
  try {
    const head = Buffer.alloc(0x400);
    fs.readSync(fd, head, 0, head.length, 0);
    const pe = head.readUInt32LE(0x3c);
    const machine = Buffer.alloc(2);
    fs.readSync(fd, machine, 0, 2, pe + 4);
    return machine.readUInt16LE(0) === 0x14c ? "x86" : "x64";
  } finally {
    fs.closeSync(fd);
  }
}

export interface InstallOptions {
  bridgeDll: string;
  /** A BepInEx 5 zip (path or URL) instead of downloading the latest from GitHub. */
  bepinexZip?: string;
  /** Scruff's port, when it isn't 7777. */
  port?: number;
  fetch?: typeof fetch;
  onProgress?: (text: string) => void;
}

export interface InstallReport {
  installedBepInEx: boolean;
  bepinexSource?: string;
  files: number;
  next: string;
}

export async function installBridge(profile: GameProfile, opts: InstallOptions): Promise<InstallReport> {
  const state = bridgeState(profile);
  if (!state.supported) throw new Error(state.reason);
  if (!fs.existsSync(opts.bridgeDll)) throw new Error(`The bridge isn't built (${opts.bridgeDll} is missing); run npm run build:bridge.`);
  const dir = profile.installDir;
  const previous = manifest(dir);
  const record: Manifest = previous ?? { version: 1, installedAt: new Date().toISOString(), bepinexByScruff: false, files: [], backups: [] };
  const add = (rel: string, data: Buffer | string) => {
    const full = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full) && !record.files.includes(rel)) {
      // Something of the player's is in the way: keep it, restore it on removal.
      const backup = `${rel}.scruff-backup`;
      fs.renameSync(full, safeJoin(dir, backup));
      record.backups.push({ file: rel, backup });
    }
    fs.writeFileSync(full, data);
    if (!record.files.includes(rel)) record.files.push(rel);
  };

  let source: string | undefined;
  const needBepInEx = !fs.existsSync(path.join(dir, "BepInEx", "core", "BepInEx.dll"));
  try {
    if (needBepInEx) {
      const arch = exeArch(profile.exe);
      opts.onProgress?.(`Getting BepInEx (${arch})…`);
      const { zip, from } = await getBepInEx(arch, opts);
      source = from;
      const entries = readZip(zip);
      const names = entries.map((e) => e.name);
      if (!names.includes("winhttp.dll") || !names.some((n) => n.endsWith("BepInEx/core/BepInEx.dll"))) {
        throw new Error("That doesn't look like a BepInEx 5 for Windows download (no winhttp.dll / BepInEx.dll).");
      }
      for (const e of entries) safeJoin(dir, e.name); // check every path before writing any
      opts.onProgress?.("Installing BepInEx…");
      record.bepinexByScruff = true;
      for (const e of entries) add(e.name, e.data());
    }

    opts.onProgress?.("Adding the Scruff bridge…");
    add(path.join(PLUGIN_DIR, "ScruffBridge.dll").replace(/\\/g, "/"), fs.readFileSync(opts.bridgeDll));
    // Some games destroy BepInEx's manager object; hiding it keeps plugins alive. BepInEx keeps
    // settings already in the file when it fills in the rest on first start.
    const cfg = path.join(dir, "BepInEx", "config", "BepInEx.cfg");
    if (!fs.existsSync(cfg)) add("BepInEx/config/BepInEx.cfg", "[Chainloader]\n\nHideManagerGameObject = true\n");
    if (opts.port && opts.port !== 7777) {
      add("BepInEx/config/dev.scruff.bridge.cfg", `[Scruff]\n\nHubUrl = ws://127.0.0.1:${opts.port}/ws/adapter\n`);
    }
  } finally {
    // Even a half-finished install is recorded, so removing it cleans up.
    if (record.files.length) fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(record, null, 2));
  }
  return {
    installedBepInEx: needBepInEx,
    bepinexSource: source,
    files: record.files.length,
    next:
      "Restart the game (quit it fully, then start it again). The bridge loads with it and connects to Scruff by itself; " +
      "it shows up as the 'unity' game adapter.",
  };
}

async function getBepInEx(arch: "x64" | "x86", opts: InstallOptions): Promise<{ zip: Buffer; from: string }> {
  const doFetch = opts.fetch ?? fetch;
  const download = async (url: string) => {
    const res = await doFetch(url, { headers: { "User-Agent": "Scruff" } });
    if (!res.ok) throw new Error(`Downloading ${url} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const given = opts.bepinexZip ?? process.env.SCRUFF_BEPINEX_ZIP;
  if (given) return { zip: /^https?:/.test(given) ? await download(given) : fs.readFileSync(given), from: given };
  // The newest stable BepInEx 5 for this architecture.
  try {
    const res = await doFetch(RELEASES, { headers: { "User-Agent": "Scruff", Accept: "application/vnd.github+json" } });
    if (res.ok) {
      const releases = (await res.json()) as { tag_name: string; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }[];
      const wanted = new RegExp(`^BepInEx_(win_)?${arch}_5[\\d.]+\\.zip$`);
      for (const r of releases) {
        if (r.prerelease || !/^v5\./.test(r.tag_name)) continue;
        const asset = r.assets.find((a) => wanted.test(a.name));
        if (asset) return { zip: await download(asset.browser_download_url), from: asset.browser_download_url };
      }
    }
  } catch {
    // fall back below
  }
  const url = FALLBACK.replace("{arch}", arch);
  return { zip: await download(url), from: url };
}

export interface RemoveReport {
  removed: number;
  restored: number;
  keptBepInEx: boolean;
}

/** Takes out what Scruff added. BepInEx stays if Scruff didn't install it, or other mods now use it. */
export function removeBridge(profile: GameProfile): RemoveReport {
  const dir = profile.installDir;
  const record = manifest(dir);
  if (!record) {
    // Installed some other way: just the plugin.
    const plugin = path.join(dir, PLUGIN_DIR);
    if (!fs.existsSync(plugin)) throw new Error("The Scruff bridge isn't installed in this game.");
    fs.rmSync(plugin, { recursive: true, force: true });
    return { removed: 1, restored: 0, keptBepInEx: true };
  }
  const pluginsDir = path.join(dir, "BepInEx", "plugins");
  const otherPlugins = fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).some((f) => f !== "ScruffBridge");
  const keepBepInEx = !record.bepinexByScruff || otherPlugins;
  let removed = 0;
  for (const rel of record.files) {
    if (keepBepInEx && !rel.startsWith(PLUGIN_DIR.replace(/\\/g, "/")) && !rel.endsWith("dev.scruff.bridge.cfg")) continue;
    const full = safeJoin(dir, rel);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { force: true });
      removed++;
    }
  }
  let restored = 0;
  for (const b of record.backups) {
    if (keepBepInEx && !b.file.startsWith(PLUGIN_DIR.replace(/\\/g, "/"))) continue;
    const backup = safeJoin(dir, b.backup);
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, safeJoin(dir, b.file));
      restored++;
    }
  }
  fs.rmSync(path.join(dir, PLUGIN_DIR), { recursive: true, force: true });
  // BepInEx makes logs, caches and configs of its own while running: if Scruff brought it,
  // its folder goes entirely.
  if (!keepBepInEx) fs.rmSync(path.join(dir, "BepInEx"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, MANIFEST), { force: true });
  return { removed, restored, keptBepInEx: keepBepInEx };
}

function manifest(dir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

/** A path inside the game folder; zip entries like "../x" are refused. */
function safeJoin(dir: string, rel: string): string {
  const full = path.resolve(dir, rel);
  const inside = path.relative(path.resolve(dir), full);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`Refusing to write outside the game folder: ${rel}`);
  return full;
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GameProfile } from "./profile.ts";
import { readZip } from "./zip.ts";

/**
 * Installs Telos's Unity bridge into a Unity game: BepInEx, the standard Unity mod loader,
 * plus Telos's bridge as its plugin, which then connects back to Telos over a local
 * websocket (ws://127.0.0.1:{port}/ws/adapter, port from InstallOptions or 7777).
 *
 * Two Unity backends, two BepInEx builds:
 * - Unity (Mono)   -> BepInEx 5,      plugin ScruffBridge.dll       (the classic path)
 * - Unity (IL2CPP)  -> BepInEx 6 IL2CPP, plugin TelosBridge.IL2CPP.dll
 *
 * Everything added is listed in a manifest in the game folder, so removing it takes out
 * exactly that and nothing the player added.
 */

const MANIFEST = ".scruff-bridge.json";
const PLUGIN_DIR = path.join("BepInEx", "plugins", "ScruffBridge");
const RELEASES = "https://api.github.com/repos/BepInEx/BepInEx/releases?per_page=40";
const FALLBACK = "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_win_{arch}_5.4.23.2.zip";
const FALLBACK_IL2CPP =
  "https://github.com/BepInEx/BepInEx/releases/download/v6.0.0-pre.2/BepInEx-Unity.IL2CPP-win-{arch}-6.0.0-pre.2.zip";

export interface BridgeState {
  /** Can this game take the bridge at all? */
  supported: boolean;
  reason?: string;
  installed: boolean;
  /** The installed bridge differs from the one Telos ships: an update is ready. */
  outdated?: boolean;
  /** BepInEx was already there before Telos (the player mods this game). */
  existingBepInEx?: boolean;
  /** Another Unity mod loader runs this game's mods; BepInEx next to it usually breaks the game. */
  otherLoader?: "MelonLoader";
}

export interface BridgeManifest {
  version: 1;
  installedAt: string;
  /** Which bridge family this manifest belongs to. */
  bridge?: "mono" | "il2cpp" | "unreal";
  /** Telos put BepInEx in; removing the bridge can take it out again. */
  bepinexByScruff: boolean;
  files: string[];
  backups: { file: string; backup: string }[];
}

export interface InstallOptions {
  bridgeDll: string;
  /** A BepInEx zip (path or URL) instead of downloading the latest from GitHub. */
  bepinexZip?: string;
  /** Telos's port, when it isn't 7777. */
  port?: number;
  fetch?: typeof fetch;
  onProgress?: (text: string) => void;
  /** Tests: pretend the game exe is this bitness. */
  archOverride?: "x64" | "x86";
  /** True when the game's exe is running. Only matters for updates: a loaded bridge's file is locked. */
  isRunning?: (exePath: string) => Promise<boolean>;
}

export interface InstallReport {
  installedBepInEx: boolean;
  bepinexSource?: string;
  files: number;
  next: string;
}

/** Which Unity backend a profile uses, i.e. which BepInEx build and bridge DLL it needs. */
export function unityFlavor(profile: GameProfile): "mono" | "il2cpp" | null {
  if (profile.engine === "Unity (Mono)") return "mono";
  if (profile.engine === "Unity (IL2CPP)") return "il2cpp";
  return null;
}

const FLAVORS = {
  mono: {
    /** Zip entry proving this BepInEx build is present. */
    coreZipPath: "BepInEx/core/BepInEx.dll",
    coreRel: path.join("BepInEx", "core", "BepInEx.dll"),
    pluginDll: "ScruffBridge.dll",
    loader: "BepInEx 5" as const,
    notThis: "That doesn't look like a BepInEx 5 for Windows download (no winhttp.dll / BepInEx.dll).",
  },
  il2cpp: {
    coreZipPath: "BepInEx/core/BepInEx.Unity.IL2CPP.dll",
    coreRel: path.join("BepInEx", "core", "BepInEx.Unity.IL2CPP.dll"),
    pluginDll: "TelosBridge.IL2CPP.dll",
    loader: "BepInEx 6 (IL2CPP)" as const,
    notThis: "That doesn't look like a BepInEx 6 IL2CPP for Windows download (no BepInEx.Unity.IL2CPP.dll).",
  },
} as const;

/**
 * MelonLoader, the other big Unity mod loader (Mono and IL2CPP). It leaves a MelonLoader folder
 * next to the exe, plus Mods/ and UserLibs/ for its mods.
 */
export function hasMelonLoader(dir: string): boolean {
  const ml = path.join(dir, "MelonLoader");
  try {
    if (!fs.statSync(ml).isDirectory()) return false;
  } catch {
    return false;
  }
  // Its own DLL sits at the top (0.5) or under net35/ and net6/ (0.6+); a bare folder of leftovers doesn't count.
  return ["MelonLoader.dll", "net35/MelonLoader.dll", "net6/MelonLoader.dll", "net8/MelonLoader.dll"].some((f) => fs.existsSync(path.join(ml, f)));
}

const MELON_CONFLICT =
  "This game already uses MelonLoader for its mods. Adding BepInEx next to it usually stops the game from starting, " +
  "so Telos won't. Memory editing and the game's files still work. To use the bridge, remove MelonLoader (its " +
  "MelonLoader folder and version.dll) first, then install the bridge again.";

/** `bundledDll`: the bridge Telos ships, to tell whether the installed one is older. */
export function bridgeState(profile: GameProfile, bundledDll?: string): BridgeState {
  const flavor = unityFlavor(profile);
  if (!flavor) {
    return {
      supported: false,
      installed: false,
      reason: `The bridge is for Unity games; this one is ${profile.engine}.`,
    };
  }
  const dir = profile.installDir;
  const { coreRel, pluginDll } = FLAVORS[flavor];
  const plugin = path.join(dir, PLUGIN_DIR, pluginDll);
  const installed = fs.existsSync(plugin);
  const existing = fs.existsSync(path.join(dir, coreRel));
  const outdated = installed && bundledDll !== undefined && fileHash(plugin) !== fileHash(bundledDll);
  if (!existing && !installed && hasMelonLoader(dir)) {
    return { supported: false, installed: false, otherLoader: "MelonLoader", reason: MELON_CONFLICT };
  }
  return {
    supported: true,
    installed,
    ...(outdated ? { outdated } : {}),
    existingBepInEx: existing && !readManifest(dir)?.bepinexByScruff,
  };
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

/** Never let a zip entry escape the game's directory. */
export function safeJoin(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  const root = path.resolve(dir) + path.sep;
  if (abs !== path.resolve(dir) && !abs.startsWith(root)) throw new Error(`Refusing to write outside the game folder: ${rel}`);
  return abs;
}

export function fileHash(p: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

export function readManifest(dir: string): BridgeManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as BridgeManifest;
  } catch {
    return undefined;
  }
}

export function writeManifest(dir: string, m: BridgeManifest): void {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2), "utf8");
}

export async function installBridge(profile: GameProfile, opts: InstallOptions): Promise<InstallReport> {
  const flavor = unityFlavor(profile);
  if (!flavor) throw new Error(`The bridge is for Unity games; this one is ${profile.engine}.`);
  if (!fs.existsSync(opts.bridgeDll)) throw new Error(`The bridge isn't built (${opts.bridgeDll} is missing); run npm run build:bridge.`);
  const { coreZipPath, coreRel, pluginDll, loader, notThis } = FLAVORS[flavor];
  // A first install into a running game is fine: nothing new loads until the restart. Updating is
  // not: Windows locks the bridge the game has loaded, so say so up front instead of failing halfway.
  const updating = fs.existsSync(path.join(profile.installDir, PLUGIN_DIR, pluginDll));
  if (updating && opts.isRunning && (await opts.isRunning(profile.exe))) {
    throw new Error(
      `${profile.name} is running with the bridge loaded, so its file is locked. Quit the game fully: Telos updates ` +
        `the bridge by itself when the game closes (or run install_unity_bridge again then).`,
    );
  }
  const dir = profile.installDir;
  const previous = readManifest(dir);
  if (previous?.bridge && previous.bridge !== flavor) {
    throw new Error(`This game has a ${previous.bridge} bridge manifest; remove it first.`);
  }
  const record: BridgeManifest = previous ?? {
    version: 1,
    installedAt: new Date().toISOString(),
    bridge: flavor,
    bepinexByScruff: false,
    files: [],
    backups: [],
  };
  const add = (rel: string, data: Buffer | string) => {
    const full = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full) && !record.files.includes(rel)) {
      // Something of the player's is in the way: keep it, restore it on removal.
      const backup = `${rel}.scruff-backup`;
      fs.renameSync(full, safeJoin(dir, backup));
      record.backups.push({ file: rel, backup });
    }
    try {
      fs.writeFileSync(full, data);
    } catch (err) {
      // Windows keeps a loaded plugin's file locked while the game runs.
      if (["EBUSY", "EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        throw new Error(`The game has ${path.basename(rel)} open. Quit the game fully, then try again.`);
      }
      throw err;
    }
    if (!record.files.includes(rel)) record.files.push(rel);
  };

  let source: string | undefined;
  const needBepInEx = !fs.existsSync(path.join(dir, coreRel));
  if (needBepInEx) {
    if (hasMelonLoader(dir)) throw new Error(MELON_CONFLICT);
    // The wrong major version's core (BepInEx 5 in an IL2CPP game or vice versa) would
    // silently not load the bridge: fail loudly instead of installing alongside it.
    const other = flavor === "mono" ? FLAVORS.il2cpp : FLAVORS.mono;
    if (fs.existsSync(path.join(dir, other.coreRel))) {
      throw new Error(
        `This game already has ${other.loader} installed, but ${loader} is needed. ` +
          `Remove it first (or ask the player), then install the bridge again.`,
      );
    }
  }
  try {
    if (needBepInEx) {
      const arch = opts.archOverride ?? exeArch(profile.exe);
      opts.onProgress?.(`Getting ${loader} (${arch})…`);
      const { zip, from } = await getBepInEx(arch, flavor, opts);
      source = from;
      const entries = readZip(zip);
      const names = entries.map((e) => e.name);
      const hasCore = names.some((n) => n.replace(/\\/g, "/").endsWith(coreZipPath));
      const hasDoorstop = flavor === "mono" ? names.includes("winhttp.dll") : true;
      if (!hasCore || !hasDoorstop) {
        throw new Error(notThis);
      }
      for (const e of entries) safeJoin(dir, e.name); // check every path before writing any
      opts.onProgress?.(`Installing ${loader}…`);
      record.bepinexByScruff = true;
      for (const e of entries) add(e.name, e.data());
    }

    opts.onProgress?.("Adding the Telos bridge…");
    add(path.join(PLUGIN_DIR, pluginDll).replace(/\\/g, "/"), fs.readFileSync(opts.bridgeDll));
    // Some games destroy BepInEx's manager object; hiding it keeps plugins alive. BepInEx keeps
    // settings already in the file when it fills in the rest on first start.
    const cfg = path.join(dir, "BepInEx", "config", "BepInEx.cfg");
    if (!fs.existsSync(cfg)) add("BepInEx/config/BepInEx.cfg", "[Chainloader]\n\nHideManagerGameObject = true\n");
    // First run: point the bridge at Telos's port. The section name must match
    // Config.Bind("Scruff", ...) in the plugin, or the port is silently ignored.
    if (opts.port && opts.port !== 7777) {
      add("BepInEx/config/dev.scruff.bridge.cfg", `[Scruff]\n\nHubUrl = ws://127.0.0.1:${opts.port}/ws/adapter\n`);
    }
  } finally {
    // Even a half-finished install is recorded, so removing it cleans up.
    if (record.files.length) writeManifest(dir, record);
  }
  const next =
    flavor === "il2cpp"
      ? "Restart the game (quit it fully, then start it again). BepInEx 6 generates its Unity bindings on the first " +
        "start, which takes a while — that's normal. After that the bridge connects to Telos by itself; it shows up " +
        "as the 'unity' game adapter."
      : "Restart the game (quit it fully, then start it again). The bridge loads with it and connects to Telos by itself; " +
        "it shows up as the 'unity' game adapter.";
  return { installedBepInEx: needBepInEx, bepinexSource: source, files: record.files.length, next };
}

async function getBepInEx(
  arch: "x64" | "x86",
  flavor: "mono" | "il2cpp",
  opts: InstallOptions,
): Promise<{ zip: Buffer; from: string }> {
  const doFetch = opts.fetch ?? fetch;
  const download = async (url: string) => {
    const res = await doFetch(url, { headers: { "User-Agent": "Telos" } });
    if (!res.ok) throw new Error(`Downloading ${url} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const given = opts.bepinexZip ?? process.env.SCRUFF_BEPINEX_ZIP;
  if (given) return { zip: /^https?:/.test(given) ? await download(given) : fs.readFileSync(given), from: given };
  // The newest BepInEx for this backend: stable v5 for Mono, latest pre-release v6 IL2CPP build.
  try {
    const res = await doFetch(RELEASES, { headers: { "User-Agent": "Telos", Accept: "application/vnd.github+json" } });
    if (res.ok) {
      const releases = (await res.json()) as { tag_name: string; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }[];
      if (flavor === "mono") {
        const wanted = new RegExp(`^BepInEx_(win_)?${arch}_5[\\d.]+\\.zip$`);
        for (const r of releases) {
          if (r.prerelease || !/^v5\./.test(r.tag_name)) continue;
          const asset = r.assets.find((a) => wanted.test(a.name));
          if (asset) return { zip: await download(asset.browser_download_url), from: asset.browser_download_url };
        }
      } else {
        const wanted = new RegExp(`^BepInEx-Unity\\.IL2CPP-win-${arch}-6.*\\.zip$`);
        for (const r of releases) {
          if (!/^v6\./.test(r.tag_name)) continue;
          const asset = r.assets.find((a) => wanted.test(a.name));
          if (asset) return { zip: await download(asset.browser_download_url), from: asset.browser_download_url };
        }
      }
    }
  } catch {
    // fall back below
  }
  const url = (flavor === "mono" ? FALLBACK : FALLBACK_IL2CPP).replace("{arch}", arch);
  return { zip: await download(url), from: url };
}

export interface RemoveReport {
  removed: number;
  restored: number;
  keptBepInEx: boolean;
}

/** Takes out what Telos added. BepInEx stays if Telos didn't install it, or other mods now use it. */
export function removeBridge(profile: GameProfile): RemoveReport {
  const dir = profile.installDir;
  const record = readManifest(dir);
  if (record?.bridge && record.bridge !== "mono" && record.bridge !== "il2cpp") {
    throw new Error(`This game has a ${record.bridge} bridge manifest; use that bridge's removal.`);
  }
  if (!record) {
    // Installed some other way: just the plugin.
    const plugin = path.join(dir, PLUGIN_DIR);
    if (!fs.existsSync(plugin)) throw new Error("The Telos bridge isn't installed in this game.");
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
  // BepInEx makes logs, caches and configs of its own while running: if Telos brought it,
  // its folder goes entirely.
  if (!keepBepInEx) fs.rmSync(path.join(dir, "BepInEx"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, MANIFEST), { force: true });
  return { removed, restored, keptBepInEx: keepBepInEx };
}

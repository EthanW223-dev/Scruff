import fs from "node:fs";
import path from "node:path";
import { fileHash, safeJoin } from "./bepinex.ts";
import type { GameProfile } from "./profile.ts";

/**
 * Telos's RPG Maker MV/MZ bridge: bridge-rpgmaker/TelosBridge.js, an ordinary RPG Maker plugin.
 *
 * MV and MZ games are HTML5 (NW.js) and load every plugin listed in js/plugins.js, so the bridge
 * is one JavaScript file plus one entry in that list: no mod loader, nothing injected. In the
 * game it connects to Telos over a local WebSocket and registers as the "rpgmaker" adapter.
 *
 * Layout: MV keeps the game under www/ (www/js/plugins.js), MZ at the top (js/plugins.js).
 * Removing takes out the file and the entry, and leaves the player's other plugins alone.
 */

const PLUGIN = "TelosBridge";
const MANIFEST = ".telos-rpgmaker.json";

export interface RpgMakerBridgeState {
  supported: boolean;
  installed: boolean;
  outdated?: boolean;
  reason?: string;
}

export interface RpgMakerInstallOptions {
  /** The plugin Telos ships (bridge-rpgmaker/TelosBridge.js). */
  pluginJs: string;
  /** Telos's port, when it isn't 7777. */
  port?: number;
}

interface PluginEntry {
  name: string;
  status: boolean;
  description: string;
  parameters: Record<string, string>;
}

interface Manifest {
  version: 1;
  installedAt: string;
  bridge: "rpgmaker";
  /** The plugins.js as it was before Telos touched it, kept until the bridge is removed. */
  backup: string;
  files: string[];
}

/** The game's js/ folder (www/js for MV), or null when this isn't a plain MV/MZ layout. */
function jsDir(profile: GameProfile): string | null {
  for (const rel of [path.join("www", "js"), "js"]) {
    const dir = path.join(profile.installDir, rel);
    if (fs.existsSync(path.join(dir, "plugins.js"))) return dir;
  }
  return null;
}

export function rpgMakerBridgeState(profile: GameProfile, bundledJs?: string): RpgMakerBridgeState {
  if (!profile.engine.startsWith("RPG Maker")) {
    return { supported: false, installed: false, reason: `The RPG Maker bridge is for RPG Maker MV/MZ games; this one is ${profile.engine}.` };
  }
  const js = jsDir(profile);
  if (!js) {
    return {
      supported: false,
      installed: false,
      reason: "This RPG Maker game has no js/plugins.js (it may be packed into one exe), so plugins can't be added. Memory editing and its data files still work.",
    };
  }
  const file = path.join(js, "plugins", `${PLUGIN}.js`);
  const installed = fs.existsSync(file) && readPlugins(path.join(js, "plugins.js")).list.some((p) => p.name === PLUGIN);
  const outdated = installed && bundledJs !== undefined && fileHash(file) !== fileHash(bundledJs);
  return { supported: true, installed, ...(outdated ? { outdated } : {}) };
}

/**
 * js/plugins.js is `var $plugins = [ ...JSON... ];` as RPG Maker writes it. Returns the list and
 * the text around it, so writing it back keeps everything else as it was.
 */
export function readPlugins(file: string): { head: string; list: PluginEntry[]; tail: string } {
  const text = fs.readFileSync(file, "utf8");
  const at = text.search(/\$plugins\s*=/);
  const open = at < 0 ? -1 : text.indexOf("[", at);
  const close = text.lastIndexOf("]");
  if (open < 0 || close < open) throw new Error(`${file} doesn't look like an RPG Maker plugin list.`);
  let list: PluginEntry[];
  try {
    list = JSON.parse(text.slice(open, close + 1));
  } catch {
    throw new Error(`${file} isn't the plain list RPG Maker writes (it was edited by hand?), so Telos won't change it.`);
  }
  if (!Array.isArray(list)) throw new Error(`${file} doesn't hold a plugin list.`);
  return { head: text.slice(0, open), list, tail: text.slice(close + 1) };
}

function writePlugins(file: string, parts: { head: string; list: PluginEntry[]; tail: string }): void {
  // One plugin per line, the way RPG Maker writes it.
  const body = `[\n${parts.list.map((p) => JSON.stringify(p)).join(",\n")}\n]`;
  fs.writeFileSync(file, parts.head + body + parts.tail, "utf8");
}

function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

export function installRpgMakerBridge(profile: GameProfile, opts: RpgMakerInstallOptions): { files: string[]; updated: boolean; next: string } {
  const state = rpgMakerBridgeState(profile);
  if (!state.supported) throw new Error(state.reason);
  if (!fs.existsSync(opts.pluginJs)) throw new Error(`The RPG Maker bridge is missing (${opts.pluginJs}).`);
  const dir = profile.installDir;
  const js = jsDir(profile)!;
  const listFile = path.join(js, "plugins.js");
  const parts = readPlugins(listFile); // refuses a list it can't read before anything is written

  const rel = (p: string) => path.relative(dir, p).replace(/\\/g, "/");
  const manifest: Manifest = readManifest(dir) ?? {
    version: 1,
    installedAt: new Date().toISOString(),
    bridge: "rpgmaker",
    backup: `${rel(listFile)}.telos-backup`,
    files: [],
  };
  const backup = safeJoin(dir, manifest.backup);
  if (!fs.existsSync(backup)) fs.copyFileSync(listFile, backup);

  const pluginFile = safeJoin(dir, rel(path.join(js, "plugins", `${PLUGIN}.js`)));
  fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
  fs.copyFileSync(opts.pluginJs, pluginFile);
  if (!manifest.files.includes(rel(pluginFile))) manifest.files.push(rel(pluginFile));

  const previous = parts.list.find((p) => p.name === PLUGIN);
  const entry: PluginEntry = {
    name: PLUGIN,
    status: true,
    description: "Telos live bridge (added by Telos; remove it from Telos)",
    // An update without a port (after the game quit) keeps the address it had.
    parameters: {
      HubUrl: opts.port ? `ws://127.0.0.1:${opts.port}/ws/adapter` : (previous?.parameters?.HubUrl ?? "ws://127.0.0.1:7777/ws/adapter"),
    },
  };
  const updated = previous !== undefined;
  // Last in the list, so it sees the game's own plugins' changes to the classes it hooks.
  parts.list = [...parts.list.filter((p) => p.name !== PLUGIN), entry];
  writePlugins(listFile, parts);
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
  return {
    files: manifest.files,
    updated,
    next:
      "Restart the game (or press F5 in it, which reloads it). The bridge connects to Telos by itself and shows up as the " +
      "'rpgmaker' game adapter once a game is started or loaded.",
  };
}

export function removeRpgMakerBridge(profile: GameProfile): { removed: number } {
  const dir = profile.installDir;
  const js = jsDir(profile);
  const manifest = readManifest(dir);
  let removed = 0;
  if (js) {
    const listFile = path.join(js, "plugins.js");
    const parts = readPlugins(listFile);
    if (parts.list.some((p) => p.name === PLUGIN)) {
      // The player's current list minus Telos's entry: plugins they added or changed since stay as they are.
      parts.list = parts.list.filter((p) => p.name !== PLUGIN);
      writePlugins(listFile, parts);
      removed++;
    }
    const pluginFile = path.join(js, "plugins", `${PLUGIN}.js`);
    if (fs.existsSync(pluginFile)) {
      fs.rmSync(pluginFile);
      removed++;
    }
  }
  if (manifest) {
    fs.rmSync(safeJoin(dir, manifest.backup), { force: true });
    fs.rmSync(path.join(dir, MANIFEST), { force: true });
  }
  if (!removed) throw new Error("The Telos bridge isn't installed in this game.");
  return { removed };
}

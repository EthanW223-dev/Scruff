import fs from "node:fs";
import path from "node:path";
import { fileHash } from "./bepinex.ts";
import type { GameProfile } from "./profile.ts";

/**
 * Telos's Unreal bridge as a UE4SS Lua mod: bridge-ue4ss/TelosBridge.
 *
 * UE4SS (github.com/UE4SS-RE/RE-UE4SS) is the Unreal community's mod loader; the player installs
 * it (Telos doesn't), and Telos only adds its mod folder and one line in mods.txt. The mod talks
 * to Telos through files in its relay/ folder (UE4SS's Lua has no network), see ue4ssrelay.ts.
 *
 * UE4SS lives next to the game's exe (Binaries/Win64): files at the top in older releases, under
 * a ue4ss/ folder in newer ones. Either way its Lua mods are in <that>/Mods.
 */

const MOD = "TelosBridge";
export const UE4SS_RELEASES = "https://github.com/UE4SS-RE/RE-UE4SS/releases";

export interface Ue4ssState {
  /** UE4SS is in the game folder. */
  present: boolean;
  installed: boolean;
  outdated?: boolean;
  modsDir?: string;
  reason?: string;
}

/** The UE4SS Mods folder of an Unreal game, or null when UE4SS isn't installed there. */
export function ue4ssModsDir(profile: GameProfile): string | null {
  const exeDir = path.dirname(profile.exe);
  for (const root of [path.join(exeDir, "ue4ss"), exeDir]) {
    const hasDll = fs.existsSync(path.join(root, "UE4SS.dll"));
    const mods = path.join(root, "Mods");
    if (hasDll && fs.existsSync(mods)) return mods;
  }
  return null;
}

export function ue4ssModDir(profile: GameProfile): string | null {
  const mods = ue4ssModsDir(profile);
  return mods && path.join(mods, MOD);
}

export function ue4ssBridgeState(profile: GameProfile, bundledMain?: string): Ue4ssState {
  if (profile.engine !== "Unreal Engine") return { present: false, installed: false, reason: `UE4SS is for Unreal Engine games; this one is ${profile.engine}.` };
  const mods = ue4ssModsDir(profile);
  if (!mods) {
    return {
      present: false,
      installed: false,
      reason:
        `UE4SS isn't in this game yet. The player can add it (${UE4SS_RELEASES}: extract the zip next to the game's ` +
        "exe in Binaries/Win64, start the game once), then Telos adds its bridge as a UE4SS mod.",
    };
  }
  const main = path.join(mods, MOD, "Scripts", "main.lua");
  const installed = fs.existsSync(main);
  const outdated = installed && bundledMain !== undefined && fileHash(main) !== fileHash(bundledMain);
  return { present: true, installed, modsDir: mods, ...(outdated ? { outdated } : {}) };
}

/** mods.txt lines are "ModName : 1"; Telos's own line is added or taken out, the rest stay as they are. */
function editModsTxt(mods: string, enable: boolean): void {
  const file = path.join(mods, "mods.txt");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => l.split(":")[0].trim() !== MOD);
  if (enable) {
    // Before UE4SS's own "Keybinds" line when there is one (its examples keep that last), else at the end.
    const at = kept.findIndex((l) => /^\s*Keybinds\s*:/.test(l));
    const line = `${MOD} : 1`;
    if (at >= 0) kept.splice(at, 0, line);
    else {
      while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
      kept.push(line, "");
    }
  }
  if (!enable && kept.length === lines.length) return;
  fs.writeFileSync(file, kept.join(eol), "utf8");
}

export function installUe4ssBridge(profile: GameProfile, opts: { modSource: string }): { files: string[]; updated: boolean; next: string } {
  const state = ue4ssBridgeState(profile);
  if (!state.present) throw new Error(state.reason);
  const source = path.join(opts.modSource, "Scripts", "main.lua");
  if (!fs.existsSync(source)) throw new Error(`The UE4SS bridge is missing (${source}).`);
  const dir = path.join(state.modsDir!, MOD);
  fs.mkdirSync(path.join(dir, "Scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "relay"), { recursive: true });
  fs.copyFileSync(source, path.join(dir, "Scripts", "main.lua"));
  // The mod finds its relay folder by this file when UE4SS doesn't say where the script is.
  fs.writeFileSync(path.join(dir, "relay", ".keep"), "Telos and its UE4SS mod talk through files here.\n");
  // Enabled through mods.txt, the documented way (not enabled.txt as well: a mod loaded twice would run every request twice).
  editModsTxt(state.modsDir!, true);
  return {
    files: [`${MOD}/Scripts/main.lua`, `${MOD}/relay/`, "mods.txt (one line)"],
    updated: state.installed,
    next:
      "Restart the game (quit it fully, start it again). UE4SS loads the Telos mod with it, and it shows up as the " +
      "'unreal' game adapter once the game is running. First use on a game is unverified: confirm one harmless change on screen.",
  };
}

export function removeUe4ssBridge(profile: GameProfile): { removed: boolean } {
  const mods = ue4ssModsDir(profile);
  const dir = mods && path.join(mods, MOD);
  if (!mods || !dir || !fs.existsSync(dir)) throw new Error("The Telos UE4SS mod isn't installed in this game.");
  fs.rmSync(dir, { recursive: true, force: true });
  editModsTxt(mods, false);
  return { removed: true };
}

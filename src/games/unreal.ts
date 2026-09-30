import fs from "node:fs";
import path from "node:path";
import type { GameProfile } from "./profile.ts";
import { BridgeManifest, fileHash, readManifest, safeJoin, writeManifest } from "./bepinex.ts";

/**
 * Telos's Unreal bridge: bridge-unreal/TelosBridgeUE.dll.
 *
 * Honest architecture: unlike Unity there is no mod loader Telos can safely install into an
 * arbitrary Unreal game, so the bridge is an injected DLL. Telos copies it next to the game and
 * writes a loader guide; the player injects it once with their own injector (the game must be
 * running, the DLL then finds GObjects by pattern and connects back to Telos). Telos never
 * injects into a process by itself.
 *
 * The DLL is compiled but UNVERIFIED against a real game: engine reflection layouts are
 * version-sensitive, so first use on any game should confirm the bridge connects and the
 * 'unreal' adapter answers before promising anything.
 */
export interface UnrealBridgeState {
  supported: boolean;
  installed: boolean;
  /** A newer Telos build ships a different bridge DLL than the one staged next to the game. */
  outdated?: boolean;
  reason?: string;
  /** A UE mod loader (UE4SS / dwmapi.dll) was spotted next to the game, or null when none. */
  loader?: string | null;
}

const BRIDGE_DIR = "TelosBridgeUE";
const DLL = "TelosBridgeUE.dll";
const GUIDE = "LOAD-THIS-FIRST.txt";

export interface UnrealInstallOptions {
  bridgeDll: string;
  /** Telos's live hub port, when it isn't the default 7777. */
  port?: number;
  /** Skip actually writing the bridge DLL (tests). */
  dryRunBridge?: boolean;
}

export interface UnrealInstallReport {
  bridgeInstalled: boolean;
  files: string[];
  arch: "x64" | "x86";
  next: string;
}

export function unrealBridgeState(profile: GameProfile, bundledDll?: string): UnrealBridgeState {
  if (profile.engine !== "Unreal Engine") {
    return {
      supported: false,
      installed: false,
      reason: `The Unreal bridge is for Unreal Engine games; this one is ${profile.engine}.`,
    };
  }
  const dll = path.join(profile.installDir, BRIDGE_DIR, DLL);
  const installed = fs.existsSync(dll);
  const outdated = installed && bundledDll !== undefined && fileHash(dll) !== fileHash(bundledDll);
  return {
    supported: true,
    installed,
    ...(outdated ? { outdated } : {}),
    ...(!installed
      ? {
          reason:
            "First real-game use is unverified — the bridge is compile-validated only. " +
            "Confirm one harmless change on screen before promising anything.",
        }
      : {}),
    loader: detectLoader(profile.installDir),
  };
}

/** Stage the bridge next to the game and hand the player the loader guide. Player agreement happens in the chat before this is called. */
export function installUnrealBridge(profile: GameProfile, opts: UnrealInstallOptions): UnrealInstallReport {
  if (profile.engine !== "Unreal Engine") {
    throw new Error(`The Unreal bridge is for Unreal Engine games; this one is ${profile.engine}.`);
  }
  const dir = profile.installDir;
  if (!fs.existsSync(dir)) throw new Error(`Game folder not found: ${dir}`);
  const previous = readManifest(dir);
  if (previous?.bridge && previous.bridge !== "unreal") {
    throw new Error(`This game has a ${previous.bridge} bridge manifest; use that bridge's install/remove.`);
  }
  if (!fs.existsSync(opts.bridgeDll)) throw new Error(`Bridge DLL not found: ${opts.bridgeDll}`);

  const outDir = path.join(dir, BRIDGE_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  if (!opts.dryRunBridge) {
    fs.writeFileSync(path.join(outDir, DLL), fs.readFileSync(opts.bridgeDll));
    files.push(`${BRIDGE_DIR}/${DLL}`);
  }
  // hub.txt: the DLL reads this on load so it always dials the right hub URL
  // (ws://127.0.0.1:{port}/ws/adapter), even on a custom port.
  const port = opts.port ?? Number(process.env.SCRUFF_PORT ?? 7777);
  fs.writeFileSync(path.join(outDir, "hub.txt"), `ws://127.0.0.1:${port}/ws/adapter\n`, "utf8");
  files.push(`${BRIDGE_DIR}/hub.txt`);
  const guide = [
    "TELOS UNREAL BRIDGE — how to load it",
    "",
    "Telos staged TelosBridgeUE.dll next to this game but did NOT inject anything.",
    "Unreal has no universal mod loader, so loading the bridge takes one manual step:",
    "",
    "1. Start the game and wait until you are in gameplay (not the launcher).",
    "2. Inject TelosBridgeUE.dll into the game's process with your injector of choice",
    "   (any standard DLL injector; the DLL does not modify the game on disk).",
    "3. Back in Telos, the bridge status turns installed and an 'unreal' adapter appears.",
    "",
    "First time on a game, treat the bridge as unverified: ask Telos to list actors and",
    "change one harmless value, and confirm the game reacts before promising anything.",
    "To remove: delete this TelosBridgeUE folder; nothing else was touched.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, GUIDE), guide, "utf8");
  files.push(`${BRIDGE_DIR}/${GUIDE}`);

  const manifest = readManifest(dir);
  const m: BridgeManifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    bridge: "unreal",
    files: [...new Set([...(manifest?.files ?? []), ...files])],
    backups: manifest?.backups ?? [],
    bepinexByScruff: manifest?.bepinexByScruff === true,
  };
  writeManifest(dir, m);

  return {
    bridgeInstalled: true,
    files,
    next: `Telos staged the bridge next to the game but did not inject anything. To load it: start the game, inject ${BRIDGE_DIR}/${DLL} into the game process with your own injector (the steps are in ${BRIDGE_DIR}/${GUIDE}), then the 'unreal' adapter appears. First use on a game is unverified — confirm one harmless change on screen before promising anything.`,
    arch: "x64",
  };
}

/** Remove everything Telos staged next to the game. */
export function removeUnrealBridge(profile: GameProfile): { removed: string[]; restored: string[] } {
  const dir = profile.installDir;
  const manifest = readManifest(dir);
  if (manifest?.bridge && manifest.bridge !== "unreal") {
    throw new Error(`This game has a ${manifest.bridge} bridge manifest; use that bridge's removal.`);
  }
  const removed: string[] = [];
  const outDir = path.join(dir, BRIDGE_DIR);
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
    removed.push(`${BRIDGE_DIR}/`);
  }
  for (const rel of manifest?.files ?? []) {
    const abs = safeJoin(dir, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
    }
  }
  try {
    fs.rmSync(path.join(dir, ".scruff-bridge.json"), { force: true });
  } catch {
    /* already gone */
  }
  return { removed, restored: [] };
}

/** Look for a UE mod loader next to the game's exe (player-installed; Telos never adds one). */
function detectLoader(installDir: string): string | null {
  const candidates = ["dwmapi.dll", "UE4SS.dll", "xinput1_3.dll", "winmm.dll"];
  const dirs = [path.join(installDir, "Binaries", "Win64"), installDir];
  for (const d of dirs) {
    for (const c of candidates) {
      try {
        if (fs.statSync(path.join(d, c)).isFile()) return c;
      } catch {
        /* not there */
      }
    }
  }
  return null;
}

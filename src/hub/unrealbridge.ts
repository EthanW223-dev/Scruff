import { z } from "zod";
import { installUnrealBridge, removeUnrealBridge, unrealBridgeState } from "../games/unreal.ts";
import { UE4SS_RELEASES, installUe4ssBridge, removeUe4ssBridge, ue4ssBridgeState } from "../games/ue4ss.ts";
import type { GameProfile } from "../games/profile.ts";
import type { AdapterRegistry } from "./adapters.ts";
import { connectedBridge } from "./bridges.ts";
import type { GameManager } from "./game.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * Tools that stage Telos's Unreal bridge next to the attached game. Unlike Unity there is
 * no mod loader Telos can install, so the bridge is an injected DLL: Telos copies it and
 * writes a loader guide, and the player injects it once with their own injector while the
 * game runs. Once injected it connects as the "unreal" game adapter: find objects, read and
 * write properties (float/int/bool/string), world time dilation.
 *
 * The bridge is compile-validated and its protocol layer is unit-tested, but it has NOT
 * been verified against a real Unreal game: first use on any game is treated as unverified.
 */

export interface UnrealBridgeOptions {
  bridgeDll: string;
  /** bridge-ue4ss/TelosBridge: the bridge as a UE4SS Lua mod (preferred when the game has UE4SS). */
  ue4ssMod: string;
  /** The hub's live port, so the staged hub.txt always points at this session. */
  port: number;
}

/** Whether an Unreal bridge is connected right now: this game's when a profile is given, else any game's. */
export function unrealBridgeConnected(adapters: AdapterRegistry, profile?: GameProfile | null): boolean {
  if (profile) return profile.engine === "Unreal Engine" && connectedBridge(profile, adapters) !== null;
  return adapters.state().some((a) => a.prefix.startsWith("unreal"));
}

export function unrealBridgeTools(games: GameManager, adapters: AdapterRegistry, opts: UnrealBridgeOptions): HubTool[] {
  const profile = () => {
    if (!games.profile) throw new Error(games.session ? "Telos couldn't find this game's files." : "Not attached to a game.");
    return games.profile;
  };

  return [
    defineTool({
      name: "unreal_bridge_status",
      readOnly: true,
      description:
        "Whether the attached game can take Telos's Unreal bridge (object search and property read/write through " +
        "engine reflection once loaded), whether it's staged, and whether it's connected.",
      input: z.object({}),
      run() {
        const p = profile();
        const state = unrealBridgeState(p, opts.bridgeDll);
        const connected = unrealBridgeConnected(adapters, p);
        const ue4ss = ue4ssBridgeState(p, `${opts.ue4ssMod}/Scripts/main.lua`);
        if (state.supported && ue4ss.present) {
          // The UE4SS mod is the way in: no injector, loads with the game like any UE4SS mod.
          return json({
            ue4ss,
            connected,
            verified: false,
            next: connected
              ? "Connected through UE4SS but UNVERIFIED on this game: confirm one harmless change on screen before promising structural mods. Use use_game_adapter with the unreal__ tools (start with unreal__player)."
              : ue4ss.outdated
                ? "A newer Telos UE4SS mod is ready: install_ue4ss_bridge updates it, then the player restarts the game."
                : ue4ss.installed
                  ? "The Telos UE4SS mod is installed but not running: the player restarts the game (quit fully, start again)."
                  : "This game has UE4SS: ask the player if they'd like the Telos mod for it (one mod folder and a line in mods.txt; restart the game), then install_ue4ss_bridge.",
          });
        }
        return json({
          ...state,
          ue4ss,
          connected,
          verified: false,
          recommended: state.supported && !connected
            ? `The easiest way in is UE4SS, the Unreal mod loader the player installs from ${UE4SS_RELEASES} (extract it next to the game's exe in Binaries/Win64); then install_ue4ss_bridge.`
            : undefined,
          next: !state.supported
            ? "Not available for this game: use memory editing and game files."
            : state.outdated
              ? "A newer bridge is ready. Ask the player to quit the game, then install_unreal_bridge to re-stage it and inject the new DLL."
              : connected
                ? "Connected but UNVERIFIED on this game: confirm one harmless property change on screen before promising structural mods. Use use_game_adapter with the unreal__ tools."
                : state.installed
                  ? "Staged but not loaded: the player needs to inject TelosBridgeUE/TelosBridgeUE.dll into the running game (steps are in TelosBridgeUE/LOAD-THIS-FIRST.txt)."
                  : "Not staged: ask the player if they'd like it (Telos copies the bridge next to the game; the player injects it once with their own injector), then install_unreal_bridge.",
        });
      },
    }),

    defineTool({
      name: "install_unreal_bridge",
      description:
        "Stage Telos's Unreal bridge next to the attached game: copies TelosBridgeUE.dll plus a loader guide the " +
        "player follows (inject the DLL into the running game with their own injector). Only after the player agreed. " +
        "Telos never injects into a process by itself. Everything staged is recorded, so remove_unreal_bridge takes " +
        "it out again.",
      input: z.object({}),
      async run(_input, ctx) {
        games.requireSession();
        ctx.progress("Staging the Unreal bridge next to the game…");
        const report = installUnrealBridge(profile(), { bridgeDll: opts.bridgeDll, port: opts.port });
        games.emit("update");
        return json(report);
      },
    }),

    defineTool({
      name: "install_ue4ss_bridge",
      description:
        "Add Telos's bridge to the attached Unreal game as a UE4SS mod (the game must already have UE4SS, which the " +
        "player installs): one mod folder and one line in mods.txt. Only after the player agreed. Restart the game " +
        "afterwards; it then connects as the 'unreal' adapter: find objects, read/change properties, call functions, " +
        "teleport, game speed, gravity, console commands.",
      input: z.object({}),
      run() {
        const report = installUe4ssBridge(profile(), { modSource: opts.ue4ssMod });
        games.emit("update");
        return json(report);
      },
    }),

    defineTool({
      name: "remove_ue4ss_bridge",
      description: "Take Telos's UE4SS mod out of the attached game (its folder and its mods.txt line); UE4SS itself stays.",
      input: z.object({}),
      run() {
        const report = removeUe4ssBridge(profile());
        games.emit("update");
        return json({ ...report, next: "Restart the game to finish." });
      },
    }),

    defineTool({
      name: "remove_unreal_bridge",
      description:
        "Remove everything Telos staged for the Unreal bridge (the TelosBridgeUE folder next to the game). " +
        "If the DLL is currently injected, the player should quit the game first.",
      input: z.object({}),
      run() {
        const report = removeUnrealBridge(profile());
        games.emit("update");
        return json({ ...report, next: "If the game is running with the bridge injected, restart it to finish." });
      },
    }),
  ];
}

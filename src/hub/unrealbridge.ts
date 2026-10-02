import { z } from "zod";
import { installUnrealBridge, removeUnrealBridge, unrealBridgeState } from "../games/unreal.ts";
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
        return json({
          ...state,
          connected,
          verified: false,
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

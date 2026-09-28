import { z } from "zod";
import { bridgeState, installBridge, removeBridge } from "../games/bepinex.ts";
import type { AdapterRegistry } from "./adapters.ts";
import type { GameManager } from "./game.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * Tools that put Scruff's Unity bridge into the attached game. Once the game restarts with it,
 * the bridge connects as the "unity" game adapter: find any object, change any field, call the
 * game's methods, recolor, resize, spawn, change gravity and time, load levels.
 */

export interface UnityBridgeOptions {
  bridgeDll: string;
  port: number;
}

/** Whether the bridge is connected right now (from any game). */
export function unityBridgeConnected(adapters: AdapterRegistry): boolean {
  return adapters.state().some((a) => a.prefix.startsWith("unity"));
}

export function unityBridgeTools(games: GameManager, adapters: AdapterRegistry, opts: UnityBridgeOptions): HubTool[] {
  const profile = () => {
    if (!games.profile) throw new Error(games.session ? "Scruff couldn't find this game's files." : "Not attached to a game.");
    return games.profile;
  };

  return [
    defineTool({
      name: "unity_bridge_status",
      readOnly: true,
      description:
        "Whether the attached game can take Scruff's Unity bridge (full live control beyond numbers: any object, field, " +
        "method, color, size, spawn, gravity, level), whether it's installed, and whether it's connected.",
      input: z.object({}),
      run() {
        const p = profile();
        const state = bridgeState(p, opts.bridgeDll);
        const connected = unityBridgeConnected(adapters);
        return json({
          ...state,
          connected,
          next: !state.supported
            ? "Not available for this game: use memory editing and game files."
            : state.outdated
              ? "A newer bridge is ready. Ask the player to quit the game, then install_unity_bridge to update it and start the game again." +
                (connected ? " The current one works meanwhile." : "")
              : connected
              ? "Connected: use use_game_adapter with the unity__ tools."
              : state.installed
                ? "Installed but not connected: the player needs to restart the game (quit fully, start again)."
                : "Not installed: ask the player if they'd like it (it adds the BepInEx mod loader to the game folder and needs a game restart), then install_unity_bridge.",
        });
      },
    }),

    defineTool({
      name: "install_unity_bridge",
      description:
        "Install Scruff's Unity bridge into the attached game's folder: the BepInEx mod loader (downloaded, unless the " +
        "game already has it) and the bridge plugin. Only after the player agreed. Everything added is recorded, so " +
        "remove_unity_bridge takes it out again. The game must be restarted afterwards.",
      input: z.object({}),
      async run(_input, ctx) {
        games.requireSession();
        const report = await installBridge(profile(), { bridgeDll: opts.bridgeDll, port: opts.port, onProgress: ctx.progress });
        games.emit("update");
        return json(report);
      },
    }),

    defineTool({
      name: "remove_unity_bridge",
      description:
        "Take Scruff's Unity bridge out of the attached game (and BepInEx too, if Scruff installed it and no other mods " +
        "use it). Takes effect when the game restarts.",
      input: z.object({}),
      run() {
        const report = removeBridge(profile());
        games.emit("update");
        return json({ ...report, next: "Restart the game to finish." });
      },
    }),
  ];
}

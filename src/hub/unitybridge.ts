import { z } from "zod";
import { bridgeState, unityFlavor, installBridge, removeBridge } from "../games/bepinex.ts";
import { listProcesses } from "../memory/platform.ts";
import type { AdapterRegistry } from "./adapters.ts";
import type { GameManager } from "./game.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * Tools that put Telos's Unity bridge into the attached game. Mono games get BepInEx 5 +
 * ScruffBridge.dll; IL2CPP games get BepInEx 6 + TelosBridge.IL2CPP.dll. Once the game
 * restarts with it, the bridge connects as the "unity" game adapter either way: find any
 * object, change any field, call the game's methods, recolor, resize, spawn, change
 * gravity and time, load levels.
 */

export interface UnityBridgeOptions {
  bridgeDll: string;
  il2cppBridgeDll: string;
  port: number;
}

/** Whether the bridge is connected right now (from any game). */
export function unityBridgeConnected(adapters: AdapterRegistry): boolean {
  return adapters.state().some((a) => a.prefix.startsWith("unity"));
}

export function unityBridgeTools(games: GameManager, adapters: AdapterRegistry, opts: UnityBridgeOptions): HubTool[] {
  const profile = () => {
    if (!games.profile) throw new Error(games.session ? "Telos couldn't find this game's files." : "Not attached to a game.");
    return games.profile;
  };

  return [
    defineTool({
      name: "unity_bridge_status",
      readOnly: true,
      description:
        "Whether the attached game can take Telos's Unity bridge (full live control beyond numbers: any object, field, " +
        "method, color, size, spawn, gravity, level), whether it's installed, and whether it's connected.",
      input: z.object({}),
      run() {
        const p = profile();
        const backend = unityFlavor(p);
        const dll = backend === "il2cpp" ? opts.il2cppBridgeDll : opts.bridgeDll;
        const state = bridgeState(p, dll);
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
                : backend === "il2cpp"
                  ? "Not installed: ask the player if they'd like it (it adds the BepInEx 6 IL2CPP mod loader to the game folder and needs a game restart; first launch takes a while generating bindings), then install_unity_bridge."
                  : "Not installed: ask the player if they'd like it (it adds the BepInEx mod loader to the game folder and needs a game restart), then install_unity_bridge.",
        });
      },
    }),

    defineTool({
      name: "install_unity_bridge",
      description:
        "Install Telos's Unity bridge into the attached game's folder: the BepInEx mod loader (downloaded, unless the " +
        "game already has it) and the bridge plugin. Only after the player agreed. Everything added is recorded, so " +
        "remove_unity_bridge takes it out again. The game must be restarted afterwards.",
      input: z.object({}),
      async run(_input, ctx) {
        games.requireSession();
        const p = profile();
        const dll = unityFlavor(p) === "il2cpp" ? opts.il2cppBridgeDll : opts.bridgeDll;
        const report = await installBridge(p, {
          bridgeDll: dll,
          port: opts.port,
          onProgress: ctx.progress,
          isRunning: async (exePath) => {
            const want = exePath.toLowerCase();
            const base = want.split(/[/\\]/).pop();
            const procs = await listProcesses().catch(() => []);
            return procs.some((pr) => {
              const have = (pr.exe ?? "").toLowerCase();
              return have === want || have.split(/[/\\]/).pop() === base;
            });
          },
        });
        games.emit("update");
        return json(report);
      },
    }),

    defineTool({
      name: "remove_unity_bridge",
      description:
        "Take Telos's Unity bridge out of the attached game (and BepInEx too, if Telos installed it and no other mods " +
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

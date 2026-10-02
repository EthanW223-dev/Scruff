import { z } from "zod";
import { installRpgMakerBridge, removeRpgMakerBridge, rpgMakerBridgeState } from "../games/rpgmaker.ts";
import type { AdapterRegistry } from "./adapters.ts";
import { connectedBridge } from "./bridges.ts";
import type { GameManager } from "./game.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * Tools that put Telos's RPG Maker bridge (one plugin file) into the attached MV/MZ game. Once
 * the game restarts with it, it connects as the "rpgmaker" adapter: gold, items, party stats,
 * switches, variables, teleporting, encounters, common events.
 */

export interface RpgMakerBridgeOptions {
  pluginJs: string;
  port: number;
}

export function rpgMakerBridgeTools(games: GameManager, adapters: AdapterRegistry, opts: RpgMakerBridgeOptions): HubTool[] {
  const profile = () => {
    if (!games.profile) throw new Error(games.session ? "Telos couldn't find this game's files." : "Not attached to a game.");
    return games.profile;
  };

  return [
    defineTool({
      name: "rpgmaker_bridge_status",
      readOnly: true,
      description:
        "Whether the attached RPG Maker MV/MZ game can take Telos's RPG Maker bridge (live gold, items, party stats, " +
        "switches, variables, teleporting, encounters), whether it's installed, and whether it's connected.",
      input: z.object({}),
      run() {
        const p = profile();
        const state = rpgMakerBridgeState(p, opts.pluginJs);
        const prefix = connectedBridge(p, adapters);
        return json({
          ...state,
          connected: prefix !== null,
          next: !state.supported
            ? state.reason
            : prefix
              ? `Connected: use use_game_adapter with the ${prefix}__ tools (start with ${prefix}__status).`
              : state.outdated
                ? "A newer bridge is ready: install_rpgmaker_bridge updates it, then the player restarts the game (or presses F5)."
                : state.installed
                  ? "Installed but not connected: the player restarts the game (or presses F5 in it), then starts or loads a game."
                  : "Not installed: ask the player if they'd like it (it adds one plugin file and one line to js/plugins.js; restart the game), then install_rpgmaker_bridge.",
        });
      },
    }),
    defineTool({
      name: "install_rpgmaker_bridge",
      description:
        "Install Telos's RPG Maker bridge into the attached MV/MZ game: one plugin file and one entry in js/plugins.js " +
        "(the player's other plugins stay as they are). Only after the player agreed. Restart the game afterwards.",
      input: z.object({}),
      run() {
        const report = installRpgMakerBridge(profile(), { pluginJs: opts.pluginJs, port: opts.port });
        games.emit("update");
        return json(report);
      },
    }),
    defineTool({
      name: "remove_rpgmaker_bridge",
      description: "Take Telos's RPG Maker bridge out of the attached game (its file and its plugins.js entry).",
      input: z.object({}),
      run() {
        const report = removeRpgMakerBridge(profile());
        games.emit("update");
        return json({ ...report, next: "Restart the game to finish." });
      },
    }),
  ];
}

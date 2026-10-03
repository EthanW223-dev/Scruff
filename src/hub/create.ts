import path from "node:path";
import { AdapterRegistry } from "./adapters.ts";
import { Agent, type Brain } from "./agent.ts";
import { GameManager, memoryTools } from "./game.ts";
import { gameFileTools } from "./gamefiles.ts";
import { describeProfile } from "../games/profile.ts";
import { JevService, JevSettings, type Jev } from "./jev.ts";
import { LinkManager, linkTools } from "./links.ts";
import { modelFileTools } from "./modelfiles.ts";
import { Ue4ssRelays } from "./ue4ssrelay.ts";
import { ue4ssModDir } from "../games/ue4ss.ts";
import fs from "node:fs";
import { McpEndpoint } from "./mcp.ts";
import { engineModSupport } from "./mods.ts";
import { quickPath } from "./quick.ts";
import type { ModelRouter } from "./models.ts";
import { ScreenBridge } from "./screen.ts";
import { startServer } from "./server.ts";
import { ThemeStore } from "./themes.ts";
import { codeVersion } from "./version.ts";
import { unityBridgeTools } from "./unitybridge.ts";
import { unrealBridgeTools } from "./unrealbridge.ts";
import { rpgMakerBridgeTools } from "./rpgmakerbridge.ts";
import { connectedBridge } from "./bridges.ts";
import { visionFromBrain, type VisionClient } from "./vision.ts";

export interface HubOptions {
  root: string;
  port: number;
  lan: boolean;
  token: string;
  /** Picks and switches models. Tests can pass a fixed brain instead. */
  router?: ModelRouter;
  brain?: Brain;
  /** Where per-game themes and downloaded models live. Defaults to <root>/.scruff. */
  dataDir?: string;
  /** Replaces the Jev client built from the TypeSafe key (tests); null turns the fast path off. */
  jev?: Jev | null;
}

export async function createHub(opts: HubOptions) {
  const games = new GameManager();
  games.bridgeDll = path.join(opts.root, "bridge", "ScruffBridge.dll");
  games.il2cppBridgeDll = path.join(opts.root, "bridge", "TelosBridge.IL2CPP.dll");
  games.unrealBridgeDll = path.join(opts.root, "bridge-unreal", "TelosBridgeUE.dll");
  games.rpgMakerBridgeJs = path.join(opts.root, "bridge-rpgmaker", "TelosBridge.js");
  games.ue4ssBridgeMain = path.join(opts.root, "bridge-ue4ss", "TelosBridge", "Scripts", "main.lua");
  const adapters = new AdapterRegistry();
  const screen = new ScreenBridge();
  const dataDir = opts.dataDir ?? path.join(opts.root, ".scruff");
  const themes = new ThemeStore(path.join(dataDir, "themes.json"), games);
  const links = new LinkManager({ file: path.join(dataDir, "links.json"), adapters, games });
  // Unreal games with Telos's UE4SS mod talk through files: a relay per game shows each as an adapter.
  const ue4ssRelays = new Ue4ssRelays(adapters);
  games.on("update", () => {
    const p = games.profile;
    const modDir = p && p.engine === "Unreal Engine" ? ue4ssModDir(p) : null;
    if (p && modDir && fs.existsSync(path.join(modDir, "Scripts", "main.lua"))) ue4ssRelays.ensure(modDir, p.name);
  });

  // Claude Code as the brain calls Telos's tools over this hub's own MCP endpoint.
  opts.router?.useHub({ mcpUrl: `http://127.0.0.1:${opts.port}/mcp`, cwd: path.join(dataDir, "claude-code") });
  const brain = opts.brain ?? opts.router?.brain();
  if (!brain) throw new Error("createHub needs a router or a brain.");
  /**
   * A fresh vision client per call, built from a fresh Brain: if the chat model is a
   * text-only local one, its blindness must not poison the agent's own provider state.
   */
  const vision = (): VisionClient | null => {
    try {
      return visionFromBrain(() => opts.router?.brain() ?? brain);
    } catch {
      return null;
    }
  };

  const statusNote = (): string => {
    const game = games.state();
    const attached = game.attached;
    return [
      attached
        ? `Attached to ${attached.name} (pid ${attached.pid}${attached.title ? `, "${attached.title}"` : ""}).`
        : game.supported.ok
          ? "Not attached to a game."
          : game.supported.reason!,
      screen.active ? "The player is sharing their screen; look_at_screen works." : "Screen sharing is off.",
      attached && games.profile ? describeProfile(games.profile) : "",
      attached ? (themes.hasSaved() ? "The overlay is already styled for this game." : "The overlay isn't styled for this game yet.") : "",
      adapters.describe(),
      links.describe(),
      attached && games.profile
        ? `Mod support: ${engineModSupport(games.profile.engine, connectedBridge(games.profile, adapters) !== null).note}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const tools = [
    ...memoryTools(games, () => ({
      screen_shared: screen.active,
      overlay_styled_for_this_game: themes.hasSaved(),
      adapters: adapters.describe(),
    })),
    ...gameFileTools(games, path.join(dataDir, "backups")),
    ...unityBridgeTools(games, adapters, {
      bridgeDll: path.join(opts.root, "bridge", "ScruffBridge.dll"),
      il2cppBridgeDll: path.join(opts.root, "bridge", "TelosBridge.IL2CPP.dll"),
      port: opts.port,
    }),
    ...unrealBridgeTools(games, adapters, {
      bridgeDll: path.join(opts.root, "bridge-unreal", "TelosBridgeUE.dll"),
      ue4ssMod: path.join(opts.root, "bridge-ue4ss", "TelosBridge"),
      port: opts.port,
    }),
    ...rpgMakerBridgeTools(games, adapters, {
      pluginJs: path.join(opts.root, "bridge-rpgmaker", "TelosBridge.js"),
      port: opts.port,
    }),
    ...screen.tools(vision),
    themes.tool(),
    adapters.dispatchTool(),
    ...linkTools(links, games, adapters),
    ...modelFileTools(),
  ];

  const jev = new JevService(new JevSettings(path.join(dataDir, "typesafe.json")), opts.jev);
  const agent = new Agent({
    brain,
    tools,
    status: () => ({ note: statusNote(), events: adapters.drainEvents().map((e) => `${e.adapter}: ${e.text}`) }),
    quick: quickPath({
      jev: () => jev.current,
      games,
      tools,
      chatReady: () => opts.router?.describe().ready ?? true,
      report: (err) => jev.report(err),
      capture: () => screen.capture(),
      vision,
    }),
  });

  const dashboardUrl = `http://localhost:${opts.port}`;
  const mcp = new McpEndpoint({ tools, dashboardUrl });

  const server = await startServer({
    port: opts.port,
    host: opts.lan ? "0.0.0.0" : "127.0.0.1",
    token: opts.token,
    root: opts.root,
    dashboardDir: path.join(opts.root, "dashboard"),
    router: opts.router,
    dataDir,
    themes,
    jev,
    agent,
    games,
    adapters,
    links,
    screen,
    mcp,
    version: codeVersion(opts.root),
  });

  return {
    agent,
    jev,
    themes,
    games,
    adapters,
    links,
    screen,
    server,
    close() {
      agent.stop();
      links.close();
      ue4ssRelays.close();
      games.detach();
      server.closeAllConnections();
      server.close();
    },
  };
}

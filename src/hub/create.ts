import path from "node:path";
import { AdapterRegistry } from "./adapters.ts";
import { Agent, type Brain } from "./agent.ts";
import { GameManager, memoryTools } from "./game.ts";
import { gameFileTools } from "./gamefiles.ts";
import { describeProfile } from "../games/profile.ts";
import { JevService, JevSettings, type Jev } from "./jev.ts";
import { McpEndpoint } from "./mcp.ts";
import { quickPath } from "./quick.ts";
import type { ModelRouter } from "./models.ts";
import { ScreenBridge } from "./screen.ts";
import { startServer } from "./server.ts";
import { ThemeStore } from "./themes.ts";
import { unityBridgeTools } from "./unitybridge.ts";

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
  const adapters = new AdapterRegistry();
  const screen = new ScreenBridge();
  const dataDir = opts.dataDir ?? path.join(opts.root, ".scruff");
  const themes = new ThemeStore(path.join(dataDir, "themes.json"), games);

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
    ...unityBridgeTools(games, adapters, { bridgeDll: path.join(opts.root, "bridge", "ScruffBridge.dll"), port: opts.port }),
    ...screen.tools(),
    themes.tool(),
    adapters.dispatchTool(),
  ];

  const brain = opts.brain ?? opts.router?.brain();
  if (!brain) throw new Error("createHub needs a router or a brain.");
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
    screen,
    mcp,
  });

  return {
    agent,
    jev,
    themes,
    games,
    adapters,
    screen,
    server,
    close() {
      agent.stop();
      games.detach();
      server.closeAllConnections();
      server.close();
    },
  };
}

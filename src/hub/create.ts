import path from "node:path";
import { AdapterRegistry } from "./adapters.ts";
import { Agent, type Brain } from "./agent.ts";
import { GameManager, memoryTools } from "./game.ts";
import { McpEndpoint } from "./mcp.ts";
import type { ModelRouter } from "./models.ts";
import { ScreenBridge } from "./screen.ts";
import { startServer } from "./server.ts";

export interface HubOptions {
  root: string;
  port: number;
  lan: boolean;
  token: string;
  /** Picks and switches models. Tests can pass a fixed brain instead. */
  router?: ModelRouter;
  brain?: Brain;
}

export async function createHub(opts: HubOptions) {
  const games = new GameManager();
  const adapters = new AdapterRegistry();
  const screen = new ScreenBridge();

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
      adapters.describe(),
    ].join("\n");
  };

  const tools = [
    ...memoryTools(games, () => ({ screen_shared: screen.active, adapters: adapters.describe() })),
    ...screen.tools(),
    adapters.dispatchTool(),
  ];

  const brain = opts.brain ?? opts.router?.brain();
  if (!brain) throw new Error("createHub needs a router or a brain.");
  const agent = new Agent({
    brain,
    tools,
    status: () => ({ note: statusNote(), events: adapters.drainEvents().map((e) => `${e.adapter}: ${e.text}`) }),
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
    agent,
    games,
    adapters,
    screen,
    mcp,
  });

  return {
    agent,
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

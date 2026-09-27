import path from "node:path";
import { AdapterRegistry } from "./adapters.ts";
import { Agent, type AgentOptions, type StreamFactory } from "./agent.ts";
import { GameManager, memoryTools } from "./game.ts";
import { ScreenBridge } from "./screen.ts";
import { startServer } from "./server.ts";

export interface HubOptions {
  root: string;
  port: number;
  lan: boolean;
  token: string;
  model: string;
  effort: AgentOptions["effort"];
  keyFound: boolean;
  createStream: StreamFactory;
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

  const agent = new Agent({
    model: opts.model,
    effort: opts.effort,
    tools: [...memoryTools(games), ...screen.tools(), adapters.dispatchTool()],
    status: () => ({ note: statusNote(), events: adapters.drainEvents().map((e) => `${e.adapter}: ${e.text}`) }),
    createStream: opts.createStream,
  });

  const server = await startServer({
    port: opts.port,
    host: opts.lan ? "0.0.0.0" : "127.0.0.1",
    token: opts.token,
    dashboardDir: path.join(opts.root, "dashboard"),
    ai: { model: opts.model, keyFound: opts.keyFound },
    agent,
    games,
    adapters,
    screen,
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

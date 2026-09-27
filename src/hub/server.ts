import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AdapterRegistry } from "./adapters.ts";
import type { Agent, AgentEvent } from "./agent.ts";
import type { GameManager } from "./game.ts";
import type { ScreenBridge } from "./screen.ts";
import { parseAddress } from "../memory/types.ts";

export interface ServerOptions {
  port: number;
  host: string;
  /** Required from anything that isn't this machine. */
  token: string;
  dashboardDir: string;
  ai: { model: string; keyFound: boolean };
  agent: Agent;
  games: GameManager;
  adapters: AdapterRegistry;
  screen: ScreenBridge;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const TRANSCRIPT_LIMIT = 3000;
const LIVE_REFRESH_MS = 500;

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Blocks two browser attacks on local servers: a random website opening a WebSocket to
 * localhost (checked via Origin) and DNS rebinding (checked via Host: only IP literals and
 * localhost are accepted, never a domain name an attacker controls).
 */
function trustedRequest(req: http.IncomingMessage, token: string): boolean {
  const host = req.headers.host ?? "";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const hostOk = hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":");
  if (!hostOk) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  if (isLoopback(req.socket.remoteAddress)) return true;
  const url = new URL(req.url ?? "/", "http://x");
  return url.searchParams.get("token") === token;
}

export function startServer(opts: ServerOptions): Promise<http.Server> {
  const { agent, games, adapters, screen } = opts;
  const dashboards = new Set<WebSocket>();
  const transcript: AgentEvent[] = [];

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const state = () => ({
    type: "state",
    game: games.state(),
    adapters: adapters.state(),
    screen: { active: screen.active },
    busy: agent.busy,
  });

  let stateQueued = false;
  const pushState = () => {
    if (stateQueued) return;
    stateQueued = true;
    setTimeout(() => {
      stateQueued = false;
      broadcast(state());
    }, 50);
  };
  games.on("update", pushState);
  adapters.on("update", pushState);
  screen.on("update", pushState);
  adapters.on("event", (event) => broadcast({ type: "game_event", event }));
  setInterval(() => {
    if (dashboards.size && games.session?.watch.size) pushState();
  }, LIVE_REFRESH_MS).unref();

  agent.on("event", (event: AgentEvent) => {
    const last = transcript.at(-1);
    // Stored with streamed deltas merged, so a dashboard that connects later gets whole messages.
    if ((event.type === "text" || event.type === "thinking") && last?.type === event.type) {
      transcript[transcript.length - 1] = { type: event.type, text: last.text + event.text };
    } else {
      transcript.push(event);
    }
    if (transcript.length > TRANSCRIPT_LIMIT) transcript.splice(0, transcript.length - TRANSCRIPT_LIMIT);
    broadcast({ type: "agent", event });
    if (event.type === "turn_start" || event.type === "turn_end") pushState();
  });

  const toast = (ws: WebSocket, text: string, level: "info" | "error" = "error") =>
    ws.send(JSON.stringify({ type: "toast", text, level }));

  async function onDashboardMessage(ws: WebSocket, msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case "chat":
        agent.send(String(msg.text ?? ""));
        break;
      case "stop":
        agent.stop();
        break;
      case "reset":
        agent.reset();
        transcript.length = 0;
        broadcast({ type: "history", events: [] });
        break;
      case "list_games":
        ws.send(JSON.stringify({ type: "games", list: await games.listGames(msg.search) }));
        break;
      case "attach": {
        const s = await games.attach(Number(msg.pid));
        toast(ws, `Attached to ${s.target.name}`, "info");
        break;
      }
      case "detach":
        games.detach();
        break;
      case "undo":
        games.requireSession().undo(msg.id ? Number(msg.id) : undefined);
        break;
      case "revert_all":
        games.requireSession().revertAll();
        break;
      case "set_value": {
        const s = games.requireSession();
        const address = parseAddress(msg.address);
        const entry = s.watch.get(address);
        if (!entry) throw new Error("That value isn't in the mod list.");
        s.write(address, entry.type, Number(msg.value), entry.label);
        break;
      }
      case "freeze": {
        const s = games.requireSession();
        const address = parseAddress(msg.address);
        const entry = s.watch.get(address);
        if (!entry) throw new Error("That value isn't in the mod list.");
        if (msg.frozen) {
          const current = s.read(address, entry.type);
          if (current === null) throw new Error("Can't read that value any more.");
          s.freeze(address, entry.type, current, entry.label);
        } else {
          s.unfreeze(address);
        }
        break;
      }
      case "unwatch":
        games.requireSession().unwatch(parseAddress(msg.address));
        break;
      case "screen":
        screen.setSharing(ws, Boolean(msg.sharing));
        break;
      case "frame":
        screen.frame(String(msg.id), msg.data, msg.error);
        break;
    }
  }

  const server = http.createServer((req, res) => {
    if (!trustedRequest(req, opts.token)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(opts.dashboardDir, rel);
    if (!file.startsWith(path.resolve(opts.dashboardDir) + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    if (!trustedRequest(req, opts.token) || (pathname !== "/ws/dashboard" && pathname !== "/ws/adapter")) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === "/ws/adapter") {
        adapters.handle(ws);
        return;
      }
      dashboards.add(ws);
      ws.send(JSON.stringify({ type: "hello", ai: opts.ai }));
      ws.send(JSON.stringify({ type: "history", events: transcript }));
      ws.send(JSON.stringify(state()));
      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        onDashboardMessage(ws, msg).catch((err) => toast(ws, (err as Error).message));
      });
      ws.on("close", () => {
        dashboards.delete(ws);
        screen.setSharing(ws, false);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}

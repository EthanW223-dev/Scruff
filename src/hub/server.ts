import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AdapterRegistry } from "./adapters.ts";
import type { LinkManager } from "./links.ts";
import { connectedBridge } from "./bridges.ts";
import { installRpgMakerBridge, removeRpgMakerBridge } from "../games/rpgmaker.ts";
import type { Agent, AgentEvent } from "./agent.ts";
import type { GameManager } from "./game.ts";
import type { JevService } from "./jev.ts";
import type { McpEndpoint } from "./mcp.ts";
import type { ModelRouter, ProviderId } from "./models.ts";
import type { ScreenBridge } from "./screen.ts";
import { transcribe } from "./speech.ts";
import { ThemeInput, type ThemeStore } from "./themes.ts";
import { parseAddress } from "../memory/types.ts";
import { installBridge, removeBridge, unityFlavor } from "../games/bepinex.ts";
import { installUnrealBridge, removeUnrealBridge } from "../games/unreal.ts";
import {
  probeVoiceEngine,
  probeVoiceEngineNow,
  sanitizeVoiceText,
  stopKokoroDaemon,
  synthesizeVoice,
  defaultVoiceFor,
  isVoiceFor,
  VoiceError,
  type TtsEngine,
} from "./voice.ts";

export interface ServerOptions {
  port: number;
  host: string;
  /** Required from anything that isn't this machine. */
  token: string;
  root: string;
  dashboardDir: string;
  dataDir: string;
  themes: ThemeStore;
  jev: JevService;
  router?: ModelRouter;
  agent: Agent;
  games: GameManager;
  adapters: AdapterRegistry;
  links: LinkManager;
  screen: ScreenBridge;
  mcp: McpEndpoint;
  /** Short git commit of the serving code; lets the overlay spot a stale hub. */
  version?: string;
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

/** How to plug Telos into a Claude app, shown in the dashboard's AI menu. */
function connectInfo(root: string, port: number) {
  const mcpUrl = `http://localhost:${port}/mcp`;
  const desktop = {
    mcpServers: {
      scruff: {
        command: "node",
        args: [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "mcp-stdio.ts")],
        ...(port !== 7777 ? { env: { SCRUFF_PORT: String(port) } } : {}),
      },
    },
  };
  return {
    mcpUrl,
    claudeCode: `claude mcp add --transport http scruff ${mcpUrl}`,
    desktopConfig: JSON.stringify(desktop, null, 2),
    desktopConfigPath:
      process.platform === "win32"
        ? "%APPDATA%\\Claude\\claude_desktop_config.json"
        : process.platform === "darwin"
          ? "~/Library/Application Support/Claude/claude_desktop_config.json"
          : "~/.config/Claude/claude_desktop_config.json",
  };
}

export async function startServer(opts: ServerOptions): Promise<http.Server> {
  const { agent, games, adapters, links, screen, mcp, router, themes, jev } = opts;
  const aiInfo = () =>
    router?.describe() ?? { provider: "custom", model: agent.brain.model, providerLabel: "Custom", ready: true, problem: undefined };
  // Keep the dashboard's voice section honest about whether edge-tts is installed.
  // Await the first probe so the first hello already carries the true state.
  await probeVoiceEngineNow();
  const probeTimer = setInterval(probeVoiceEngine, 60_000);
  probeTimer.unref?.();
  const dashboards = new Set<WebSocket>();
  const transcript: AgentEvent[] = [];

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  /** The game's state, with whether this game's own bridge is connected (others may be, for game links). */
  const gameState = () => {
    const game = games.state();
    const bridge = game.profile?.bridge;
    if (!game.profile || !bridge || !games.profile) return game;
    return { ...game, profile: { ...game.profile, bridge: { ...bridge, connected: connectedBridge(games.profile, adapters) !== null } } };
  };
  const state = () => ({
    type: "state",
    game: gameState(),
    adapters: adapters.state(),
    links: links.state(),
    screen: { active: screen.active },
    theme: themes.current(),
    jev: jev.info(),
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
  games.on("notice", (text: string) => broadcast({ type: "toast", text, level: "info" }));
  adapters.on("update", pushState);
  links.on("update", pushState);
  links.on("notice", (text: string) => broadcast({ type: "toast", text, level: "info" }));
  screen.on("update", pushState);
  themes.on("change", pushState);
  jev.on("change", pushState);
  adapters.on("event", (event) => broadcast({ type: "game_event", event }));
  setInterval(() => {
    if (dashboards.size && games.session?.watch.size) pushState();
  }, LIVE_REFRESH_MS).unref();

  const record = (event: AgentEvent) => {
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
  };
  agent.on("event", record);
  mcp.on("event", record);

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
      case "list_models":
        ws.send(
          JSON.stringify({
            type: "models",
            current: aiInfo(),
            providers: router ? await router.status() : [],
            connect: connectInfo(opts.root, (server.address() as AddressInfo).port),
          }),
        );
        break;
      case "set_model": {
        if (!router) throw new Error("This Telos can't switch models.");
        agent.setBrain(router.select({ provider: msg.provider as ProviderId, model: String(msg.model ?? "") }));
        transcript.length = 0;
        broadcast({ type: "hello", ai: aiInfo() });
        broadcast({ type: "history", events: [] });
        toast(ws, `Now using ${aiInfo().model}. Started a new chat.`, "info");
        break;
      }
      case "set_jev_key": {
        const key = typeof msg.key === "string" ? msg.key : null;
        await jev.setKey(key);
        toast(ws, key ? "Jev is on: quick commands now run instantly." : "Jev is off.", "info");
        break;
      }
      case "set_provider_key": {
        if (!router) throw new Error("This Telos can't switch models.");
        const id = String(msg.provider ?? "");
        const key = typeof msg.key === "string" ? msg.key : null;
        const baseURL = typeof msg.baseURL === "string" ? msg.baseURL : undefined;
        await router.setProviderKey(id, key, baseURL);
        toast(ws, key ? "Connected. Key saved on this PC." : "Key forgotten.", "info");
        ws.send(
          JSON.stringify({
            type: "models",
            current: aiInfo(),
            providers: await router.status(),
            connect: connectInfo(opts.root, (server.address() as AddressInfo).port),
          }),
        );
        break;
      }
      case "set_voice": {
        if (!router) throw new Error("This Telos can't change voices.");
        const voice = String(msg.voice ?? "");
        const enabled = msg.enabled !== false;
        const engine = msg.engine === "kokoro" ? "kokoro" : "edge";
        router.setVoice(voice, enabled, engine);
        toast(
          ws,
          enabled ? `Voice replies on (${voice}).` : "Voice replies off.",
          "info",
        );
        broadcast({ type: "hello", ai: aiInfo() });
        break;
      }
      case "install_bridge": {
        if (!games.profile) throw new Error("Attach to the game first.");
        const port = (server.address() as AddressInfo).port;
        const engine = games.profile.engine;
        if (engine === "Unreal Engine") {
          const report = installUnrealBridge(games.profile, {
            bridgeDll: path.join(opts.root, "bridge-unreal", "TelosBridgeUE.dll"),
            port,
          });
          games.emit("update");
          toast(ws, `Staged the Telos Unreal bridge (${report.arch}). ${report.next}`, "info");
          break;
        }
        if (engine.startsWith("RPG Maker")) {
          const report = installRpgMakerBridge(games.profile, { pluginJs: path.join(opts.root, "bridge-rpgmaker", "TelosBridge.js"), port });
          games.emit("update");
          toast(ws, `${report.updated ? "Updated" : "Installed"} the Telos bridge plugin. Restart the game (or press F5 in it) to load it.`, "info");
          break;
        }
        const flavor = unityFlavor(games.profile);
        if (!flavor) {
          throw new Error(
            `This game runs on ${engine}, which has no universal bridge — Telos can still read and change its numbers through memory editing.`,
          );
        }
        const dllName = flavor === "il2cpp" ? "TelosBridge.IL2CPP.dll" : "ScruffBridge.dll";
        const updating = fs.existsSync(path.join(games.profile.installDir, "BepInEx", "plugins", "ScruffBridge", dllName));
        const report = await installBridge(games.profile, {
          bridgeDll: path.join(opts.root, "bridge", flavor === "il2cpp" ? "TelosBridge.IL2CPP.dll" : "ScruffBridge.dll"),
          port,
          onProgress: (text) => toast(ws, text, "info"),
        });
        games.emit("update");
        toast(
          ws,
          updating
            ? "Updated the Telos bridge. Start the game again to load it."
            : `Installed${report.installedBepInEx ? " BepInEx and" : ""} the Telos bridge. Restart the game to load it.`,
          "info",
        );
        break;
      }
      case "remove_link":
        links.remove(Number(msg.id));
        break;
      case "toggle_link":
        links.setEnabled(Number(msg.id), msg.enabled !== false);
        break;
      case "remove_bridge": {
        if (!games.profile) throw new Error("Attach to the game first.");
        if (games.profile.engine === "Unreal Engine") {
          removeUnrealBridge(games.profile);
          games.emit("update");
          toast(ws, "Removed the staged Telos Unreal bridge.", "info");
          break;
        }
        if (games.profile.engine.startsWith("RPG Maker")) {
          removeRpgMakerBridge(games.profile);
          games.emit("update");
          toast(ws, "Removed the Telos bridge plugin. Restart the game to finish.", "info");
          break;
        }
        const report = removeBridge(games.profile);
        games.emit("update");
        toast(ws, `Removed the Telos bridge${report.keptBepInEx ? "" : " and BepInEx"}. Restart the game to finish.`, "info");
        break;
      }
      case "list_games":
        ws.send(JSON.stringify({ type: "games", list: await games.listGames(msg.search) }));
        break;
      case "attach": {
        const s = await games.attach(Number(msg.pid));
        const engine = games.profile?.engine;
        const tier = engine
          ? engine.startsWith("Unity")
            ? "full mods"
            : engine === "Unreal Engine"
              ? "numbers + Unreal bridge"
              : engine.startsWith("RPG Maker")
                ? "data files + RPG Maker bridge"
                : "number mods"
          : "";
        toast(ws, `Attached to ${s.target.name}${engine ? ` · ${engine}` : ""}${tier ? ` — ${tier}` : ""}`, "info");
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
      case "suggest_theme": {
        const parsed = ThemeInput.safeParse(msg.theme);
        if (parsed.success) themes.suggest(parsed.data);
        break;
      }
      case "reset_theme":
        themes.reset();
        break;
      case "voice": {
        // Push-to-talk from the overlay: 16 kHz mono 16-bit PCM, base64.
        const bytes = Buffer.from(String(msg.pcm ?? ""), "base64");
        if (bytes.length < 3200) {
          // Under 0.1 s: a mis-press, or the mic delivered nothing.
          ws.send(JSON.stringify({ type: "voice_status", text: "" }));
          toast(ws, "Didn't hear anything. Is the right microphone selected?", "info");
          break;
        }
        // Copied so the samples are 2-byte aligned whatever Buffer.from handed back.
        const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.length & ~1)));
        const status = (text: string) => ws.send(JSON.stringify({ type: "voice_status", text }));
        status("Transcribing…");
        let text: string;
        try {
          text = await transcribe(pcm, opts.dataDir, status);
        } finally {
          status("");
        }
        if (!text) {
          toast(ws, "Didn't catch that.", "info");
          break;
        }
        broadcast({ type: "transcript", text });
        agent.send(text);
        break;
      }
      case "frame":
        screen.frame(String(msg.id), msg.data, msg.error);
        break;
      default: {
        // A newer dashboard talking to an older Telos (the user pulled but didn't
        // restart it): say so out loud instead of silently dropping the message.
        const t = String(msg.type ?? "?");
        if (t !== "?") toast(ws, `Telos didn't understand "${t}" — restart Telos to pick up the latest update.`, "error");
        break;
      }
    }
  }

  const server = http.createServer((req, res) => {
    if (!trustedRequest(req, opts.token)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/mcp") {
      mcp.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500).end(String((err as Error).message));
      });
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ app: "scruff", version: opts.version ?? "unknown" }));
      return;
    }
    if (url.pathname === "/voice/say") {
      // Spoken replies: text in, audio out (cached). The dashboard streams
      // these sentence-by-sentence while the reply is still arriving.
      const clean = sanitizeVoiceText(url.searchParams.get("text") ?? "");
      if (!clean) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Nothing to say.");
        return;
      }
      const engine: TtsEngine = url.searchParams.get("engine") === "kokoro" ? "kokoro" : "edge";
      const wanted = url.searchParams.get("voice") ?? (engine === router?.voiceEngine ? router?.voice : undefined) ?? process.env.SCRUFF_VOICE ?? defaultVoiceFor(engine);
      const voice = isVoiceFor(engine, wanted) ? wanted : defaultVoiceFor(engine);
      synthesizeVoice({ text: clean, voice, engine, cacheDir: path.join(opts.dataDir, "voice") })
        .then(({ file, mime }) => {
          res.writeHead(200, { "content-type": mime, "cache-control": "public, max-age=86400" });
          fs.createReadStream(file).pipe(res);
        })
        .catch((err) => {
          const hint = err instanceof VoiceError ? err.hint : "pip install edge-tts";
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(`Voice synthesis unavailable: ${(err as Error).message}\n${hint}`);
        });
      return;
    }
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
      ws.send(JSON.stringify({ type: "hello", ai: aiInfo() }));
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
    server.once("close", () => {
      clearInterval(probeTimer);
      stopKokoroDaemon();
    });
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}

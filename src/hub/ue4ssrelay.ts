import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { AdapterRegistry } from "./adapters.ts";

/**
 * The hub's end of the UE4SS bridge. UE4SS's Lua has no network, so the mod and Telos talk
 * through files in the mod's relay/ folder:
 *
 * - alive.json    the mod rewrites it every second: its tools and recent game events
 * - request.json  Telos writes one call at a time: {key, id, tool, input}
 * - response.json the mod's answer: {key, id, ok, content | error}
 *
 * While alive.json stays fresh, the relay shows the mod to the rest of Telos as an ordinary
 * game adapter (prefix "unreal"), so the AI, the dashboard and game links use it like any bridge.
 */

const POLL_MS = 500;
const STALE_MS = 5000;
const RESPONSE_POLL_MS = 40;
const CALL_TIMEOUT_MS = 20_000;

interface RelayOptions {
  /** <UE4SS>/Mods/TelosBridge */
  modDir: string;
  gameName: string;
  adapters: AdapterRegistry;
  pollMs?: number;
  staleMs?: number;
}

/** What the registry talks to: looks like a game's WebSocket, backed by the relay files. */
class RelaySocket extends EventEmitter {
  constructor(private relay: Ue4ssRelay) {
    super();
  }
  send(data: string): void {
    const msg = JSON.parse(data);
    if (msg.type === "call") void this.relay.call(msg.id, msg.tool, msg.input);
  }
}

export class Ue4ssRelay {
  private socket: RelaySocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private session = crypto.randomBytes(4).toString("hex");
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private lastEvent = -1;
  private readonly relayDir: string;

  constructor(private opts: RelayOptions) {
    this.relayDir = path.join(opts.modDir, "relay");
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.opts.pollMs ?? POLL_MS);
    this.timer.unref();
    this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disconnect();
  }

  private alive(): { tools?: unknown; events?: unknown } | null {
    const file = path.join(this.relayDir, "alive.json");
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > (this.opts.staleMs ?? STALE_MS)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null; // not there yet, or caught mid-rename: next poll
    }
  }

  private check(): void {
    const alive = this.alive();
    if (!alive) {
      // Allow one missed beat (a long loading screen stalls the game thread) before letting go.
      if (this.socket && !this.fresh()) this.disconnect();
      return;
    }
    const events = Array.isArray(alive.events) ? (alive.events as { n: number; text: string }[]) : [];
    if (!this.socket) {
      this.socket = new RelaySocket(this);
      this.opts.adapters.handle(this.socket);
      this.socket.emit(
        "message",
        JSON.stringify({
          type: "hello",
          name: `UE4SS bridge: ${this.opts.gameName}`,
          game: "unreal",
          description:
            `Live access inside ${this.opts.gameName} through UE4SS: find objects, read and change their properties, ` +
            "call their functions, move the player, game speed and gravity, console commands.",
          tools: Array.isArray(alive.tools) ? alive.tools : [],
        }),
      );
      // Events from before Telos connected are old news.
      this.lastEvent = Math.max(-1, ...events.map((e) => e.n));
      return;
    }
    for (const e of events) {
      if (e.n <= this.lastEvent) continue;
      this.lastEvent = e.n;
      this.socket.emit("message", JSON.stringify({ type: "event", text: e.text }));
    }
  }

  private fresh(): boolean {
    try {
      return Date.now() - fs.statSync(path.join(this.relayDir, "alive.json")).mtimeMs < 2 * (this.opts.staleMs ?? STALE_MS);
    } catch {
      return false;
    }
  }

  private disconnect(): void {
    const s = this.socket;
    this.socket = null;
    s?.emit("close");
  }

  /** One call at a time: the mod answers the latest request only. */
  call(id: string, tool: string, input: unknown): Promise<void> {
    const run = async () => {
      const socket = this.socket;
      if (!socket) return;
      const key = `${this.session}:${++this.seq}`;
      let reply: Record<string, unknown>;
      try {
        reply = await this.exchange(key, { key, id, tool, input });
      } catch (err) {
        reply = { ok: false, error: (err as Error).message };
      }
      socket.emit("message", JSON.stringify({ type: "result", id, ok: reply.ok !== false, content: reply.content, error: reply.error }));
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private async exchange(key: string, request: unknown): Promise<Record<string, unknown>> {
    const file = path.join(this.relayDir, "request.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(request), "utf8");
    fs.renameSync(`${file}.tmp`, file);
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
      try {
        const reply = JSON.parse(fs.readFileSync(path.join(this.relayDir, "response.json"), "utf8"));
        if (reply.key === key) return reply;
      } catch {
        // not written yet, or mid-rename
      }
      if (!this.socket) throw new Error("The game closed.");
    }
    throw new Error(`${this.opts.gameName} didn't answer within ${CALL_TIMEOUT_MS / 1000}s (a loading screen, or the game is paused in the background?).`);
  }
}

/** One relay per game with the mod installed, kept running so linked games stay reachable. */
export class Ue4ssRelays {
  private relays = new Map<string, Ue4ssRelay>();
  constructor(private adapters: AdapterRegistry) {}

  ensure(modDir: string, gameName: string): Ue4ssRelay {
    let relay = this.relays.get(modDir);
    if (!relay) {
      relay = new Ue4ssRelay({ modDir, gameName, adapters: this.adapters });
      this.relays.set(modDir, relay);
      relay.start();
    }
    return relay;
  }

  close(): void {
    for (const r of this.relays.values()) r.stop();
    this.relays.clear();
  }
}

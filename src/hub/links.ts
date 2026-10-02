import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openBackend, processAlive } from "../memory/platform.ts";
import { TYPE_SIZE, decode, encode, hex, type ProcessBackend, type ValueType } from "../memory/types.ts";
import { norm, type AdapterRegistry, type GameEvent } from "./adapters.ts";
import type { GameManager } from "./game.ts";
import { defineTool, json, type HubTool, type ToolResultContent } from "./tools.ts";

/**
 * Game links: rules that tie games together, so something happening in one changes another.
 * "When I lose health in game A, spawn an enemy in game B", "my coins in B follow my money in A".
 *
 * A link watches one thing: an event a game's bridge reports, or a number (read through a
 * bridge, or at a memory address Telos found in a game it attached to). When it fires, it runs
 * its actions: bridge tool calls, or memory changes. Several games can be linked at once:
 * bridges stay connected side by side, and memory places stay reachable after Telos attaches
 * to another game, for as long as their game keeps running.
 */

export type Condition = "changes" | "increases" | "decreases" | "above" | "below" | "equals";

/** A place in a game's memory: only valid while that run of the game lasts (addresses move between runs). */
export interface MemoryPin {
  game: string;
  pid: number;
  address: number;
  type: ValueType;
  label: string;
}

export type Source = { kind: "bridge"; game: string; tool: string; input: Record<string, unknown> } | ({ kind: "memory" } & MemoryPin);

export type Trigger =
  | { kind: "event"; game?: string; contains: string }
  | { kind: "value"; source: Source; condition: Condition; threshold?: number };

export type Action =
  | { kind: "bridge"; game: string; tool: string; input: Record<string, unknown> }
  | ({ kind: "memory"; set?: number | string; add?: number | string } & MemoryPin);

export interface Link {
  id: number;
  description: string;
  when: Trigger;
  then: Action[];
  enabled: boolean;
  cooldownMs: number;
  fired: number;
  lastFiredAt?: number;
  lastError?: string;
}

/** What a firing knows, for {value}, {delta}, {old} and {event} in actions. */
interface Firing {
  value?: number;
  old?: number;
  delta?: number;
  event?: string;
}

const POLL_MS = 500;
/** After a link calls a game's bridge, links watching that game re-baseline for this long instead of firing (no ping-pong). */
const QUIET_MS = 1200;
const MAX_LINKS = 40;

export interface LinkOptions {
  file: string;
  adapters: AdapterRegistry;
  games: GameManager;
  /** Tests: a fake process instead of real memory. */
  openBackend?: (pid: number) => ProcessBackend;
  processAlive?: (pid: number) => boolean;
  pollMs?: number;
}

export class LinkManager extends EventEmitter {
  private links: Link[] = [];
  private nextId = 1;
  private last = new Map<number, number>();
  private polling = new Set<number>();
  private quiet = new Map<string, number>();
  private backends = new Map<number, ProcessBackend>();
  private timer: NodeJS.Timeout;
  private readonly opts: LinkOptions;

  constructor(opts: LinkOptions) {
    super();
    this.opts = opts;
    this.load();
    opts.adapters.on("event", (e: GameEvent) => void this.onEvent(e));
    opts.games.on("update", () => this.remember());
    this.timer = setInterval(() => void this.poll(), opts.pollMs ?? POLL_MS);
    this.timer.unref();
  }

  list(): Link[] {
    return this.links;
  }

  /**
   * The values on the Mods list of every game Telos attached to that is still running, the
   * attached one first: a link can join a value of the game attached now with one found
   * earlier in another game.
   */
  memoryGames(): { game: string; pid: number; values: MemoryPin[] }[] {
    this.remember();
    const alive = this.opts.processAlive ?? processAlive;
    const current = this.opts.games.session?.target.pid;
    return [...this.known.values()]
      .filter((g) => alive(g.pid))
      .sort((a, b) => Number(b.pid === current) - Number(a.pid === current));
  }

  private known = new Map<number, { game: string; pid: number; values: MemoryPin[] }>();

  private remember(): void {
    const session = this.opts.games.session;
    if (!session || session.isClosed) return;
    const game = session.target.title || session.target.name;
    const pid = session.target.pid;
    const values = [...session.watch.values()].map((w) => ({ game, pid, address: w.address, type: w.type, label: w.label }));
    const before = this.known.get(pid)?.values ?? [];
    // Values dropped from the list stay known: a link may still use them.
    const merged = [...values, ...before.filter((b) => !values.some((v) => v.address === b.address))];
    this.known.set(pid, { game, pid, values: merged });
  }

  /** Dashboard view: each link with a one-line status. */
  state() {
    return this.links.map((l) => ({
      id: l.id,
      description: l.description,
      enabled: l.enabled,
      fired: l.fired,
      lastFiredAt: l.lastFiredAt,
      problem: l.lastError,
    }));
  }

  /** Status-note text for the AI. */
  describe(): string {
    if (!this.links.length) return "";
    return (
      "Game links (list_links for details): " +
      this.links.map((l) => `#${l.id} ${l.enabled ? "" : "(paused) "}${l.description}${l.lastError ? ` [problem: ${l.lastError}]` : ""}`).join("; ")
    );
  }

  add(link: Omit<Link, "id" | "fired" | "enabled"> & { enabled?: boolean }): Link {
    if (this.links.length >= MAX_LINKS) throw new Error(`There are already ${MAX_LINKS} links; remove some first.`);
    if (!link.then.length) throw new Error("A link needs at least one thing to do.");
    const full: Link = { ...link, id: this.nextId++, fired: 0, enabled: link.enabled ?? true };
    this.links.push(full);
    this.save();
    return full;
  }

  remove(id: number): Link {
    const link = this.get(id);
    this.links = this.links.filter((l) => l !== link);
    this.last.delete(id);
    this.save();
    return link;
  }

  setEnabled(id: number, enabled: boolean): Link {
    const link = this.get(id);
    link.enabled = enabled;
    link.lastError = undefined;
    this.last.delete(id);
    this.save();
    return link;
  }

  private get(id: number): Link {
    const link = this.links.find((l) => l.id === id);
    if (!link) throw new Error(`No link #${id}. ${this.links.length ? `There are: ${this.links.map((l) => `#${l.id}`).join(", ")}.` : "There are no links."}`);
    return link;
  }

  close(): void {
    clearInterval(this.timer);
    for (const b of this.backends.values()) b.close();
    this.backends.clear();
  }

  // ------------------------------------------------------------------ firing

  private async onEvent(e: GameEvent): Promise<void> {
    for (const link of this.links) {
      const when = link.when;
      if (!link.enabled || when.kind !== "event") continue;
      if (when.game && !sameGame(when.game, e.adapter, this.opts.adapters)) continue;
      if (!e.text.toLowerCase().includes(when.contains.toLowerCase())) continue;
      if (this.cooling(link)) continue;
      // A failure is already recorded on the link and reported; other links still run.
      await this.fire(link, { event: e.text }).catch(() => undefined);
    }
  }

  /** Reads every value a link watches and fires the links whose condition just became true. */
  async poll(): Promise<void> {
    await Promise.all(
      this.links.map(async (link) => {
        const when = link.when;
        if (!link.enabled || when.kind !== "value" || this.polling.has(link.id)) return;
        this.polling.add(link.id);
        try {
          const now = await this.read(when.source);
          const before = this.last.get(link.id);
          if (now === null) return;
          // The first reading, a reading right after a link changed this game, or one during a
          // cooldown is a new baseline (cooldowns keep the old one, so the change isn't lost).
          if (before === undefined || (when.source.kind === "bridge" && this.isQuiet(`bridge:${when.source.game.toLowerCase()}`))) {
            this.last.set(link.id, now);
            return;
          }
          if (now === before || this.cooling(link)) return;
          if (!conditionMet(when.condition, before, now, when.threshold)) {
            this.last.set(link.id, now);
            return;
          }
          this.last.set(link.id, now);
          await this.fire(link, { value: now, old: before, delta: now - before });
        } catch (err) {
          this.problem(link, (err as Error).message);
        } finally {
          this.polling.delete(link.id);
        }
      }),
    );
  }

  private cooling(link: Link): boolean {
    return link.lastFiredAt !== undefined && Date.now() - link.lastFiredAt < link.cooldownMs;
  }

  private isQuiet(key: string): boolean {
    return (this.quiet.get(key) ?? 0) > Date.now();
  }

  /** Runs a link's actions now (also used by test_link). */
  async fire(link: Link, firing: Firing): Promise<string[]> {
    link.lastFiredAt = Date.now();
    link.fired++;
    const done: string[] = [];
    try {
      for (const action of link.then) {
        done.push(await this.run(action, firing));
        // A bridge can't say which values a call changed: links watching that game sit out a
        // moment instead. (Memory writes are exact: see rebase.)
        if (action.kind === "bridge") this.quiet.set(`bridge:${action.game.toLowerCase()}`, Date.now() + QUIET_MS);
      }
      link.lastError = undefined;
    } catch (err) {
      this.problem(link, (err as Error).message);
      throw err;
    } finally {
      this.emit("update");
    }
    this.emit("fired", { id: link.id, description: link.description, done });
    return done;
  }

  private problem(link: Link, message: string): void {
    if (link.lastError === message) return;
    link.lastError = message;
    this.emit("notice", `Link #${link.id} (${link.description}): ${message}`);
    this.emit("update");
  }

  private async run(action: Action, firing: Firing): Promise<string> {
    if (action.kind === "bridge") {
      const input = fill(action.input, firing) as Record<string, unknown>;
      const out = await this.opts.adapters.callTool(action.game, action.tool, input);
      return `${action.game}: ${action.tool} → ${contentText(out).slice(0, 200)}`;
    }
    const before = this.readPin(action);
    if (before === null) throw new Error(`Can't read ${action.label} in ${action.game} any more.`);
    let after: number;
    if (action.set !== undefined) after = toNumber(fill(action.set, firing), "set");
    else if (action.add !== undefined) after = before + toNumber(fill(action.add, firing), "add");
    else throw new Error(`Nothing to do to ${action.label}: give set or add.`);
    if (!Number.isFinite(after)) throw new Error(`${action.label} can't become ${after}.`);
    if (/int/.test(action.type)) after = Math.round(after);
    const session = this.opts.games.session;
    if (session && !session.isClosed && session.target.pid === action.pid) {
      // The attached game: through its session, so the change shows up in Changes and can be undone.
      session.write(action.address, action.type, after, action.label);
    } else if (!this.backend(action.pid).write(action.address, encode(after, action.type))) {
      throw new Error(`Couldn't change ${action.label} in ${action.game}.`);
    }
    this.rebase(action, after);
    return `${action.game}: ${action.label} ${before} → ${after}`;
  }

  /**
   * A link just wrote this value: links watching it take it as their new baseline, so only
   * changes beyond the link's own count. Two values mirrored both ways don't ping-pong, and
   * a real change right after a link fired still fires.
   */
  private rebase(pin: MemoryPin, value: number): void {
    for (const link of this.links) {
      const source = link.when.kind === "value" ? link.when.source : null;
      if (source?.kind === "memory" && source.pid === pin.pid && source.address === pin.address) this.last.set(link.id, value);
    }
  }

  private async read(source: Source): Promise<number | null> {
    if (source.kind === "memory") {
      const v = this.readPin(source);
      if (v === null) throw new Error(`Can't read ${source.label} in ${source.game} any more.`);
      return v;
    }
    // A bridge that isn't connected (game closed) is just waiting, not a problem.
    if (!this.opts.adapters.find(source.game)) return null;
    return numberFrom(await this.opts.adapters.callTool(source.game, source.tool, source.input));
  }

  private readPin(pin: MemoryPin): number | null {
    const alive = this.opts.processAlive ?? processAlive;
    if (!alive(pin.pid)) {
      throw new Error(
        `${pin.game} has closed. Memory places change every time a game starts, so find ${pin.label} again and remake this link.`,
      );
    }
    const session = this.opts.games.session;
    if (session && !session.isClosed && session.target.pid === pin.pid) return session.read(pin.address, pin.type);
    const buf = Buffer.alloc(TYPE_SIZE[pin.type]);
    return this.backend(pin.pid).read(pin.address, buf) === buf.length ? decode(buf, 0, pin.type) : null;
  }

  private backend(pid: number): ProcessBackend {
    let b = this.backends.get(pid);
    if (!b) {
      b = (this.opts.openBackend ?? openBackend)(pid);
      this.backends.set(pid, b);
    }
    return b;
  }

  // ------------------------------------------------------------------ storage

  private load(): void {
    try {
      const saved = JSON.parse(fs.readFileSync(this.opts.file, "utf8")) as { links?: Link[] };
      this.links = (saved.links ?? []).map((l) => ({ ...l, lastError: undefined }));
      this.nextId = Math.max(0, ...this.links.map((l) => l.id)) + 1;
    } catch {
      this.links = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      const links = this.links.map(({ lastError: _e, lastFiredAt: _t, ...l }) => l);
      fs.writeFileSync(this.opts.file, JSON.stringify({ links }, null, 2), "utf8");
    } catch (err) {
      this.emit("notice", `Couldn't save game links: ${(err as Error).message}`);
    }
    this.emit("update");
  }
}

// ------------------------------------------------------------------ helpers

export function conditionMet(condition: Condition, before: number, now: number, threshold?: number): boolean {
  const t = threshold ?? 0;
  switch (condition) {
    case "changes":
      return now !== before;
    case "increases":
      return now > before;
    case "decreases":
      return now < before;
    // Crossing, not staying: "health below 20" fires once when it drops under 20.
    case "above":
      return now > t && !(before > t);
    case "below":
      return now < t && !(before < t);
    case "equals":
      return now === t && before !== t;
  }
}

const PLACEHOLDER = /\{(value|delta|old|event)(?:\s*([*/+-])\s*(-?\d+(?:\.\d+)?))?\}/g;

/** Fills {value}, {delta}, {old}, {event} (and {delta*10}-style math) into an action's input. A lone placeholder stays a number. */
export function fill(input: unknown, firing: Firing): unknown {
  if (typeof input === "string") {
    const whole = input.trim().match(new RegExp(`^${PLACEHOLDER.source}$`));
    if (whole) return compute(whole[1], whole[2], whole[3], firing);
    return input.replace(PLACEHOLDER, (_m, name: string, op?: string, n?: string) => String(compute(name, op, n, firing)));
  }
  if (Array.isArray(input)) return input.map((v) => fill(v, firing));
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fill(v, firing)]));
  return input;
}

function compute(name: string, op: string | undefined, n: string | undefined, firing: Firing): number | string {
  const base = firing[name as keyof Firing];
  if (base === undefined) throw new Error(`{${name}} has no value here (event links have {event}; value links have {value}, {old} and {delta}).`);
  if (typeof base === "string" || !op) return base;
  const k = Number(n);
  const out = op === "*" ? base * k : op === "/" ? base / k : op === "+" ? base + k : base - k;
  return Math.round(out * 1e6) / 1e6;
}

function toNumber(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number (or {value}/{delta}/{old}), not ${JSON.stringify(v)}.`);
  return n;
}

function contentText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
}

/** The number in a bridge's reply: a bare number, or the value/after/count/amount in a JSON reply. */
export function numberFrom(content: ToolResultContent): number | null {
  const text = contentText(content).trim();
  const direct = Number(text);
  if (text !== "" && Number.isFinite(direct)) return direct;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  const dig = (v: unknown, depth: number): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === "object" && depth < 3) {
      const o = v as Record<string, unknown>;
      for (const key of ["value", "after", "amount", "count", "current"]) {
        if (key in o) {
          const n = dig(o[key], depth + 1);
          if (n !== null) return n;
        }
      }
    }
    return null;
  };
  return dig(parsed, 0);
}

function sameGame(wanted: string, adapterName: string, adapters: AdapterRegistry): boolean {
  const found = adapters.find(wanted);
  return found ? found.name === adapterName : adapterName.toLowerCase().includes(wanted.toLowerCase());
}

// ------------------------------------------------------------------ tools

const CONDITIONS = ["changes", "increases", "decreases", "above", "below", "equals"] as const;

const sideSchema = z.object({
  game: z
    .string()
    .describe(
      'Which game: a connected bridge game, by name or tool prefix (e.g. "60 Seconds", "unity2"); or, with value, ' +
        '"attached" (the game Telos is attached to) or the name of a game Telos attached to earlier that is still running.',
    ),
  tool: z.string().optional().describe("Bridge games: the bridge tool, e.g. get, set, call, spawn (as in the status note, without the prefix)."),
  input: z.record(z.string(), z.unknown()).optional().describe("Bridge games: that tool's input."),
  value: z.string().optional().describe("Memory: the label of a value on that game's Mods list (find it with find_value first)."),
});

const whenSchema = sideSchema.extend({
  event: z.string().optional().describe("Bridge games: fire when the game reports an event containing this text (e.g. 'Scene loaded')."),
  condition: z.enum(CONDITIONS).default("changes").describe("For a watched number: when it fires. above/below/equals fire once when crossing threshold."),
  threshold: z.number().optional(),
});

const thenSchema = sideSchema.extend({
  set: z.union([z.number(), z.string()]).optional().describe('Memory values: the new value, e.g. 999 or "{value}".'),
  add: z.union([z.number(), z.string()]).optional().describe('Memory values: how much to add, e.g. 5, -1, "{delta}" or "{delta*10}".'),
});

export function linkTools(links: LinkManager, _games: GameManager, adapters: AdapterRegistry): HubTool[] {
  const isAttached = (game: string) => /^(attached|memory|this game|current|current game)$/i.test(game.trim());

  /** A value on the Mods list of the attached game, or of a game attached earlier that's still running. */
  const pin = (game: string, label: string): MemoryPin => {
    const pools = links.memoryGames();
    if (!pools.length) throw new Error("Memory values need Telos attached to that game first: attach, find the value, then link.");
    const want = norm(game);
    const pool = isAttached(game)
      ? pools[0]
      : pools.find((p) => norm(p.game) === want) ?? pools.find((p) => want.length > 2 && (norm(p.game).includes(want) || want.includes(norm(p.game))));
    if (!pool) throw new Error(`Telos hasn't attached to "${game}" (or it closed). Games with values: ${pools.map((p) => p.game).join(", ")}.`);
    const l = label.toLowerCase();
    const hit = pool.values.find((v) => v.label.toLowerCase() === l) ?? pool.values.find((v) => v.label.toLowerCase().includes(l));
    if (!hit) {
      throw new Error(
        `No value called "${label}" in ${pool.game}. ` +
          (pool.values.length ? `There is: ${pool.values.map((v) => v.label).join(", ")}.` : "Find it with find_value first."),
      );
    }
    return hit;
  };

  /** A connected bridge game and one of its tools; stored by the adapter's name (prefixes depend on who connected first). */
  const bridge = (game: string, tool: string | undefined): { game: string; tool: string } => {
    const found = adapters.find(game);
    if (!found) {
      throw new Error(`No connected game called "${game}". Connected: ${adapters.state().map((a) => `${a.name} (${a.prefix})`).join(", ") || "none"}.`);
    }
    if (!tool) throw new Error(`Say which ${found.name} tool to use (tool + input).`);
    const name = tool.includes("__") ? tool.slice(tool.indexOf("__") + 2) : tool;
    const tools = adapters.state().find((a) => a.prefix === found.prefix)?.tools ?? [];
    if (!tools.includes(name)) throw new Error(`${found.name} has no tool "${name}" (it has: ${tools.join(", ")}).`);
    return { game: found.name, tool: name };
  };

  return [
    defineTool({
      name: "link_games",
      description:
        "Tie games together: when something happens in one game, change another (or the same one). Watch an event or a " +
        "number in one game (through its bridge, or a value on the Mods list found in memory), then run bridge tools or " +
        "change memory values in others. Telos can attach to game A, find a value, attach to game B, find another, and " +
        "link the two. Inputs can use {value}, {old}, {delta} (how much the watched number moved, e.g. \"{delta*10}\") and " +
        "{event}. Examples: health decreases in A → spawn an enemy in B; money in A changes → add {delta} to coins in B. " +
        "Memory values last while their game keeps running; bridge links last.",
      input: z.object({
        description: z.string().describe("What the link does, in the player's words; shown on the dashboard."),
        when: whenSchema,
        then: z.array(thenSchema).min(1).max(8),
        cooldown_seconds: z.number().min(0).max(3600).default(1).describe("Fire at most this often."),
      }),
      run({ description, when, then, cooldown_seconds }) {
        let trigger: Trigger;
        if (when.event !== undefined) {
          if (when.value) throw new Error("Events come from bridges; a memory value can't report events. Watch a value instead.");
          const found = adapters.find(when.game);
          if (!found) bridge(when.game, "x"); // throws the helpful "not connected" error
          trigger = { kind: "event", game: found!.name, contains: when.event };
        } else {
          if (["above", "below", "equals"].includes(when.condition) && when.threshold === undefined) {
            throw new Error(`"${when.condition}" needs a threshold.`);
          }
          let source: Source;
          if (when.value && !when.tool) source = { kind: "memory", ...pin(when.game, when.value) };
          else if (when.tool) source = { kind: "bridge", ...bridge(when.game, when.tool), input: when.input ?? {} };
          else throw new Error("Give event (text to wait for), tool + input (a bridge call returning the number to watch), or value (a memory value).");
          trigger = { kind: "value", source, condition: when.condition, threshold: when.threshold };
        }
        const actions: Action[] = then.map((t) => {
          if (t.value && !t.tool) {
            if (t.set === undefined && t.add === undefined) throw new Error(`Changing ${t.value} needs set or add.`);
            return { kind: "memory", ...pin(t.game, t.value), set: t.set, add: t.add };
          }
          return { kind: "bridge", ...bridge(t.game, t.tool), input: t.input ?? {} };
        });
        const link = links.add({ description, when: trigger, then: actions, cooldownMs: cooldown_seconds * 1000 });
        const memory = [trigger.kind === "value" && trigger.source.kind === "memory" ? trigger.source : null, ...actions.filter((a) => a.kind === "memory")]
          .filter((m): m is MemoryPin & { kind: "memory" } => Boolean(m))
          .map((m) => m.game);
        return json({
          created: `#${link.id}`,
          description,
          note: memory.length
            ? `Uses memory values of ${[...new Set(memory)].join(" and ")}: it works until that game closes (addresses change every run).`
            : "It runs whenever Telos is running and the games are connected.",
        });
      },
    }),
    defineTool({
      name: "list_links",
      readOnly: true,
      description: "The game links: what each watches and does, whether it's on, how often it fired, and any problem.",
      input: z.object({}),
      run() {
        const view = links.list().map((l) => ({
          id: l.id,
          description: l.description,
          on: l.enabled,
          fired: l.fired,
          problem: l.lastError,
          when: l.when.kind === "event" ? `event "${l.when.contains}" from ${l.when.game ?? "any game"}` : describeSource(l.when.source, l.when),
          then: l.then.map((a) => (a.kind === "bridge" ? `${a.game}: ${a.tool} ${JSON.stringify(a.input)}` : `${a.game}: ${a.label} ${a.set !== undefined ? `= ${a.set}` : `+= ${a.add}`}`)),
        }));
        return view.length ? json(view) : "No game links yet.";
      },
    }),
    defineTool({
      name: "remove_link",
      description: "Delete a game link for good.",
      input: z.object({ id: z.number().int() }),
      run({ id }) {
        const link = links.remove(id);
        return `Removed link #${id} (${link.description}).`;
      },
    }),
    defineTool({
      name: "pause_link",
      description: "Pause a game link (it stays saved) or turn it back on.",
      input: z.object({ id: z.number().int(), paused: z.boolean().default(true) }),
      run({ id, paused }) {
        const link = links.setEnabled(id, !paused);
        return `${paused ? "Paused" : "Resumed"} link #${id} (${link.description}).`;
      },
    }),
    defineTool({
      name: "test_link",
      description: "Run a link's actions once now, to check it works (placeholders get {value}=0, {old}=-1, {delta}=1, {event}=test).",
      input: z.object({ id: z.number().int() }),
      async run({ id }) {
        const link = links.list().find((l) => l.id === id);
        if (!link) throw new Error(`No link #${id}.`);
        const done = await links.fire(link, { value: 0, old: -1, delta: 1, event: "test" });
        return json({ ran: done });
      },
    }),
  ];
}

function describeSource(source: Source, when: { condition: Condition; threshold?: number }): string {
  const what = source.kind === "memory" ? `${source.label} in ${source.game} (memory ${hex(source.address)})` : `${source.game}: ${source.tool} ${JSON.stringify(source.input)}`;
  return `${what} ${when.condition}${when.threshold !== undefined ? ` ${when.threshold}` : ""}`;
}

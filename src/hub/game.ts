import { EventEmitter } from "node:events";
import { z } from "zod";
import { listProcesses, memorySupported, openBackend } from "../memory/platform.ts";
import { checkAttachSafety } from "../memory/safety.ts";
import { GameSession } from "../memory/session.ts";
import { VALUE_TYPES, hex, parseAddress, type ProcessInfo } from "../memory/types.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/** Background processes nobody wants to mod; hidden from the game picker. */
const NOT_GAMES = new Set(
  [
    "explorer", "chrome", "msedge", "firefox", "brave", "opera", "discord", "steam", "steamwebhelper",
    "epicgameslauncher", "code", "powershell", "windowsterminal", "cmd", "conhost", "textinputhost",
    "applicationframehost", "systemsettings", "shellexperiencehost", "searchhost", "startmenuexperiencehost",
    "spotify", "obs64", "nvidia overlay", "taskmgr", "slack", "teams", "ms-teams", "outlook",
    "bash", "zsh", "sh", "fish", "sshd", "systemd", "tmux", "dbus-daemon",
  ].map((n) => n.toLowerCase()),
);

const SEARCH_NOISE = new Set(["the", "game", "games", "playing", "exe", "and"]);

function baseName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/** Owns the attached game (if any). Emits "update" whenever the dashboard should refresh. */
export class GameManager extends EventEmitter {
  session: GameSession | null = null;
  scanProgress: number | null = null;

  async listGames(search?: string): Promise<ProcessInfo[]> {
    const all = await listProcesses();
    // Word-based, so "scruff dungeon" finds "Scruff's Dungeon" and "the witcher game" finds "witcher3.exe".
    const words = (search ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !SEARCH_NOISE.has(w));
    return all
      .filter((p) => !NOT_GAMES.has(baseName(p.name)))
      // On Windows, games have a window; searching by name also finds ones that don't.
      .filter((p) => process.platform !== "win32" || Boolean(p.title) || words.length > 0)
      .filter((p) => {
        const hay = [p.name, p.title, p.command].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 60);
  }

  async attach(pid: number): Promise<GameSession> {
    const support = memorySupported();
    if (!support.ok) throw new Error(support.reason);
    const running = await listProcesses();
    const target = running.find((p) => p.pid === pid);
    if (!target) throw new Error(`No running process with id ${pid}.`);
    const verdict = checkAttachSafety(target, running);
    if (!verdict.ok) throw new Error(verdict.reason);

    this.detach();
    const session = new GameSession(target, openBackend(pid));
    session.on("change", () => this.emit("update"));
    session.on("detached", () => {
      if (this.session === session) this.session = null;
      this.emit("update");
    });
    this.session = session;
    this.emit("update");
    return session;
  }

  detach(): void {
    this.session?.close("detached");
    this.session = null;
    this.emit("update");
  }

  requireSession(): GameSession {
    if (!this.session || this.session.isClosed) {
      throw new Error("Not attached to a game. Ask the user which game they're playing, then use attach_to_game.");
    }
    return this.session;
  }

  state() {
    return {
      supported: memorySupported(),
      attached: this.session && !this.session.isClosed ? this.session.snapshot() : null,
      scanProgress: this.scanProgress,
    };
  }

  setProgress(fraction: number | null): void {
    this.scanProgress = fraction;
    this.emit("update");
  }
}

const valueType = z
  .enum(VALUE_TYPES)
  .default("int32")
  .describe(
    "How the game stores the number. Whole numbers shown in-game (gold, ammo, level) are usually int32; " +
      "health/stamina/speed/positions are usually float; some engines use double or int64.",
  );
const address = z.string().describe("Hex address from a scan result, e.g. 0x1A2B3C40");

/** `status` adds what the game tools don't know about: adapters, screen sharing. */
export function memoryTools(games: GameManager, status: () => Record<string, unknown> = () => ({})): HubTool[] {
  const describeResults = (limit = 12) => {
    const s = games.requireSession();
    const hits = s.scanner.sample(limit).map((h) => ({ address: hex(h.address), value: h.value }));
    return { count: s.scanner.count, type: s.scanner.type, first_results: hits };
  };

  /**
   * Writes only go to addresses from the current scan or the mod list. Models (small local
   * ones especially) sometimes reuse a stale address from an earlier scan or invent one, and
   * writing to random memory crashes games; the error lists the addresses they meant.
   */
  const checkKnown = (addr: number) => {
    const s = games.requireSession();
    if (s.scanner.includes(addr) || s.watch.has(addr)) return;
    const current = s.scanner.resultAddresses(10).map(hex);
    const watched = [...s.watch.keys()].map(hex);
    throw new Error(
      `${hex(addr)} isn't in the current scan results or the mod list, so Scruff won't write to it. ` +
        (current.length ? `Current results: ${current.join(", ")}${s.scanner.count > 10 ? ", …" : ""}. ` : "No scan results. ") +
        (watched.length ? `Mod list: ${watched.join(", ")}.` : ""),
    );
  };

  const trackScan = async <T>(fn: (onProgress: (f: number) => void) => Promise<T>): Promise<T> => {
    let last = 0;
    try {
      return await fn((f) => {
        if (f === 1 || f - last > 0.05) {
          last = f;
          games.setProgress(f);
        }
      });
    } finally {
      games.setProgress(null);
    }
  };

  return [
    defineTool({
      name: "list_running_games",
      readOnly: true,
      description:
        "List programs running on the user's PC that could be the game they're playing (windowed apps on Windows). " +
        "Use this to find the game's process id before attaching.",
      input: z.object({
        search: z.string().optional().describe("Optional part of the game or exe name to filter by"),
      }),
      async run({ search }) {
        const list = await games.listGames(search);
        return list.length ? json(list) : "No matching programs found.";
      },
    }),

    defineTool({
      name: "attach_to_game",
      description:
        "Attach Scruff to a running game so its memory can be scanned and edited. Only works for single-player " +
        "games: Scruff refuses games with anti-cheat running.",
      input: z.object({ pid: z.number().int().describe("Process id from list_running_games") }),
      async run({ pid }) {
        const s = await games.attach(pid);
        return `Attached to ${s.target.name} (pid ${pid}).`;
      },
    }),

    defineTool({
      name: "game_status",
      readOnly: true,
      description:
        "What Scruff is attached to, the current scan result count, the values being watched or frozen (with live " +
        "values), recent changes that can be undone, connected game adapters, and whether the screen is shared.",
      input: z.object({}),
      run() {
        const state = games.state();
        if (!state.attached) return json({ attached: false, ...status() });
        const { changes, ...rest } = state.attached;
        return json({ attached: true, ...rest, recent_changes: changes.slice(0, 15), ...status() });
      },
    }),

    defineTool({
      name: "new_scan",
      description:
        "Start a fresh memory scan (clears previous results). 'exact' finds every address holding `value`; " +
        "'range' finds everything between `min` and `max`. For floats, an exact whole number also matches " +
        "values that display as it (73 matches 72.5–73.99). Scanning a big game can take several seconds. " +
        "Expect thousands of results at first; narrow them with refine_scan.",
      input: z.object({
        type: valueType,
        mode: z.enum(["exact", "range"]).default("exact"),
        value: z.number().optional().describe("The value to find (mode 'exact')"),
        min: z.number().optional().describe("Lower bound (mode 'range')"),
        max: z.number().optional().describe("Upper bound (mode 'range')"),
        tolerance: z.number().optional().describe("Float/double only: override how close a value must be"),
      }),
      async run({ type, ...request }, ctx) {
        const s = games.requireSession();
        ctx.progress(`Scanning ${s.target.name} for ${request.mode === "exact" ? request.value : "a range"}…`);
        const summary = await trackScan((p) => s.scanner.firstScan(type, request, p));
        return json({
          ...describeResults(),
          truncated: summary.truncated
            ? `Stopped at ${summary.count} results. This value is too common: pick a rarer one or refine.`
            : undefined,
          scanned_mb: Math.round(summary.bytesScanned / 1048576),
          seconds: summary.elapsedMs / 1000,
        });
      },
    }),

    defineTool({
      name: "refine_scan",
      description:
        "Narrow the current results by re-checking each address. Typical loop: ask the user to change the value " +
        "in-game (spend gold, take damage), then refine with the new exact value, or with 'decreased'/'increased'/" +
        "'changed'/'unchanged' if the number isn't visible. Repeat until a handful of addresses remain.",
      input: z.object({
        mode: z.enum(["exact", "range", "changed", "unchanged", "increased", "decreased", "increased_by", "decreased_by"]),
        value: z.number().optional().describe("For exact / increased_by / decreased_by"),
        min: z.number().optional(),
        max: z.number().optional(),
        tolerance: z.number().optional(),
      }),
      async run(request, ctx) {
        const s = games.requireSession();
        ctx.progress(`Narrowing ${s.scanner.count.toLocaleString()} results…`);
        const before = s.scanner.count;
        await trackScan((p) => s.scanner.refine(request, p));
        return json({ before, ...describeResults() });
      },
    }),

    defineTool({
      name: "show_scan_results",
      readOnly: true,
      description: "List current scan results with their live values.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      run({ limit }) {
        return json(describeResults(limit));
      },
    }),

    defineTool({
      name: "read_values",
      readOnly: true,
      description: "Read the current value at one or more addresses.",
      input: z.object({ addresses: z.array(address).min(1).max(100), type: valueType }),
      run({ addresses, type }) {
        const s = games.requireSession();
        return json(addresses.map((a) => ({ address: a, value: s.read(parseAddress(a), type) })));
      },
    }),

    defineTool({
      name: "write_value",
      description:
        "Set the value at one or more addresses from the current scan results or the mod list (e.g. all remaining " +
          "results). Every write is logged and can be " +
        "undone. Only write once results are narrowed down: writing to random memory can crash the game. " +
        "The game may overwrite a one-off write; use freeze_value to hold it.",
      input: z.object({
        addresses: z.array(address).min(1).max(64),
        type: valueType,
        value: z.number(),
        label: z.string().optional().describe("What this value is, e.g. 'Gold' or 'Player health'"),
      }),
      run({ addresses, type, value, label }) {
        const s = games.requireSession();
        const results = addresses.map((a) => {
          try {
            const addr = parseAddress(a);
            checkKnown(addr);
            const change = s.write(addr, type, value, label);
            return { address: a, before: change.before, now: value, change_id: change.id };
          } catch (err) {
            return { address: a, error: (err as Error).message };
          }
        });
        return json(results);
      },
    }),

    defineTool({
      name: "freeze_value",
      description:
        "Lock an address to a value, rewriting it 10 times a second (infinite health, ammo that never drops). " +
        "Shows up in the dashboard's mod list with a toggle.",
      input: z.object({ address, type: valueType, value: z.number(), label: z.string() }),
      run({ address: a, type, value, label }) {
        const addr = parseAddress(a);
        checkKnown(addr);
        const change = games.requireSession().freeze(addr, type, value, label);
        return `Frozen ${label} at ${value} (was ${change.before}). change_id ${change.id}.`;
      },
    }),

    defineTool({
      name: "unfreeze_value",
      description: "Stop holding a frozen value (it keeps its current value; use undo_change to restore the original).",
      input: z.object({ address }),
      run({ address: a }) {
        return games.requireSession().unfreeze(parseAddress(a)) ? "Unfrozen." : "That address wasn't frozen.";
      },
    }),

    defineTool({
      name: "watch_value",
      description: "Pin an address to the dashboard with a name so the user can see it live, without changing it.",
      input: z.object({ address, type: valueType, label: z.string() }),
      run({ address: a, type, label }) {
        games.requireSession().watchAddress(parseAddress(a), type, label);
        return `Watching ${label}.`;
      },
    }),

    defineTool({
      name: "undo_change",
      description: "Undo a change (restores the original value and unfreezes it). Without change_id, undoes the latest.",
      input: z.object({ change_id: z.number().int().optional() }),
      run({ change_id }) {
        const undone = games.requireSession().undo(change_id);
        return undone
          ? `Restored ${undone.label} to ${undone.before}.`
          : "Nothing to undo.";
      },
    }),

    defineTool({
      name: "revert_all_changes",
      description: "Undo every change Scruff made to this game, newest first.",
      input: z.object({}),
      run() {
        return `Reverted ${games.requireSession().revertAll()} change(s).`;
      },
    }),
  ];
}

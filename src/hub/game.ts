import { EventEmitter } from "node:events";
import { buildProfile, type GameProfile } from "../games/profile.ts";
import { z } from "zod";
import { listProcesses, memorySupported, openBackend } from "../memory/platform.ts";
import { checkAttachSafety } from "../memory/safety.ts";
import { GameSession } from "../memory/session.ts";
import { WATCH_LIMIT, type ScanRequest } from "../memory/scanner.ts";
import { VALUE_TYPES, hex, isFloatType, parseAddress, type ProcessInfo, type ValueType } from "../memory/types.ts";
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
  /** What Scruff learned from the attached game's files. */
  profile: GameProfile | null = null;
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
    try {
      this.profile = target.exe ? buildProfile(target.exe) : null;
    } catch {
      this.profile = null; // unreadable install folder: memory editing still works
    }
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
    this.profile = null;
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
      profile: this.profile && {
        name: this.profile.name,
        engine: this.profile.engine,
        installDir: this.profile.installDir,
        saveDirs: this.profile.saveDirs,
        code: this.profile.codeKind,
      },
      scanProgress: this.scanProgress,
    };
  }

  setProgress(fraction: number | null): void {
    this.scanProgress = fraction;
    this.emit("update");
  }
}

/** What "auto" searches: whole numbers and decimals, since which one a game uses isn't visible. */
const AUTO_TYPES: ValueType[] = ["int32", "float", "double"];
const FEW = 8;
const WRITE_CHECK_MS = 400;

const optionalType = z
  .enum(VALUE_TYPES)
  .optional()
  .describe("Usually leave out: Scruff knows how each scan result is stored.");
const address = z.string().describe("Hex address from find_value's results, e.g. 0x1A2B3C40");

/** `status` adds what the game tools don't know about: adapters, screen sharing. */
export function memoryTools(games: GameManager, status: () => Record<string, unknown> = () => ({})): HubTool[] {
  const results = (limit = 12) => {
    const s = games.requireSession();
    return s.scanner.sample(limit).map((h) => ({ address: hex(h.address), value: h.value, type: h.type }));
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

  /** How an address is stored: what the scan found it as beats what the model guessed. */
  const typeFor = (addr: number, given?: ValueType): ValueType => {
    const s = games.requireSession();
    const known = s.scanner.typeOf(addr) ?? s.watch.get(addr)?.type;
    const type = known ?? given;
    if (!type) throw new Error(`Scruff doesn't know how ${hex(addr)} is stored. Pass type (int32, float, ...).`);
    return type;
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
        "What Scruff is attached to, the current search, the values being watched or frozen (with live values), " +
        "recent changes that can be undone, connected game adapters, and whether the screen is shared.",
      input: z.object({}),
      run() {
        const state = games.state();
        if (!state.attached) return json({ attached: false, ...status() });
        const { changes, ...rest } = state.attached;
        return json({ attached: true, ...rest, recent_changes: changes.slice(0, 15), ...status() });
      },
    }),

    defineTool({
      name: "find_value",
      description:
        "Find where the game keeps a number (gold, soup cans, ammo, health...). Give `what` it is and the number the " +
        "game shows right now. The first call searches all memory, checking whole numbers and decimals at once. " +
        "When many places match, have the player change that number in-game, then call again with the SAME `what` " +
        "and the new number: Scruff narrows the existing results (it does not start over). For bars without a " +
        "number, start with min/max and narrow with `change`. Set new_search to start over.",
      input: z.object({
        what: z.string().describe("What the number is, e.g. 'soup cans'. Keep it the same while narrowing."),
        value: z.number().optional().describe("The number the game shows now, exactly (decimals included)"),
        min: z.number().optional().describe("Lower bound, when there's no exact number"),
        max: z.number().optional().describe("Upper bound, when there's no exact number"),
        change: z
          .enum(["decreased", "increased", "changed", "unchanged"])
          .optional()
          .describe("When narrowing without a number: how it moved since the last call"),
        by: z.number().optional().describe("With change decreased/increased: by exactly how much"),
        steady: z
          .boolean()
          .default(true)
          .describe(
            "true for numbers that only change when the player does something (items, money, ammo): Scruff then " +
              "watches the results live and drops ones that change on their own. false for health that regenerates, timers, positions.",
          ),
        type: z
          .enum(["auto", ...VALUE_TYPES])
          .default("auto")
          .describe("Leave as auto unless you know how the game stores it"),
        new_search: z.boolean().default(false).describe("Start over instead of narrowing"),
      }),
      async run({ what, value, min, max, change, by, type, new_search, steady }, ctx) {
        const s = games.requireSession();
        const key = what.trim().toLowerCase();
        const narrowing = !new_search && s.searchLabel === key && s.scanner.count > 0;
        let request: ScanRequest;
        if (narrowing) {
          request = change
            ? by !== undefined && (change === "decreased" || change === "increased")
              ? { mode: change === "decreased" ? "decreased_by" : "increased_by", value: Math.abs(by) }
              : { mode: change }
            : value !== undefined
              ? // The player changed it: keep only places that moved to the new number, not ones that
                // happened to hold it all along.
                { mode: value !== s.searchValue ? "changed_to" : "exact", value }
              : { mode: "range", min, max };
          if (request.mode === "range" && (min === undefined || max === undefined)) {
            throw new Error("Give the new number (value), a min/max range, or how it changed (change).");
          }
          ctx.progress(`Narrowing ${s.scanner.count.toLocaleString()} places down…`);
          await trackScan((p) => s.scanner.refine(request, p));
        } else {
          if (value === undefined && (min === undefined || max === undefined)) {
            throw new Error("To start a search, give the number the game shows (value), or min/max if it's only a bar.");
          }
          request = value !== undefined ? { mode: "exact", value } : { mode: "range", min, max };
          ctx.progress(`Searching ${s.target.name} for ${what}…`);
          await trackScan((p) => s.scanner.firstScan(type === "auto" ? AUTO_TYPES : [type], request, p));
          s.searchLabel = key;
        }
        if (value !== undefined) s.searchValue = value;
        s.watchLive(steady);

        const count = s.scanner.count;
        const next =
          count === 0
            ? narrowing
              ? `Nothing matched: no place went from the last number to this one. Check the number with the player, ` +
                `or start over with new_search: true and the current number.`
              : `Nothing holds that number. Double-check it (exactly as shown); if it's a bar with no number, use min/max.`
            : count <= FEW
              ? `Found it. Set it with write_value (or freeze_value to hold it) on these addresses, labelled "${what}".`
              : `${count.toLocaleString()} places still match. Ask the player to change the ${what} in-game (use, ` +
                `spend, eat, drop or pick up some), then call find_value again with what: "${what}" and the new number.` +
                (steady && count <= WATCH_LIMIT
                  ? ` Meanwhile Scruff watches them live and drops ones that change on their own, so calling ` +
                    `find_value again with the same number in a little while may already show fewer.`
                  : "");
        return json({
          what,
          search: narrowing ? "narrowed" : "started",
          count,
          dropped_live_since_last_step: narrowing ? s.watchDropped : undefined,
          by_type: s.scanner.countsByType(),
          addresses: results(count <= FEW ? FEW : 5),
          truncated: s.scanner.truncated ? "Stopped early: this number is very common. Narrowing still works." : undefined,
          next_step: next,
        });
      },
    }),

    defineTool({
      name: "show_scan_results",
      readOnly: true,
      description: "List the current search results with their live values.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      run({ limit }) {
        const s = games.requireSession();
        return json({ what: s.searchLabel, count: s.scanner.count, addresses: results(limit) });
      },
    }),

    defineTool({
      name: "read_values",
      readOnly: true,
      description: "Read the current value at one or more addresses.",
      input: z.object({ addresses: z.array(address).min(1).max(100), type: optionalType }),
      run({ addresses, type }) {
        const s = games.requireSession();
        return json(
          addresses.map((a) => {
            const addr = parseAddress(a);
            const t = typeFor(addr, type);
            return { address: a, type: t, value: s.read(addr, t) };
          }),
        );
      },
    }),

    defineTool({
      name: "write_value",
      description:
        "Set the value at one or more addresses from the current search results or the mod list (e.g. all remaining " +
        "results). Every write is logged and can be undone. Only write once results are narrowed down: writing to " +
        "random memory can crash the game. Scruff checks the write stuck; if the game puts the old value back, " +
        "use freeze_value.",
      input: z.object({
        addresses: z.array(address).min(1).max(64),
        value: z.number(),
        label: z.string().optional().describe("What this value is, e.g. 'Gold' or 'Soup cans'"),
        type: optionalType,
      }),
      async run({ addresses, type, value, label }) {
        const s = games.requireSession();
        type Written = { address: string; addr: number; type: ValueType; before: number; change_id: number };
        const results: (Written | { address: string; error: string })[] = addresses.map((a) => {
          try {
            const addr = parseAddress(a);
            checkKnown(addr);
            const t = typeFor(addr, type);
            const change = s.write(addr, t, value, label);
            return { address: a, addr, type: t, before: change.before, change_id: change.id };
          } catch (err) {
            return { address: a, error: (err as Error).message };
          }
        });
        // Games often recalculate a value from somewhere else; catch that instead of claiming success.
        await new Promise((r) => setTimeout(r, WRITE_CHECK_MS));
        const report = results.map((r) => {
          if (!("addr" in r)) return r;
          const { addr, ...rest } = r;
          const now = s.read(addr, r.type);
          const held = now !== null && Math.abs(now - value) <= (isFloatType(r.type) ? Math.max(0.01, Math.abs(value) * 1e-4) : 0);
          return held ? { ...rest, now } : { ...rest, now, warning: `The game changed it back to ${now}. Use freeze_value to hold it.` };
        });
        const anyHeld = report.some((r) => "now" in r && !("warning" in r));
        return json({
          results: report,
          note: anyHeld
            ? "Set in memory. That doesn't prove the game shows it: some games redraw a number only later (next day, " +
              "reopening a menu) or keep the real value somewhere else. Look at the screen, or ask the player, before " +
              "saying it worked. If the game still shows the old number, undo this and keep narrowing."
            : undefined,
        });
      },
    }),

    defineTool({
      name: "freeze_value",
      description:
        "Lock an address to a value, rewriting it 10 times a second (infinite health, ammo or food that never runs " +
        "out). Shows up in the mod list with a toggle.",
      input: z.object({ address, value: z.number(), label: z.string(), type: optionalType }),
      run({ address: a, type, value, label }) {
        const addr = parseAddress(a);
        checkKnown(addr);
        const change = games.requireSession().freeze(addr, typeFor(addr, type), value, label);
        return (
          `Holding ${label} at ${value} in memory (was ${change.before}). change_id ${change.id}. ` +
          "Check the game shows it (look at the screen or ask) before saying it worked."
        );
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
      description: "Pin an address to the mod list with a name so the player can see it live, without changing it.",
      input: z.object({ address, label: z.string(), type: optionalType }),
      run({ address: a, type, label }) {
        const addr = parseAddress(a);
        games.requireSession().watchAddress(addr, typeFor(addr, type), label);
        return `Watching ${label}.`;
      },
    }),

    defineTool({
      name: "undo_change",
      description: "Undo a change (restores the original value and unfreezes it). Without change_id, undoes the latest.",
      input: z.object({ change_id: z.number().int().optional() }),
      run({ change_id }) {
        const undone = games.requireSession().undo(change_id);
        if (!undone) return "Nothing to undo.";
        return undone.file ? `Restored ${undone.file.path} from its backup.` : `Restored ${undone.label} to ${undone.before}.`;
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

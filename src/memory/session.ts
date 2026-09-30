import { EventEmitter } from "node:events";
import fs from "node:fs";
import { processAlive } from "./platform.ts";
import { Scanner } from "./scanner.ts";
import { TYPE_SIZE, decode, encode, hex, type ProcessBackend, type ProcessInfo, type ValueType } from "./types.ts";

export interface WatchEntry {
  address: number;
  type: ValueType;
  label: string;
  frozenValue: number | null;
}

export interface ChangeRecord {
  id: number;
  at: number;
  label: string;
  address: number;
  type: ValueType;
  before: number;
  after: number;
  frozen: boolean;
  undone: boolean;
  /** Set for edits to a game file (save, settings) instead of memory. */
  file?: { path: string; backup: string; summary: string };
}

const FREEZE_INTERVAL_MS = 100;
const ALIVE_CHECK_MS = 2000;
const WATCH_MS = 1000;
/** A number the player controls (items, money) moves a few times at most between reports. */
const WATCH_MAX_MOVES = 5;

/**
 * Everything Telos knows about the game it's attached to: scan results, the values
 * being watched or frozen, and every change it made (so any of them can be undone).
 *
 * Events: "change" (state the dashboard shows changed), "detached" (game exited).
 */
export class GameSession extends EventEmitter {
  readonly scanner: Scanner;
  /** What the current search is for ("soup cans"); find_value narrows while it stays the same. */
  searchLabel: string | null = null;
  /** The number the player last reported for it. */
  searchValue: number | null = null;
  /** What the player wants it to become, once found (so a quick "now it's 4.75" can finish the job). */
  searchGoal: number | null = null;
  /** "number": searched by what the game shows; "unknown": no number, narrowed by how it changes. */
  searchKind: "number" | "unknown" | null = null;
  /** Places dropped by live watching since the last search step. */
  watchDropped = 0;
  private watchTimer: NodeJS.Timeout | null = null;
  readonly watch = new Map<number, WatchEntry>();
  readonly changes: ChangeRecord[] = [];
  private nextChangeId = 1;
  private freezeTimer: NodeJS.Timeout;
  private aliveTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly target: ProcessInfo,
    private backend: ProcessBackend,
  ) {
    super();
    this.scanner = new Scanner(backend);
    this.freezeTimer = setInterval(() => this.applyFreezes(), FREEZE_INTERVAL_MS);
    this.aliveTimer = setInterval(() => {
      if (!processAlive(target.pid)) this.close("exited");
    }, ALIVE_CHECK_MS);
    this.freezeTimer.unref();
    this.aliveTimer.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  read(address: number, type: ValueType): number | null {
    const buf = Buffer.alloc(TYPE_SIZE[type]);
    return this.backend.read(address, buf) === buf.length ? decode(buf, 0, type) : null;
  }

  /** Writes a value once and records it so it can be undone. */
  write(address: number, type: ValueType, value: number, label?: string): ChangeRecord {
    requireFinite(value);
    const before = this.read(address, type);
    if (before === null) throw new Error(`Can't read ${hex(address)}; it may have been freed.`);
    if (!this.backend.write(address, encode(value, type))) {
      throw new Error(`Writing ${hex(address)} failed. The memory may be read-only or the game may have moved it.`);
    }
    const existing = this.watch.get(address);
    const name = label ?? existing?.label ?? hex(address);
    const record = this.record(address, type, before, value, name, false);
    if (existing) {
      existing.label = name;
      // A frozen value stays frozen, but at the new value.
      if (existing.frozenValue !== null) existing.frozenValue = value;
    } else {
      this.watch.set(address, { address, type, label: name, frozenValue: null });
    }
    this.emit("change");
    return record;
  }

  /** Keeps a value pinned (e.g. infinite health) until unfrozen or undone. */
  freeze(address: number, type: ValueType, value: number, label: string): ChangeRecord {
    requireFinite(value);
    const before = this.read(address, type);
    if (before === null) throw new Error(`Can't read ${hex(address)}; it may have been freed.`);
    if (!this.backend.write(address, encode(value, type))) throw new Error(`Writing ${hex(address)} failed.`);
    this.watch.set(address, { address, type, label, frozenValue: value });
    const record = this.record(address, type, before, value, label, true);
    this.emit("change");
    return record;
  }

  unfreeze(address: number): boolean {
    const entry = this.watch.get(address);
    if (!entry || entry.frozenValue === null) return false;
    entry.frozenValue = null;
    this.emit("change");
    return true;
  }

  watchAddress(address: number, type: ValueType, label: string): void {
    const existing = this.watch.get(address);
    this.watch.set(address, { address, type, label, frozenValue: existing?.frozenValue ?? null });
    this.emit("change");
  }

  unwatch(address: number): boolean {
    const had = this.watch.delete(address);
    if (had) this.emit("change");
    return had;
  }

  /** Logs an edit to one of the game's files; undo restores the backup. */
  recordFileEdit(label: string, file: { path: string; backup: string; summary: string }): ChangeRecord {
    const record = this.record(0, "int8", 0, 0, label, false);
    record.file = file;
    this.emit("change");
    return record;
  }

  undo(id?: number): ChangeRecord | null {
    const record = id
      ? this.changes.find((c) => c.id === id && !c.undone)
      : [...this.changes].reverse().find((c) => !c.undone);
    if (!record) return null;
    if (record.file) {
      fs.copyFileSync(record.file.backup, record.file.path);
      record.undone = true;
      this.emit("change");
      return record;
    }
    const entry = this.watch.get(record.address);
    if (entry) entry.frozenValue = null;
    this.backend.write(record.address, encode(record.before, record.type));
    record.undone = true;
    this.emit("change");
    return record;
  }

  revertAll(): number {
    let n = 0;
    while (this.undo()) n++;
    return n;
  }

  /** What the dashboard (and the AI) sees about the current game. */
  snapshot() {
    return {
      pid: this.target.pid,
      name: this.target.name,
      title: this.target.title,
      scan: {
        what: this.searchLabel,
        goal: this.searchGoal,
        kind: this.searchKind,
        watching: this.watchTimer !== null,
        droppedLive: this.watchDropped,
        types: this.scanner.hasResults ? this.scanner.types : [],
        count: this.scanner.count,
        truncated: this.scanner.truncated,
      },
      watch: [...this.watch.values()].map((w) => ({
        address: hex(w.address),
        type: w.type,
        label: w.label,
        value: this.read(w.address, w.type),
        frozen: w.frozenValue !== null,
        frozenValue: w.frozenValue,
      })),
      changes: this.changes.map((c) => ({ ...c, address: c.file ? "file" : hex(c.address) })).reverse(),
    };
  }

  /**
   * Keeps an eye on the current results while the player plays and drops the ones that change
   * on their own. Only for steady values (item counts, money): health that regenerates or a
   * timer would be dropped too, so the caller decides.
   */
  watchLive(on: boolean): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchDropped = 0;
    if (!on) return;
    this.watchTimer = setInterval(() => {
      const dropped = this.scanner.watchTick(WATCH_MAX_MOVES);
      if (dropped) {
        this.watchDropped += dropped;
        this.emit("change");
      }
    }, WATCH_MS);
    this.watchTimer.unref();
  }

  close(reason: "exited" | "detached" = "detached"): void {
    if (this.closed) return;
    this.closed = true;
    this.watchLive(false);
    this.scanner.reset(); // deletes a snapshot file, if any
    clearInterval(this.freezeTimer);
    clearInterval(this.aliveTimer);
    this.backend.close();
    this.emit("detached", reason);
  }

  private record(
    address: number,
    type: ValueType,
    before: number,
    after: number,
    label: string,
    frozen: boolean,
  ): ChangeRecord {
    const record: ChangeRecord = {
      id: this.nextChangeId++,
      at: Date.now(),
      label,
      address,
      type,
      before,
      after,
      frozen,
      undone: false,
    };
    this.changes.push(record);
    return record;
  }

  private applyFreezes(): void {
    for (const entry of this.watch.values()) {
      if (entry.frozenValue !== null) this.backend.write(entry.address, encode(entry.frozenValue, entry.type));
    }
  }
}

function requireFinite(value: number): void {
  if (!Number.isFinite(value)) throw new Error(`"${value}" isn't a number.`);
}

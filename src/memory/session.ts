import { EventEmitter } from "node:events";
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
}

const FREEZE_INTERVAL_MS = 100;
const ALIVE_CHECK_MS = 2000;

/**
 * Everything Scruff knows about the game it's attached to: scan results, the values
 * being watched or frozen, and every change it made (so any of them can be undone).
 *
 * Events: "change" (state the dashboard shows changed), "detached" (game exited).
 */
export class GameSession extends EventEmitter {
  readonly scanner: Scanner;
  /** What the current search is for ("soup cans"); find_value narrows while it stays the same. */
  searchLabel: string | null = null;
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

  undo(id?: number): ChangeRecord | null {
    const record = id
      ? this.changes.find((c) => c.id === id && !c.undone)
      : [...this.changes].reverse().find((c) => !c.undone);
    if (!record) return null;
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
      changes: this.changes.map((c) => ({ ...c, address: hex(c.address) })).reverse(),
    };
  }

  close(reason: "exited" | "detached" = "detached"): void {
    if (this.closed) return;
    this.closed = true;
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

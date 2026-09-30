import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ProcessBackend, Region, ValueType } from "./types.ts";

/**
 * "Unknown value" scans, for things with no number on screen (health bars, hunger, a timer) or
 * a number the player doesn't know. Telos copies the game's writable memory to a temp file and
 * keeps one bit per possible slot and type saying "could still be it". Each step compares the
 * game's memory now with the copy ("went down", "went up", "stayed the same"), clears the bits
 * that don't fit, and saves the new values as the next baseline. Once few enough candidates are
 * left, they become an ordinary result list.
 *
 * Only slots that look like a game value count: whole numbers up to 100 million, and decimals
 * that are zero or between 0.0001 and 100 million. That drops pointers and random bytes, which
 * would otherwise swamp the results.
 */

export type SnapType = "int32" | "float" | "double";
export const SNAPSHOT_TYPES: SnapType[] = ["int32", "float", "double"];
const STRIDE: Record<SnapType, number> = { int32: 4, float: 4, double: 8 };

const CHUNK = 4 * 1024 * 1024; // a multiple of 64, so every chunk starts on a whole mask byte
const YIELD_EVERY_MS = 30;
const MAX_BYTES = 16 * 1024 ** 3;
const SPARE_DISK = 512 * 1024 ** 2;
const INT_MIN = -1_000_000;
const INT_MAX = 100_000_000;
const F_MIN = 1e-4;
const F_MAX = 1e8;

type Predicate = (value: number, previous: number) => boolean;

interface SnapRegion extends Region {
  /** Where this region's bytes start in the file. */
  at: number;
  /** Per type (same order as `types`): bit i set = slot i may still be it. */
  masks: Uint8Array[];
}

// Snapshots can be gigabytes; never leave one behind.
const openFiles = new Set<string>();
process.once("exit", () => {
  for (const file of openFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export class Snapshot {
  private closed = false;

  private constructor(
    readonly types: SnapType[],
    private file: string,
    private fd: number,
    private regions: SnapRegion[],
    private counts: number[],
    readonly bytes: number,
  ) {}

  static async take(backend: ProcessBackend, types: ValueType[], onProgress?: (f: number) => void, dir = os.tmpdir()): Promise<Snapshot> {
    const snapTypes = SNAPSHOT_TYPES.filter((t) => types.includes(t));
    if (!snapTypes.length) throw new Error("Scans without a number work for int32, float and double.");
    const regions = backend.regions().sort((a, b) => a.base - b.base);
    const total = regions.reduce((n, r) => n + r.size, 0);
    if (total > MAX_BYTES) {
      throw new Error(`This game uses ${gb(total)} of memory, too much to snapshot. Search by the number instead.`);
    }
    let free = Infinity;
    try {
      const st = fs.statfsSync(dir);
      free = st.bavail * st.bsize;
    } catch {}
    if (free < total + SPARE_DISK) {
      throw new Error(
        `A search without a number copies the game's memory (${gb(total)}) to ${dir}, but that drive only has ${gb(free)} free.`,
      );
    }

    const file = path.join(dir, `scruff-snapshot-${process.pid}-${Date.now()}.bin`);
    const fd = fs.openSync(file, "w+", 0o600);
    openFiles.add(file);
    const chunk = Buffer.from(new ArrayBuffer(CHUNK));
    const counts = snapTypes.map(() => 0);
    const snap: SnapRegion[] = [];
    let at = 0;
    let done = 0;
    let lastYield = performance.now();
    try {
      for (const region of regions) {
        const masks = snapTypes.map((t) => new Uint8Array(Math.ceil(Math.floor(region.size / STRIDE[t]) / 8)));
        for (let offset = 0; offset < region.size; offset += CHUNK) {
          const len = Math.min(CHUNK, region.size - offset);
          const view = chunk.subarray(0, len);
          const got = Math.max(0, backend.read(region.base + offset, view));
          if (got < len) view.fill(0, got);
          fs.writeSync(fd, view, 0, len, at + offset);
          snapTypes.forEach((t, i) => (counts[i] += mark(t, chunk.buffer, got, masks[i], offset / STRIDE[t])));
          done += len;
          if (performance.now() - lastYield > YIELD_EVERY_MS) {
            onProgress?.(total ? done / total : 1);
            await yieldToEventLoop();
            lastYield = performance.now();
          }
        }
        snap.push({ ...region, at, masks });
        at += region.size;
      }
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      openFiles.delete(file);
      throw err;
    }
    onProgress?.(1);
    return new Snapshot(snapTypes, file, fd, snap, counts, total);
  }

  get count(): number {
    return this.counts.reduce((a, b) => a + b, 0);
  }

  countsByType(): Partial<Record<ValueType, number>> {
    return Object.fromEntries(this.types.map((t, i) => [t, this.counts[i]]));
  }

  /** Types that still have candidates (all of them before anything is ruled out). */
  liveTypes(): SnapType[] {
    const live = this.types.filter((_, i) => this.counts[i] > 0);
    return live.length ? live : [...this.types];
  }

  /** Keeps the slots where predicate(now, before) holds; "now" becomes the next baseline. */
  async compare(backend: ProcessBackend, predicates: Map<ValueType, Predicate>, onProgress?: (f: number) => void): Promise<void> {
    const cur = Buffer.from(new ArrayBuffer(CHUNK));
    const old = Buffer.from(new ArrayBuffer(CHUNK));
    const total = this.regions.reduce((n, r) => n + r.size, 0);
    let done = 0;
    let lastYield = performance.now();
    for (const region of this.regions) {
      for (let offset = 0; offset < region.size; offset += CHUNK) {
        const len = Math.min(CHUNK, region.size - offset);
        done += len;
        const live = this.types.map((t, i) => anySet(region.masks[i], offset / STRIDE[t], len / STRIDE[t]));
        if (!live.some(Boolean)) continue; // nothing left here: skip reading it at all
        const got = Math.max(0, backend.read(region.base + offset, cur.subarray(0, len)));
        fs.readSync(this.fd, old, 0, len, region.at + offset);
        this.types.forEach((t, i) => {
          if (!live[i]) return;
          this.counts[i] -= narrow(t, predicates.get(t)!, cur.buffer, old.buffer, got, len, region.masks[i], offset / STRIDE[t]);
        });
        if (got > 0) fs.writeSync(this.fd, cur, 0, got, region.at + offset);
        if (performance.now() - lastYield > YIELD_EVERY_MS) {
          onProgress?.(total ? done / total : 1);
          await yieldToEventLoop();
          lastYield = performance.now();
        }
      }
    }
    onProgress?.(1);
  }

  /** Every remaining candidate of one type, in address order, with its value at the last step. */
  forEach(type: SnapType, fn: (address: number, value: number) => boolean | void): void {
    const i = this.types.indexOf(type);
    if (i < 0 || !this.counts[i]) return;
    const stride = STRIDE[type];
    const buf = Buffer.from(new ArrayBuffer(CHUNK));
    for (const region of this.regions) {
      const mask = region.masks[i];
      for (let offset = 0; offset < region.size; offset += CHUNK) {
        const len = Math.min(CHUNK, region.size - offset);
        const slot0 = offset / stride;
        const slots = Math.floor(len / stride);
        if (!anySet(mask, slot0, slots)) continue;
        fs.readSync(this.fd, buf, 0, len, region.at + offset);
        const values = view(type, buf.buffer, len);
        for (let b = slot0 >> 3; b <= (slot0 + slots - 1) >> 3; b++) {
          const m = mask[b];
          if (!m) continue;
          for (let bit = 0; bit < 8; bit++) {
            if (!(m & (1 << bit))) continue;
            const k = b * 8 + bit - slot0;
            if (k >= slots) break;
            if (fn(region.base + offset + k * stride, values[k]) === false) return;
          }
        }
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {}
    fs.rmSync(this.file, { force: true });
    openFiles.delete(this.file);
  }
}

function view(type: SnapType, buffer: ArrayBufferLike, bytes: number): Int32Array | Float32Array | Float64Array {
  if (type === "int32") return new Int32Array(buffer, 0, bytes >> 2);
  if (type === "float") return new Float32Array(buffer, 0, bytes >> 2);
  return new Float64Array(buffer, 0, bytes >> 3);
}

function anySet(mask: Uint8Array, slot0: number, slots: number): boolean {
  const end = (slot0 + slots - 1) >> 3;
  for (let b = slot0 >> 3; b <= end; b++) if (mask[b]) return true;
  return false;
}

/** Sets the bit of every slot in the first `got` bytes that looks like a game value. */
function mark(type: SnapType, buffer: ArrayBufferLike, got: number, mask: Uint8Array, slot0: number): number {
  let n = 0;
  if (type === "int32") {
    const a = new Int32Array(buffer, 0, got >> 2);
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v >= INT_MIN && v <= INT_MAX) {
        const s = slot0 + i;
        mask[s >> 3] |= 1 << (s & 7);
        n++;
      }
    }
  } else {
    const a = type === "float" ? new Float32Array(buffer, 0, got >> 2) : new Float64Array(buffer, 0, got >> 3);
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      const abs = v < 0 ? -v : v;
      if (v === 0 || (abs >= F_MIN && abs <= F_MAX)) {
        const s = slot0 + i;
        mask[s >> 3] |= 1 << (s & 7);
        n++;
      }
    }
  }
  return n;
}

/**
 * Clears the candidates in one chunk that no longer fit. `got` is how much of the chunk could
 * be read now (memory can be freed). Returns how many were dropped. One loop per type keeps
 * V8's typed-array access fast.
 */
function narrow(
  type: SnapType,
  pred: Predicate,
  curBuf: ArrayBufferLike,
  oldBuf: ArrayBufferLike,
  got: number,
  len: number,
  mask: Uint8Array,
  slot0: number,
): number {
  const stride = STRIDE[type];
  const slots = Math.floor(len / stride);
  const readable = Math.floor(got / stride);
  const cur = view(type, curBuf, len);
  const old = view(type, oldBuf, len);
  const int = type === "int32";
  let dropped = 0;
  for (let b = slot0 >> 3; b <= (slot0 + slots - 1) >> 3; b++) {
    const m = mask[b];
    if (!m) continue;
    let keep = m;
    for (let bit = 0; bit < 8; bit++) {
      if (!(m & (1 << bit))) continue;
      const k = b * 8 + bit - slot0;
      if (k >= slots) break;
      let ok = k < readable;
      if (ok) {
        const v = cur[k];
        const abs = v < 0 ? -v : v;
        ok = (int ? v >= INT_MIN && v <= INT_MAX : v === 0 || (abs >= F_MIN && abs <= F_MAX)) && pred(v, old[k]);
      }
      if (!ok) {
        keep &= ~(1 << bit);
        dropped++;
      }
    }
    mask[b] = keep;
  }
  return dropped;
}

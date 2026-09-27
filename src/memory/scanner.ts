import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  TYPE_ALIGN,
  TYPE_SIZE,
  decode,
  isFloatType,
  type ProcessBackend,
  type Region,
  type ValueType,
} from "./types.ts";

export type FirstScanMode = "exact" | "range";
export type RefineMode =
  | "exact"
  /** Holds `value` now and held something else before: what the player just changed. */
  | "changed_to"
  | "range"
  | "changed"
  | "unchanged"
  | "increased"
  | "decreased"
  | "increased_by"
  | "decreased_by";

export interface ScanRequest {
  mode: RefineMode;
  value?: number;
  min?: number;
  max?: number;
  /** Float/double only: how far off a value may be and still match. */
  tolerance?: number;
}

export interface ScanSummary {
  types: ValueType[];
  count: number;
  /** Results per type, e.g. { int32: 279146, float: 12 }. */
  byType: Partial<Record<ValueType, number>>;
  /** True when the first scan hit the result cap and stopped early. */
  truncated: boolean;
  elapsedMs: number;
  bytesScanned: number;
}

export interface ScanHit {
  address: number;
  value: number;
  type: ValueType;
}

const CHUNK = 4 * 1024 * 1024;
/** Below this many hits in a region we read addresses one at a time instead of the whole span. */
const SPARSE_THRESHOLD = 64;
const YIELD_EVERY_MS = 30;
/** Live watching only runs on result sets this small, so a look stays cheap. */
export const WATCH_LIMIT = 20_000;

type Predicate = (value: number, previous: number) => boolean;

/** Results for one value type: addresses (sorted) and the value each had at the last scan. */
class TypedResults {
  count = 0;
  truncated = false;
  addresses = new Float64Array(0);
  values = new Float64Array(0);
  /** Live watching: the last value seen and how often it moved since the last scan. */
  lastSeen: Float64Array | null = null;
  moves: Uint8Array | null = null;
  private capacity: number;

  constructor(
    readonly type: ValueType,
    private maxResults: number,
  ) {
    this.capacity = Math.min(1 << 16, maxResults);
    this.addresses = new Float64Array(this.capacity);
    this.values = new Float64Array(this.capacity);
  }

  push = (address: number, value: number): boolean => {
    if (this.count === this.capacity) {
      if (this.capacity >= this.maxResults) return false;
      this.capacity = Math.min(this.capacity * 2, this.maxResults);
      this.addresses = grow(this.addresses, this.capacity);
      this.values = grow(this.values, this.capacity);
    }
    this.addresses[this.count] = address;
    this.values[this.count] = value;
    this.count++;
    return true;
  };

  indexOf(address: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.addresses[mid];
      if (v === address) return mid;
      if (v < address) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

/**
 * Cheat Engine–style value scanner: a first scan collects every address holding a value,
 * then refine scans narrow the list as the value changes in-game. One scan can look for
 * several number types at once (whole numbers and decimals), since which one a game uses
 * isn't visible on screen; each type is narrowed separately.
 */
export class Scanner {
  private parts: TypedResults[] = [];
  private busy = false;

  constructor(
    private backend: ProcessBackend,
    readonly maxResults = 5_000_000,
  ) {}

  get hasResults(): boolean {
    return this.parts.length > 0;
  }

  /** The types that still have results (all scanned types before anything is found). */
  get types(): ValueType[] {
    const live = this.parts.filter((p) => p.count > 0).map((p) => p.type);
    return live.length ? live : this.parts.map((p) => p.type);
  }

  /** The single type in play, or null when none or several. */
  get type(): ValueType | null {
    const types = this.types;
    return types.length === 1 ? types[0] : null;
  }

  get count(): number {
    return this.parts.reduce((n, p) => n + p.count, 0);
  }

  get truncated(): boolean {
    return this.parts.some((p) => p.truncated);
  }

  reset(): void {
    this.parts = [];
  }

  countsByType(): Partial<Record<ValueType, number>> {
    return Object.fromEntries(this.parts.map((p) => [p.type, p.count]));
  }

  async firstScan(
    types: ValueType | ValueType[],
    request: ScanRequest,
    onProgress?: (fraction: number) => void,
  ): Promise<ScanSummary> {
    if (request.mode !== "exact" && request.mode !== "range") {
      throw new Error(`A new scan must use "exact" or "range", not "${request.mode}".`);
    }
    const list = [...new Set(Array.isArray(types) ? types : [types])];
    return this.exclusive(async () => {
      const started = performance.now();
      const bounds = new Map(list.map((t) => [t, firstScanBounds(t, request)]));
      // Integer types can't hold 5.25: skip them rather than scanning for nothing.
      const scanTypes = list.filter((t) => {
        const [lo, hi] = bounds.get(t)!;
        return isFloatType(t) || Math.floor(hi) >= Math.ceil(lo);
      });
      const parts = scanTypes.map((t) => new TypedResults(t, Math.floor(this.maxResults / Math.max(1, scanTypes.length))));
      const full = new Set<TypedResults>();
      const overlap = Math.max(0, ...scanTypes.map((t) => TYPE_SIZE[t] - Math.min(TYPE_SIZE[t], TYPE_ALIGN[t])));
      const regions = parts.length ? this.backend.regions() : [];
      const total = regions.reduce((sum, r) => sum + r.size, 0);
      let scanned = 0;
      let lastYield = performance.now();
      const chunk = Buffer.from(new ArrayBuffer(CHUNK + 8));
      const shifted = Buffer.from(new ArrayBuffer(CHUNK + 8));

      outer: for (const region of regions) {
        for (let offset = 0; offset < region.size; offset += CHUNK) {
          const len = Math.min(CHUNK, region.size - offset);
          const readLen = Math.min(len + overlap, region.size - offset);
          const view = chunk.subarray(0, readLen);
          const got = this.backend.read(region.base + offset, view);
          scanned += len;
          const base = region.base + offset;
          for (const part of parts) {
            const size = TYPE_SIZE[part.type];
            if (full.has(part) || got < size) continue;
            const [lo, hi] = bounds.get(part.type)!;
            const limit = Math.min(len, got - size + 1);
            if (!scanChunk({ buf: view, shifted, base, limit, type: part.type, lo, hi, push: part.push })) {
              part.truncated = true;
              full.add(part);
              if (full.size === parts.length) break outer;
            }
          }
          if (performance.now() - lastYield > YIELD_EVERY_MS) {
            onProgress?.(total ? scanned / total : 1);
            await yieldToEventLoop();
            lastYield = performance.now();
          }
        }
      }

      this.parts = parts.length ? parts : list.map((t) => new TypedResults(t, 1));
      onProgress?.(1);
      return this.summary(started, scanned);
    });
  }

  async refine(request: ScanRequest, onProgress?: (fraction: number) => void): Promise<ScanSummary> {
    if (!this.parts.length) throw new Error("No scan results yet. Run a new scan first.");
    return this.exclusive(async () => {
      const started = performance.now();
      const regions = this.backend.regions();
      const total = this.count;
      let done = 0;
      let scanned = 0;
      for (const part of this.parts) {
        if (!part.count) continue;
        const before = part.count;
        scanned += await this.refinePart(part, regions, request, (f) => onProgress?.(total ? (done + f * before) / total : 1));
        done += before;
      }
      onProgress?.(1);
      return this.summary(started, scanned);
    });
  }

  private async refinePart(
    part: TypedResults,
    regions: Region[],
    request: ScanRequest,
    onProgress: (fraction: number) => void,
  ): Promise<number> {
    const type = part.type;
    const match = buildPredicate(type, request);
    const size = TYPE_SIZE[type];
    const addresses = part.addresses;
    const values = part.values;
    const n = part.count;
    let kept = 0;
    let i = 0;
    let scanned = 0;
    let lastYield = performance.now();
    const chunk = Buffer.from(new ArrayBuffer(CHUNK + 8));
    const single = Buffer.alloc(8);

    const consider = (address: number, current: number, index: number) => {
      if (match(current, values[index])) {
        addresses[kept] = address;
        values[kept] = current;
        kept++;
      }
    };

    for (const region of regions) {
      const end = region.base + region.size;
      // Skip results that fell into memory that has since been freed.
      while (i < n && addresses[i] < region.base) i++;
      let j = i;
      while (j < n && addresses[j] + size <= end) j++;
      if (j === i) continue;

      if (j - i < SPARSE_THRESHOLD) {
        for (let k = i; k < j; k++) {
          const view = single.subarray(0, size);
          if (this.backend.read(addresses[k], view) === size) consider(addresses[k], decode(view, 0, type), k);
        }
      } else {
        let k = i;
        while (k < j) {
          const spanStart = addresses[k];
          const spanLen = Math.min(CHUNK, end - spanStart);
          const view = chunk.subarray(0, spanLen);
          const got = this.backend.read(spanStart, view);
          scanned += spanLen;
          const spanEnd = spanStart + got;
          while (k < j && addresses[k] + size <= spanStart + spanLen) {
            if (addresses[k] + size <= spanEnd) consider(addresses[k], decode(view, addresses[k] - spanStart, type), k);
            k++;
          }
          if (performance.now() - lastYield > YIELD_EVERY_MS) {
            onProgress(n ? k / n : 1);
            await yieldToEventLoop();
            lastYield = performance.now();
          }
        }
      }
      i = j;
    }
    part.count = kept;
    part.lastSeen = null;
    part.moves = null;
    return scanned;
  }

  /**
   * One look at every result while the player plays, dropping ones that keep changing on their
   * own (timers, animations, positions): a count the player controls doesn't do that. Returns
   * how many were dropped, or null when a scan is running or there are too many to watch.
   */
  watchTick(maxMoves = 3, limit = WATCH_LIMIT): number | null {
    if (this.busy || this.count === 0 || this.count > limit) return null;
    let dropped = 0;
    const buf = Buffer.alloc(8);
    for (const part of this.parts) {
      if (!part.count) continue;
      const view = buf.subarray(0, TYPE_SIZE[part.type]);
      part.lastSeen ??= part.values.slice(0, part.count);
      part.moves ??= new Uint8Array(part.count);
      const { addresses, values, lastSeen, moves } = part;
      const float = isFloatType(part.type);
      let kept = 0;
      for (let i = 0; i < part.count; i++) {
        let keep = true;
        if (this.backend.read(addresses[i], view) !== view.length) {
          keep = false; // freed
        } else {
          const v = decode(view, 0, part.type);
          const moved = float ? Math.abs(v - lastSeen[i]) > 1e-6 && !(Number.isNaN(v) && Number.isNaN(lastSeen[i])) : v !== lastSeen[i];
          if (moved) {
            lastSeen[i] = v;
            if (moves[i] < 255) moves[i]++;
          }
          if (moves[i] >= maxMoves) keep = false;
        }
        if (keep) {
          addresses[kept] = addresses[i];
          values[kept] = values[i];
          lastSeen[kept] = lastSeen[i];
          moves[kept] = moves[i];
          kept++;
        } else {
          dropped++;
        }
      }
      part.count = kept;
    }
    return dropped;
  }

  /** Current results with live values, for showing the AI or the user. */
  sample(limit: number): ScanHit[] {
    const hits: ScanHit[] = [];
    const buf = Buffer.alloc(8);
    for (const part of this.parts) {
      const view = buf.subarray(0, TYPE_SIZE[part.type]);
      for (let i = 0; i < part.count && hits.length < limit; i++) {
        const address = part.addresses[i];
        if (this.backend.read(address, view) === view.length) hits.push({ address, value: decode(view, 0, part.type), type: part.type });
      }
    }
    return hits;
  }

  /** The type an address was found as, or null if it isn't a current result. */
  typeOf(address: number): ValueType | null {
    for (const part of this.parts) if (part.indexOf(address) >= 0) return part.type;
    return null;
  }

  includes(address: number): boolean {
    return this.typeOf(address) !== null;
  }

  resultAddresses(limit: number): number[] {
    const out: number[] = [];
    for (const part of this.parts) {
      for (let i = 0; i < part.count && out.length < limit; i++) out.push(part.addresses[i]);
    }
    return out;
  }

  private summary(started: number, bytesScanned: number): ScanSummary {
    return {
      types: this.types,
      count: this.count,
      byType: this.countsByType(),
      truncated: this.truncated,
      elapsedMs: Math.round(performance.now() - started),
      bytesScanned,
    };
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("A scan is already running. Wait for it to finish.");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

function grow(arr: Float64Array<ArrayBuffer>, capacity: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(capacity);
  next.set(arr);
  return next;
}

interface Chunk {
  /** Starts at offset 0 of its ArrayBuffer, so typed-array views on it are aligned. */
  buf: Buffer;
  /** Scratch space for 8-byte values that sit at 4 (mod 8). */
  shifted: Buffer;
  base: number;
  /** Candidate start offsets are those below this. */
  limit: number;
  type: ValueType;
  lo: number;
  hi: number;
  push: (address: number, value: number) => boolean;
}

/**
 * Scans one chunk for values in [lo, hi]. Returns false when the result store is full.
 * Each type gets its own tight typed-array loop so V8 keeps them all fast (a shared loop
 * with a predicate callback goes megamorphic and runs 5–10x slower).
 */
function scanChunk(c: Chunk): boolean {
  const { buf, limit } = c;
  switch (c.type) {
    case "int8":
      return scanI8(new Int8Array(buf.buffer, 0, limit), c);
    case "int16":
      return scanI16(new Int16Array(buf.buffer, 0, (limit + 1) >> 1), c);
    case "int32":
      return scanI32(new Int32Array(buf.buffer, 0, (limit + 3) >> 2), c);
    case "float":
      return scanF32(new Float32Array(buf.buffer, 0, (limit + 3) >> 2), c);
    case "double":
    case "int64":
      return scan8(c);
  }
}

function scanI8(arr: Int8Array, c: Chunk): boolean {
  const { lo, hi, base, push } = c;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v >= lo && v <= hi && !push(base + i, v)) return false;
  }
  return true;
}

function scanI16(arr: Int16Array, c: Chunk): boolean {
  const { lo, hi, base, push } = c;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v >= lo && v <= hi && !push(base + i * 2, v)) return false;
  }
  return true;
}

function scanI32(arr: Int32Array, c: Chunk): boolean {
  const { lo, hi, base, push } = c;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v >= lo && v <= hi && !push(base + i * 4, v)) return false;
  }
  return true;
}

function scanF32(arr: Float32Array, c: Chunk): boolean {
  const { lo, hi, base, push } = c;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v >= lo && v <= hi && !push(base + i * 4, v)) return false;
  }
  return true;
}

/** 8-byte values at 4-byte alignment: scan offsets 0 mod 8 in place and 4 mod 8 in a shifted copy. */
function scan8(c: Chunk): boolean {
  const { buf, shifted, limit, lo, hi, base } = c;
  const hits: number[] = [];
  const collect = (arr: Float64Array | BigInt64Array, offset: number) => {
    if (arr instanceof Float64Array) {
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v >= lo && v <= hi) hits.push(offset + i * 8, v);
      }
    } else {
      const bl = BigInt(Math.ceil(lo));
      const bh = BigInt(Math.floor(hi));
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v >= bl && v <= bh) hits.push(offset + i * 8, Number(v));
      }
    }
  };
  const View = c.type === "double" ? Float64Array : BigInt64Array;
  collect(new View(buf.buffer as ArrayBuffer, 0, (limit + 7) >> 3), 0);
  if (limit > 4) {
    buf.copy(shifted, 0, 4, buf.length);
    collect(new View(shifted.buffer as ArrayBuffer, 0, (limit - 4 + 7) >> 3), 4);
  }
  // Results must stay sorted by address for refine().
  const order = Array.from({ length: hits.length / 2 }, (_, k) => k).sort((a, b) => hits[a * 2] - hits[b * 2]);
  for (const k of order) if (!c.push(base + hits[k * 2], hits[k * 2 + 1])) return false;
  return true;
}

/** A new scan is always "is the value within [lo, hi]". */
export function firstScanBounds(type: ValueType, request: ScanRequest): [number, number] {
  if (request.mode === "range") {
    if (!Number.isFinite(request.min) || !Number.isFinite(request.max)) {
      throw new Error('Scan mode "range" needs numeric "min" and "max".');
    }
    return [request.min!, request.max!];
  }
  const value = request.value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error('Scan mode "exact" needs a numeric "value".');
  if (!isFloatType(type)) return [value, value];
  if (request.tolerance !== undefined) return [value - Math.abs(request.tolerance), value + Math.abs(request.tolerance)];
  // Games show floats rounded or truncated: "73" on screen can be 72.5 .. 73.99 in memory.
  if (Number.isInteger(value)) return [value - 0.5, value + 1 - 1e-9];
  const tol = Math.max(0.005, Math.abs(value) * 1e-4);
  return [value - tol, value + tol];
}

export function buildPredicate(type: ValueType, request: ScanRequest): Predicate {
  const float = isFloatType(type);
  const need = (field: "value" | "min" | "max"): number => {
    const v = request[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Scan mode "${request.mode}" needs a numeric "${field}".`);
    }
    return v;
  };
  const near = (target: number, isDelta = false): ((v: number) => boolean) => {
    if (!float) return (v) => v === target;
    if (request.tolerance !== undefined) {
      const tol = Math.abs(request.tolerance);
      return (v) => Math.abs(v - target) <= tol;
    }
    // Games show floats rounded or truncated: "73" on screen can be 72.5 .. 73.99 in memory.
    if (!isDelta && Number.isInteger(target)) return (v) => v >= target - 0.5 && v < target + 1;
    const tol = isDelta ? Math.max(0.01, Math.abs(target) * 0.01) : Math.max(0.005, Math.abs(target) * 1e-4);
    return (v) => Math.abs(v - target) <= tol;
  };

  switch (request.mode) {
    case "exact": {
      const isMatch = near(need("value"));
      return (v) => isMatch(v);
    }
    case "range": {
      const min = need("min");
      const max = need("max");
      return (v) => v >= min && v <= max;
    }
    case "changed_to": {
      const isMatch = near(need("value"));
      const moved = float ? (v: number, prev: number) => Math.abs(v - prev) > 1e-6 : (v: number, prev: number) => v !== prev;
      return (v, prev) => isMatch(v) && moved(v, prev);
    }
    case "changed":
      return (v, prev) => v !== prev && !(Number.isNaN(v) && Number.isNaN(prev));
    case "unchanged":
      return (v, prev) => v === prev;
    case "increased":
      return (v, prev) => v > prev;
    case "decreased":
      return (v, prev) => v < prev;
    case "increased_by": {
      const isMatch = near(need("value"), true);
      return (v, prev) => isMatch(v - prev);
    }
    case "decreased_by": {
      const isMatch = near(need("value"), true);
      return (v, prev) => isMatch(prev - v);
    }
  }
}

export type { Region };

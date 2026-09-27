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
  type: ValueType;
  count: number;
  /** True when the first scan hit the result cap and stopped early. */
  truncated: boolean;
  elapsedMs: number;
  bytesScanned: number;
}

export interface ScanHit {
  address: number;
  value: number;
}

const CHUNK = 4 * 1024 * 1024;
/** Below this many hits in a region we read addresses one at a time instead of the whole span. */
const SPARSE_THRESHOLD = 64;
const YIELD_EVERY_MS = 30;

type Predicate = (value: number, previous: number) => boolean;

/**
 * Cheat Engine–style value scanner: a first scan collects every address holding a value,
 * then refine scans narrow the list as the value changes in-game.
 */
export class Scanner {
  type: ValueType | null = null;
  count = 0;
  truncated = false;
  private addresses = new Float64Array(0);
  private values = new Float64Array(0);
  private busy = false;

  constructor(
    private backend: ProcessBackend,
    readonly maxResults = 5_000_000,
  ) {}

  get hasResults(): boolean {
    return this.type !== null;
  }

  reset(): void {
    this.type = null;
    this.count = 0;
    this.truncated = false;
    this.addresses = new Float64Array(0);
    this.values = new Float64Array(0);
  }

  async firstScan(
    type: ValueType,
    request: ScanRequest,
    onProgress?: (fraction: number) => void,
  ): Promise<ScanSummary> {
    if (request.mode !== "exact" && request.mode !== "range") {
      throw new Error(`A new scan must use "exact" or "range", not "${request.mode}".`);
    }
    return this.exclusive(async () => {
      const started = performance.now();
      const [lo, hi] = firstScanBounds(type, request);
      const size = TYPE_SIZE[type];
      const align = TYPE_ALIGN[type];
      const overlap = size - Math.min(size, align);
      const regions = this.backend.regions();
      const total = regions.reduce((sum, r) => sum + r.size, 0);

      this.reset();
      this.type = type;
      let capacity = Math.min(1 << 16, this.maxResults);
      let addresses = new Float64Array(capacity);
      let values = new Float64Array(capacity);
      let count = 0;
      let scanned = 0;
      let lastYield = performance.now();
      const chunk = Buffer.from(new ArrayBuffer(CHUNK + 8));
      const shifted = Buffer.from(new ArrayBuffer(CHUNK + 8));

      const push = (address: number, value: number): boolean => {
        if (count === capacity) {
          if (capacity >= this.maxResults) return false;
          capacity = Math.min(capacity * 2, this.maxResults);
          addresses = grow(addresses, capacity);
          values = grow(values, capacity);
        }
        addresses[count] = address;
        values[count] = value;
        count++;
        return true;
      };

      outer: for (const region of regions) {
        for (let offset = 0; offset < region.size; offset += CHUNK) {
          const len = Math.min(CHUNK, region.size - offset);
          const readLen = Math.min(len + overlap, region.size - offset);
          const view = chunk.subarray(0, readLen);
          const got = this.backend.read(region.base + offset, view);
          scanned += len;
          if (got >= size) {
            const base = region.base + offset;
            const limit = Math.min(len, got - size + 1);
            if (!scanChunk({ buf: view, shifted, base, limit, type, lo, hi, push })) {
              this.truncated = true;
              break outer;
            }
          }
          if (performance.now() - lastYield > YIELD_EVERY_MS) {
            onProgress?.(total ? scanned / total : 1);
            await yieldToEventLoop();
            lastYield = performance.now();
          }
        }
      }

      this.addresses = addresses;
      this.values = values;
      this.count = count;
      onProgress?.(1);
      return this.summary(started, scanned);
    });
  }

  async refine(request: ScanRequest, onProgress?: (fraction: number) => void): Promise<ScanSummary> {
    const type = this.type;
    if (!type) throw new Error("No scan results yet. Run a new scan first.");
    return this.exclusive(async () => {
      const started = performance.now();
      const match = buildPredicate(type, request);
      const size = TYPE_SIZE[type];
      const regions = this.backend.regions();
      const addresses = this.addresses;
      const values = this.values;
      const n = this.count;
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
              onProgress?.(n ? k / n : 1);
              await yieldToEventLoop();
              lastYield = performance.now();
            }
          }
        }
        i = j;
      }

      this.count = kept;
      onProgress?.(1);
      return this.summary(started, scanned);
    });
  }

  /** Current results with live values, for showing the AI or the user. */
  sample(limit: number): ScanHit[] {
    if (!this.type) return [];
    const type = this.type;
    const buf = Buffer.alloc(TYPE_SIZE[type]);
    const hits: ScanHit[] = [];
    for (let i = 0; i < Math.min(limit, this.count); i++) {
      const address = this.addresses[i];
      if (this.backend.read(address, buf) === buf.length) hits.push({ address, value: decode(buf, 0, type) });
    }
    return hits;
  }

  /** Whether an address is among the current results (they're kept sorted). */
  includes(address: number): boolean {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.addresses[mid];
      if (v === address) return true;
      if (v < address) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  resultAddresses(limit: number): number[] {
    return Array.from(this.addresses.subarray(0, Math.min(limit, this.count)));
  }

  private summary(started: number, bytesScanned: number): ScanSummary {
    return {
      type: this.type!,
      count: this.count,
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

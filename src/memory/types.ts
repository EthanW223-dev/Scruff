export const VALUE_TYPES = ["int8", "int16", "int32", "int64", "float", "double"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export const TYPE_SIZE: Record<ValueType, number> = {
  int8: 1,
  int16: 2,
  int32: 4,
  int64: 8,
  float: 4,
  double: 8,
};

/** Scan alignment. Games almost always keep 4+ byte values 4-byte aligned (Cheat Engine's "fast scan"). */
export const TYPE_ALIGN: Record<ValueType, number> = {
  int8: 1,
  int16: 2,
  int32: 4,
  int64: 4,
  float: 4,
  double: 4,
};

export interface Region {
  base: number;
  size: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  /** Window title (Windows). */
  title?: string;
  /** Full command line (Linux). */
  command?: string;
}

/** Raw access to another process's memory. One implementation per OS. */
export interface ProcessBackend {
  readonly pid: number;
  /** Committed, writable regions worth scanning (heap, stack, data segments). */
  regions(): Region[];
  /** Returns the number of bytes read into `buf`, or 0 on failure. */
  read(address: number, buf: Buffer): number;
  write(address: number, buf: Buffer): boolean;
  close(): void;
}

export function decode(buf: Buffer, offset: number, type: ValueType): number {
  switch (type) {
    case "int8":
      return buf.readInt8(offset);
    case "int16":
      return buf.readInt16LE(offset);
    case "int32":
      return buf.readInt32LE(offset);
    case "int64":
      return Number(buf.readBigInt64LE(offset));
    case "float":
      return buf.readFloatLE(offset);
    case "double":
      return buf.readDoubleLE(offset);
  }
}

export function encode(value: number, type: ValueType): Buffer {
  const buf = Buffer.alloc(TYPE_SIZE[type]);
  switch (type) {
    case "int8":
      buf.writeInt8(clampInt(value, -128, 127));
      break;
    case "int16":
      buf.writeInt16LE(clampInt(value, -32768, 32767));
      break;
    case "int32":
      buf.writeInt32LE(clampInt(value, -2147483648, 2147483647));
      break;
    case "int64":
      buf.writeBigInt64LE(BigInt(Math.trunc(value)));
      break;
    case "float":
      buf.writeFloatLE(value);
      break;
    case "double":
      buf.writeDoubleLE(value);
      break;
  }
  return buf;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isFloatType(type: ValueType): boolean {
  return type === "float" || type === "double";
}

export function hex(address: number): string {
  return "0x" + address.toString(16).toUpperCase();
}

export function parseAddress(address: string | number): number {
  if (typeof address === "number") return address;
  const s = address.trim().toLowerCase();
  const n = s.startsWith("0x") ? parseInt(s.slice(2), 16) : /[a-f]/.test(s) ? parseInt(s, 16) : Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a valid address: ${address}`);
  return n;
}

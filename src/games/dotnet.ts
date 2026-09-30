/**
 * Reads the classes and fields out of a .NET assembly (a Unity game's Assembly-CSharp.dll), so
 * the AI can see how the game names and stores things: `ShelterSupplies.soup : float` says
 * both what to look for and that it's a decimal. Just enough of ECMA-335 to list fields.
 */

export interface FieldInfo {
  type: string; // declaring class, with namespace
  name: string;
  valueType: string; // "float", "int", "string", "List<Item>"...
  isStatic: boolean;
  isConst: boolean;
}

const ELEMENT: Record<number, string> = {
  0x01: "void", 0x02: "bool", 0x03: "char", 0x04: "sbyte", 0x05: "byte", 0x06: "short", 0x07: "ushort",
  0x08: "int", 0x09: "uint", 0x0a: "long", 0x0b: "ulong", 0x0c: "float", 0x0d: "double", 0x0e: "string",
  0x18: "IntPtr", 0x19: "UIntPtr", 0x1c: "object",
};

// Metadata table numbers used here.
const T = { Module: 0x00, TypeRef: 0x01, TypeDef: 0x02, FieldPtr: 0x03, Field: 0x04, MethodPtr: 0x05, MethodDef: 0x06, ModuleRef: 0x1a, TypeSpec: 0x1b, AssemblyRef: 0x23 };

export function readFields(buf: Buffer): FieldInfo[] {
  // --- PE: find the CLI header and map RVAs to file offsets ---
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("Not a PE file.");
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const pe32plus = buf.readUInt16LE(opt) === 0x20b;
  const dirs = opt + (pe32plus ? 112 : 96);
  const cliRva = buf.readUInt32LE(dirs + 14 * 8);
  if (!cliRva) throw new Error("Not a .NET assembly.");
  const secTable = opt + optSize;
  const rvaToOffset = (rva: number): number => {
    for (let i = 0; i < sections; i++) {
      const s = secTable + i * 40;
      const va = buf.readUInt32LE(s + 12);
      const size = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16));
      if (rva >= va && rva < va + size) return rva - va + buf.readUInt32LE(s + 20);
    }
    throw new Error(`RVA ${rva} is outside every section.`);
  };
  const cli = rvaToOffset(cliRva);
  const meta = rvaToOffset(buf.readUInt32LE(cli + 8));

  // --- metadata root and streams ---
  if (buf.readUInt32LE(meta) !== 0x424a5342) throw new Error("Bad metadata signature.");
  const versionLen = buf.readUInt32LE(meta + 12);
  let p = meta + 16 + versionLen + 2;
  const streamCount = buf.readUInt16LE(p);
  p += 2;
  const streams: Record<string, { offset: number; size: number }> = {};
  for (let i = 0; i < streamCount; i++) {
    const offset = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    let end = p + 8;
    while (buf[end] !== 0) end++;
    const name = buf.toString("latin1", p + 8, end);
    streams[name] = { offset: meta + offset, size };
    p = p + 8 + (((end - (p + 8)) >> 2) + 1) * 4;
  }
  const tables = streams["#~"] ?? streams["#-"];
  const strings = streams["#Strings"];
  const blob = streams["#Blob"];
  if (!tables || !strings || !blob) throw new Error("Missing metadata streams.");

  // --- table stream header ---
  const heapSizes = buf[tables.offset + 6];
  const valid = buf.readBigUInt64LE(tables.offset + 8);
  const rows = new Array<number>(64).fill(0);
  p = tables.offset + 24;
  for (let t = 0; t < 64; t++) {
    if ((valid >> BigInt(t)) & 1n) {
      rows[t] = buf.readUInt32LE(p);
      p += 4;
    }
  }
  if (streams["#-"] && heapSizes & 0x40) p += 4; // extra data in uncompressed streams
  const strIdx = heapSizes & 0x01 ? 4 : 2;
  const guidIdx = heapSizes & 0x02 ? 4 : 2;
  const blobIdx = heapSizes & 0x04 ? 4 : 2;
  const idx = (t: number) => (rows[t] < 0x10000 ? 2 : 4);
  const coded = (bits: number, ts: number[]) => (Math.max(...ts.map((t) => rows[t])) < 1 << (16 - bits) ? 2 : 4);
  const resolutionScope = coded(2, [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef]);
  const typeDefOrRef = coded(2, [T.TypeDef, T.TypeRef, T.TypeSpec]);

  const rowSize = {
    [T.Module]: 2 + strIdx + guidIdx * 3,
    [T.TypeRef]: resolutionScope + strIdx * 2,
    [T.TypeDef]: 4 + strIdx * 2 + typeDefOrRef + idx(T.Field) + idx(T.MethodDef),
    [T.FieldPtr]: idx(T.Field),
    [T.Field]: 2 + strIdx + blobIdx,
  };
  const start: Record<number, number> = {};
  let cursor = p;
  for (const t of [T.Module, T.TypeRef, T.TypeDef, T.FieldPtr, T.Field]) {
    start[t] = cursor;
    cursor += rows[t] * rowSize[t];
  }

  const u = (at: number, size: number) => (size === 2 ? buf.readUInt16LE(at) : buf.readUInt32LE(at));
  const str = (i: number) => {
    const at = strings.offset + i;
    let end = at;
    while (buf[end] !== 0) end++;
    return buf.toString("utf8", at, end);
  };

  // --- type names ---
  const typeRefName = (row: number) => {
    const at = start[T.TypeRef] + (row - 1) * rowSize[T.TypeRef] + resolutionScope;
    return str(u(at, strIdx));
  };
  const typeDefs: { name: string; ns: string; fieldList: number }[] = [];
  for (let r = 0; r < rows[T.TypeDef]; r++) {
    const at = start[T.TypeDef] + r * rowSize[T.TypeDef];
    typeDefs.push({
      name: str(u(at + 4, strIdx)),
      ns: str(u(at + 4 + strIdx, strIdx)),
      fieldList: u(at + 4 + strIdx * 2 + typeDefOrRef, idx(T.Field)),
    });
  }
  const typeName = (codedIndex: number) => {
    const row = codedIndex >> 2;
    switch (codedIndex & 3) {
      case 0:
        return typeDefs[row - 1]?.name ?? "?";
      case 1:
        return typeRefName(row);
      default:
        return "?";
    }
  };

  // --- field signatures ---
  const compressed = (at: { p: number }) => {
    const b = buf[at.p];
    if ((b & 0x80) === 0) {
      at.p += 1;
      return b;
    }
    if ((b & 0xc0) === 0x80) {
      const v = ((b & 0x3f) << 8) | buf[at.p + 1];
      at.p += 2;
      return v;
    }
    const v = ((b & 0x1f) << 24) | (buf[at.p + 1] << 16) | (buf[at.p + 2] << 8) | buf[at.p + 3];
    at.p += 4;
    return v;
  };
  const sigType = (at: { p: number }, depth = 0): string => {
    if (depth > 8) return "?";
    const e = buf[at.p++];
    if (ELEMENT[e]) return ELEMENT[e];
    switch (e) {
      case 0x0f:
        return `${sigType(at, depth + 1)}*`;
      case 0x10:
        return `ref ${sigType(at, depth + 1)}`;
      case 0x11: // valuetype
      case 0x12: // class
        return typeName(compressed(at)).replace(/`\d+$/, "");
      case 0x13:
        return `T${compressed(at)}`;
      case 0x1e:
        return `M${compressed(at)}`;
      case 0x1d:
        return `${sigType(at, depth + 1)}[]`;
      case 0x14: {
        const inner = sigType(at, depth + 1);
        const rank = compressed(at);
        const sizes = compressed(at);
        for (let i = 0; i < sizes; i++) compressed(at);
        const bounds = compressed(at);
        for (let i = 0; i < bounds; i++) compressed(at);
        return `${inner}[${",".repeat(Math.max(0, rank - 1))}]`;
      }
      case 0x15: {
        const generic = sigType(at, depth + 1);
        const n = compressed(at);
        const args = Array.from({ length: n }, () => sigType(at, depth + 1));
        return generic === "Nullable" ? `${args[0]}?` : `${generic}<${args.join(", ")}>`;
      }
      case 0x1f:
      case 0x20: // custom modifiers (e.g. volatile): skip and read the real type
        compressed(at);
        return sigType(at, depth + 1);
      default:
        return "?";
    }
  };
  const fieldSig = (blobIndex: number) => {
    const at = { p: blob.offset + blobIndex };
    compressed(at); // blob length
    if (buf[at.p++] !== 0x06) return "?";
    return sigType(at);
  };

  // --- fields, grouped by the type that declares them ---
  const fields: FieldInfo[] = [];
  for (let t = 0; t < typeDefs.length; t++) {
    const first = typeDefs[t].fieldList;
    const end = t + 1 < typeDefs.length ? typeDefs[t + 1].fieldList : rows[T.Field] + 1;
    const owner = typeDefs[t].ns ? `${typeDefs[t].ns}.${typeDefs[t].name}` : typeDefs[t].name;
    for (let f = first; f < end && f <= rows[T.Field]; f++) {
      const at = start[T.Field] + (f - 1) * rowSize[T.Field];
      const flags = buf.readUInt16LE(at);
      const rawName = str(u(at + 2, strIdx));
      fields.push({
        type: owner,
        // Auto-properties compile to "<Soup>k__BackingField".
        name: rawName.replace(/^<(.+)>k__BackingField$/, "$1"),
        valueType: fieldSig(u(at + 2 + strIdx, blobIdx)),
        isStatic: (flags & 0x10) !== 0,
        isConst: (flags & 0x40) !== 0,
      });
    }
  }
  return fields;
}

/** How Telos's memory scanner would search for a field of this .NET type, if it can. */
export function scanTypeFor(valueType: string): string | null {
  return (
    {
      int: "int32", uint: "int32", float: "float", double: "double", long: "int64", ulong: "int64",
      short: "int16", ushort: "int16", byte: "int8", sbyte: "int8", bool: "int8",
    }[valueType.replace(/\?$/, "")] ?? null
  );
}

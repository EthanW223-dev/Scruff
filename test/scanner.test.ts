import assert from "node:assert/strict";
import { test } from "node:test";
import { Scanner } from "../src/memory/scanner.ts";
import { encode, type ProcessBackend, type Region, type ValueType } from "../src/memory/types.ts";

/** A fake process: a few regions of memory with values planted at known spots. */
class FakeBackend implements ProcessBackend {
  readonly pid = 1;
  private mem = new Map<number, Buffer>();

  constructor(layout: Region[]) {
    for (const r of layout) this.mem.set(r.base, Buffer.alloc(r.size));
  }
  set(address: number, type: ValueType, value: number): void {
    const [base, buf] = this.find(address);
    encode(value, type).copy(buf, address - base);
  }
  regions(): Region[] {
    return [...this.mem.entries()].map(([base, buf]) => ({ base, size: buf.length })).sort((a, b) => a.base - b.base);
  }
  read(address: number, out: Buffer): number {
    const hit = this.findOrNull(address);
    if (!hit) return 0;
    const [base, buf] = hit;
    return buf.copy(out, 0, address - base, Math.min(buf.length, address - base + out.length));
  }
  write(address: number, data: Buffer): boolean {
    const [base, buf] = this.find(address);
    data.copy(buf, address - base);
    return true;
  }
  close(): void {}
  free(base: number): void {
    this.mem.delete(base);
  }
  private findOrNull(address: number): [number, Buffer] | null {
    for (const [base, buf] of this.mem) if (address >= base && address < base + buf.length) return [base, buf];
    return null;
  }
  private find(address: number): [number, Buffer] {
    const hit = this.findOrNull(address);
    if (!hit) throw new Error(`unmapped ${address}`);
    return hit;
  }
}

const A = 0x10000;
const B = 0x7f0000000000; // high address like a real 64-bit heap
const layout = [
  { base: A, size: 64 * 1024 },
  { base: B, size: 9 * 1024 * 1024 }, // spans several 4 MB chunks
];

test("finds an int32 and narrows it down as it changes", async () => {
  const mem = new FakeBackend(layout);
  const gold = B + 4 * 1024 * 1024 + 1236; // just past a chunk boundary
  const decoys = [A + 40, B + 100, B + 8 * 1024 * 1024];
  mem.set(gold, "int32", 350);
  for (const d of decoys) mem.set(d, "int32", 350);

  const scanner = new Scanner(mem);
  const first = await scanner.firstScan("int32", { mode: "exact", value: 350 });
  assert.equal(first.count, 4);

  mem.set(gold, "int32", 325); // player spends 25 gold
  mem.set(decoys[0], "int32", 999);
  const second = await scanner.refine({ mode: "exact", value: 325 });
  assert.equal(second.count, 1);
  assert.deepEqual(scanner.sample(5), [{ address: gold, value: 325 }]);
  assert.equal(scanner.includes(gold), true);
  assert.equal(scanner.includes(decoys[1]), false);
});

test("relative refines: decreased, unchanged, decreased_by", async () => {
  const mem = new FakeBackend(layout);
  const hp = A + 400;
  mem.set(hp, "int32", 100);
  mem.set(A + 800, "int32", 100);
  mem.set(A + 1200, "int32", 100);
  const scanner = new Scanner(mem);
  await scanner.firstScan("int32", { mode: "exact", value: 100 });

  mem.set(hp, "int32", 88);
  mem.set(A + 800, "int32", 120);
  assert.equal((await scanner.refine({ mode: "decreased" })).count, 1);
  assert.equal((await scanner.refine({ mode: "unchanged" })).count, 1);
  mem.set(hp, "int32", 80);
  assert.equal((await scanner.refine({ mode: "decreased_by", value: 8 })).count, 1);
  assert.equal(scanner.resultAddresses(10)[0], hp);
});

test("float scan matches what the HUD shows, not the exact bits", async () => {
  const mem = new FakeBackend(layout);
  mem.set(A + 64, "float", 72.8); // HUD shows "72" (floor) or "73" (round)
  mem.set(A + 128, "float", 71.2);
  const scanner = new Scanner(mem);
  assert.equal((await scanner.firstScan("float", { mode: "exact", value: 72 })).count, 1);
  assert.equal((await scanner.firstScan("float", { mode: "exact", value: 73 })).count, 1);
  assert.equal((await scanner.firstScan("float", { mode: "range", min: 70, max: 80 })).count, 2);
});

test("doubles and int64 work at 4-byte alignment, including across chunk edges", async () => {
  const mem = new FakeBackend(layout);
  const edge = B + 4 * 1024 * 1024 - 4; // 8-byte value straddling two 4 MB chunks
  mem.set(edge, "double", 1234.5);
  mem.set(A + 12, "int64", 9_000_000_000);
  const scanner = new Scanner(mem);
  assert.deepEqual(scanner.resultAddresses(1), []);
  await scanner.firstScan("double", { mode: "exact", value: 1234.5 });
  assert.deepEqual(scanner.resultAddresses(5), [edge]);
  await scanner.firstScan("int64", { mode: "exact", value: 9_000_000_000 });
  assert.deepEqual(scanner.resultAddresses(5), [A + 12]);
});

test("results in freed memory are dropped on refine", async () => {
  const mem = new FakeBackend(layout);
  mem.set(A + 8, "int32", 4242);
  mem.set(B + 8, "int32", 4242);
  const scanner = new Scanner(mem);
  await scanner.firstScan("int32", { mode: "exact", value: 4242 });
  mem.free(A);
  assert.equal((await scanner.refine({ mode: "unchanged" })).count, 1);
});

test("a too-common value stops at the result cap and says so", async () => {
  const mem = new FakeBackend(layout);
  const scanner = new Scanner(mem, 1000);
  const summary = await scanner.firstScan("int32", { mode: "exact", value: 0 });
  assert.equal(summary.count, 1000);
  assert.equal(summary.truncated, true);
});

test("dense refine reads spans, not one address at a time", async () => {
  const mem = new FakeBackend(layout);
  for (let i = 0; i < 5000; i++) mem.set(B + i * 64, "int32", 7);
  const scanner = new Scanner(mem);
  await scanner.firstScan("int32", { mode: "exact", value: 7 });
  assert.equal(scanner.count, 5000);
  for (let i = 0; i < 5000; i += 2) mem.set(B + i * 64, "int32", 8);
  assert.equal((await scanner.refine({ mode: "increased" })).count, 2500);
  assert.equal((await scanner.refine({ mode: "exact", value: 8 })).count, 2500);
});

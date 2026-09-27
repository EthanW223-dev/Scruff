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
  assert.deepEqual(scanner.sample(5), [{ address: gold, value: 325, type: "int32" }]);
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

test("scanning several types at once finds a value stored as a decimal (60 Seconds' soup: 6 → 5.25)", async () => {
  const mem = new FakeBackend(layout);
  const soup = B + 2048;
  mem.set(soup, "float", 6);
  for (let i = 0; i < 300; i++) mem.set(A + i * 16, "int32", 6); // lots of unrelated whole-number 6s
  const scanner = new Scanner(mem);
  const first = await scanner.firstScan(["int32", "float", "double"], { mode: "exact", value: 6 });
  assert.equal(first.byType.int32, 300);
  assert.equal(first.byType.float, 1);

  mem.set(soup, "float", 5.25); // the family ate a quarter can
  const second = await scanner.refine({ mode: "exact", value: 5.25 });
  assert.equal(second.count, 1, "only the float survives: whole numbers can't be 5.25");
  assert.deepEqual(scanner.types, ["float"]);
  assert.equal(scanner.typeOf(soup), "float");
  assert.equal(scanner.typeOf(A), null);
});

test("a fractional first value skips whole-number types instead of scanning for nothing", async () => {
  const mem = new FakeBackend(layout);
  mem.set(A + 100, "float", 5.25);
  const scanner = new Scanner(mem);
  const summary = await scanner.firstScan(["int32", "float"], { mode: "exact", value: 5.25 });
  assert.deepEqual(summary.byType, { float: 1 });
});

test("narrowing keeps only places that changed to the new number (5 → 4.75 soup, with static 4.75s around)", async () => {
  const mem = new FakeBackend(layout);
  const soup = B + 4096;
  mem.set(soup, "float", 5);
  for (let i = 0; i < 200; i++) mem.set(A + i * 32, "float", 4.75); // unrelated values that are 4.75 all along
  const scanner = new Scanner(mem);
  // "5" on screen matches 4.5–5.99 for floats, which includes the static 4.75s.
  await scanner.firstScan(["int32", "float", "double"], { mode: "exact", value: 5 });
  assert.ok(scanner.count > 200);

  mem.set(soup, "float", 4.75);
  assert.equal((await scanner.refine({ mode: "exact", value: 4.75 })).count > 1, true, "plain exact keeps the static ones");
  const again = new Scanner(mem);
  mem.set(soup, "float", 5);
  await again.firstScan(["int32", "float", "double"], { mode: "exact", value: 5 });
  mem.set(soup, "float", 4.75);
  const narrowed = await again.refine({ mode: "changed_to", value: 4.75 });
  assert.equal(narrowed.count, 1);
  assert.equal(again.typeOf(soup), "float");
});

test("live watching drops values that change on their own and keeps the player's number", async () => {
  const mem = new FakeBackend(layout);
  const soup = A + 8;
  const noise = [A + 64, A + 128, A + 192];
  mem.set(soup, "float", 4.75);
  for (const n of noise) mem.set(n, "float", 4.75);
  const scanner = new Scanner(mem);
  await scanner.firstScan("float", { mode: "exact", value: 4.75 });
  assert.equal(scanner.count, 4);
  for (let tick = 1; tick <= 5; tick++) {
    noise.forEach((n, i) => mem.set(n, "float", 4.75 + tick * 0.1 + i)); // animations, timers...
    if (tick === 2) mem.set(soup, "float", 4.5); // the family eats once
    scanner.watchTick(5);
  }
  assert.deepEqual(scanner.resultAddresses(10), [soup]);
});

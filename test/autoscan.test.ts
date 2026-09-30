import assert from "node:assert/strict";
import { test } from "node:test";
import { GameManager, memoryTools } from "../src/hub/game.ts";
import type { AgentEvent } from "../src/hub/agent.ts";
import { quickPath } from "../src/hub/quick.ts";
import type { ChoiceAnswer, Jev, JevQuestion } from "../src/hub/jev.ts";
import { GameSession } from "../src/memory/session.ts";
import { decode, encode, type ProcessBackend, type ProcessInfo, type Region, type ValueType } from "../src/memory/types.ts";
import type { VisionClient } from "../src/hub/vision.ts";

// The hands-free fast path, end to end on a fake game: "give me 99 food" reads the current
// number off the HUD, watches the screen while the number changes, narrows without asking,
// then writes candidates one at a time and only claims success when the screen confirms it.

/** A fake process: one region with int32 values planted at known spots. */
class FakeBackend implements ProcessBackend {
  readonly pid = 4242;
  private buf = Buffer.alloc(0x10000);

  constructor(readonly plants: number[]) {}

  set(address: number, type: ValueType, value: number): void {
    encode(value, type).copy(this.buf, address);
  }

  get(address: number, type: ValueType): number {
    const out = Buffer.alloc(8);
    this.read(address, out);
    return decode(out, 0, type);
  }

  regions(): Region[] {
    return [{ base: 0, size: this.buf.length }];
  }

  read(address: number, out: Buffer): number {
    if (address < 0 || address + out.length > this.buf.length) return 0;
    return this.buf.copy(out, 0, address, address + out.length);
  }

  write(address: number, data: Buffer): boolean {
    if (address < 0 || address + data.length > this.buf.length) return false;
    data.copy(this.buf, address);
    return true;
  }

  close(): void {}
}

function fakeJev(pick: (id: string, keys: string[], criteria: Record<string, unknown>) => string): Jev {
  return {
    model: "fake-jev",
    ask: async (_state, questions) => {
      const answers: Record<string, ChoiceAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const criteria = ((q as JevQuestion & { criteria?: Record<string, unknown> }).criteria ?? {}) as Record<string, unknown>;
        const keys = Object.keys(criteria);
        const choice = pick(id, keys, criteria);
        answers[id] = {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
          confidence: 0.95,
        };
      }
      return { model: "fake-jev", answers };
    },
  };
}

const plants = Array.from({ length: 20 }, (_, i) => 0x1000 + i * 0x10);

test("hands-free: read HUD, auto-narrow on change, verify each write on screen", async () => {
  const backend = new FakeBackend(plants);
  for (const a of plants) backend.set(a, "int32", 12);

  const games = new GameManager();
  const target: ProcessInfo = { pid: process.pid, name: "TestGame", title: "TestGame" };
  const session = new GameSession(target, backend);
  games.session = session;
  const tools = memoryTools(games, () => ({}));

  // The "player" eats twice while Telos watches: 12 of the 20 go 12 -> 11, then 2 go 11 -> 10.
  const eaten1 = plants.slice(0, 12);
  const eaten2 = plants.slice(0, 2);
  let visionCalls = 0;
  let confirms = 0;
  const vision: VisionClient = {
    model: "fake-vision",
    ask: async (_jpeg, _question, _signal) => {
      switch (visionCalls++) {
        case 0:
          return "12"; // initial read off the HUD
        case 1:
        case 2:
          return "12"; // polls: nothing changed yet
        case 3:
          for (const a of eaten1) backend.set(a, "int32", 11);
          return "11"; // the player ate: change spotted...
        case 4:
          return "11"; // ...confirmed by a second read
        case 5:
        case 6:
          return "11"; // polls: nothing changed yet
        case 7:
          for (const a of eaten2) backend.set(a, "int32", 10);
          return "10"; // ate again
        case 8:
          return "10"; // confirmed
        default: {
          // writeVerified: first candidate is a copy (screen still shows 11), second is real.
          confirms++;
          return confirms === 1 ? "The soup count shows 11." : "The soup count shows 99.";
        }
      }
    },
  };

  const jev = fakeJev((id, keys, criteria) => {
    if (id === "intent") return "find_and_change";
    if (id === "wanted_number") return keys.find((k) => String(criteria[k]).startsWith("99")) ?? "none";
    if (id === "current_number") return "none"; // the player didn't say how much they have
    if (id === "thing") return keys.find((k) => /food/i.test(String(criteria[k]))) ?? "none";
    return keys.includes("none") ? "none" : keys[0];
  });

  const events: AgentEvent[] = [];
  const handler = quickPath({
    jev: () => jev,
    games,
    tools,
    chatReady: () => false,
    capture: async () => "fake-jpeg",
    vision: () => vision,
    watch: { pollMs: 5, timeoutMs: 10_000 },
  });
  const outcome = await handler("give me 99 food", (e) => events.push(e), new AbortController().signal);

  assert.equal(outcome.handled, true);
  const reply = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.match(reply, /Done — the game shows food at 99/);

  // The rejected copy was undone; only the confirmed write stands.
  const writes = events
    .filter((e) => e.type === "tool_call" && (e as any).name === "write_value")
    .map((e) => (e as any).input.addresses[0] as string);
  assert.equal(writes.length, 2);
  assert.equal(backend.get(parseInt(writes[0]), "int32"), 10); // undone: back to 10
  assert.equal(backend.get(parseInt(writes[1]), "int32"), 99); // confirmed: the game shows it
  const live = session.changes.filter((c) => !c.undone);
  assert.equal(live.length, 1);

  // The whole thing ran hands-free: watching and on-screen verification happened.
  const toolNames = events.filter((e) => e.type === "tool_call").map((e) => (e as any).name);
  assert.ok(toolNames.includes("watch_screen"), "watched the screen");
  assert.ok(toolNames.includes("verify_on_screen"), "verified on screen");

  session.close();
});

test("hands-free falls back to asking when the screen can't be read", async () => {
  const backend = new FakeBackend(plants);
  for (const a of plants) backend.set(a, "int32", 12);

  const games = new GameManager();
  games.session = new GameSession({ pid: process.pid, name: "TestGame", title: "TestGame" }, backend);
  const tools = memoryTools(games, () => ({}));
  const jev = fakeJev((id, keys, criteria) => {
    if (id === "intent") return "find_and_change";
    if (id === "wanted_number") return keys.find((k) => String(criteria[k]).startsWith("99")) ?? "none";
    if (id === "current_number") return keys.find((k) => String(criteria[k]).startsWith("12")) ?? "none";
    if (id === "thing") return keys.find((k) => /food/i.test(String(criteria[k]))) ?? "none";
    return keys.includes("none") ? "none" : keys[0];
  });

  const events: AgentEvent[] = [];
  const handler = quickPath({
    jev: () => jev,
    games,
    tools,
    chatReady: () => false,
    // No capture or vision: the old ask-the-player flow.
  });
  const outcome = await handler("I have 12 food, give me 99", (e) => events.push(e), new AbortController().signal);
  assert.equal(outcome.handled, true);
  const reply = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.match(reply, /tell me the new number/);
  games.session?.close();
});

test("a misread that empties the search restarts fresh instead of watching nothing", async () => {
  const backend = new FakeBackend(plants);
  for (const a of plants) backend.set(a, "int32", 12);

  const games = new GameManager();
  const session = new GameSession(
    { pid: process.pid, name: "TestGame", title: "TestGame" },
    backend,
  );
  games.session = session;
  const tools = memoryTools(games, () => ({}));

  const eaten1 = plants.slice(0, 12);
  const eaten2 = plants.slice(0, 2);
  let visionCalls = 0;
  let confirms = 0;
  const vision: VisionClient = {
    model: "fake-vision",
    ask: async (_jpeg, _question, _signal) => {
      switch (visionCalls++) {
        case 0:
          return "12"; // initial read off the HUD
        case 1:
          return "12"; // poll: nothing changed yet
        case 2:
          return "7"; // misread: two agreeing reads...
        case 3:
          return "7"; // ...so the refine runs and matches nothing
        case 4:
          return "12"; // poll after the fresh restart: back at the trusted number
        case 5:
          for (const a of eaten1) backend.set(a, "int32", 11);
          return "11"; // the player really ate
        case 6:
          return "11"; // confirmed
        case 7:
          return "11"; // poll
        case 8:
          for (const a of eaten2) backend.set(a, "int32", 10);
          return "10"; // ate again
        case 9:
          return "10"; // confirmed
        default: {
          confirms++;
          return confirms === 1 ? "The soup count shows 11." : "The soup count shows 99.";
        }
      }
    },
  };

  const jev = fakeJev((id, keys, criteria) => {
    if (id === "intent") return "find_and_change";
    if (id === "wanted_number") return keys.find((k) => String(criteria[k]).startsWith("99")) ?? "none";
    if (id === "current_number") return "none";
    if (id === "thing") return keys.find((k) => /food/i.test(String(criteria[k]))) ?? "none";
    return keys.includes("none") ? "none" : keys[0];
  });

  const events: AgentEvent[] = [];
  const handler = quickPath({
    jev: () => jev,
    games,
    tools,
    chatReady: () => false,
    capture: async () => "fake-jpeg",
    vision: () => vision,
    watch: { pollMs: 5, timeoutMs: 10_000 },
  });
  const outcome = await handler("give me 99 food", (e) => events.push(e), new AbortController().signal);

  assert.equal(outcome.handled, true);
  // The misread emptied the search; Telos restarted it fresh instead of watching on nothing.
  const progress = events
    .filter((e) => e.type === "tool_progress")
    .map((e) => (e as { text: string }).text)
    .join("\n");
  assert.match(progress, /restarting the search from 12/);
  // ...and still finished the job hands-free afterwards.
  const reply = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.match(reply, /Done — the game shows food at 99/);
  session.close();
});

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { openBackend } from "../src/memory/platform.ts";
import { GameSession } from "../src/memory/session.ts";

// Attaches to the real demo game process and edits its memory, end to end.
// Needs permission to read another process's memory (root, or ptrace_scope 0 on Linux).

let game: ChildProcessWithoutNullStreams;
let lines: AsyncIterator<string>;
let session: GameSession;

async function command(cmd: string): Promise<Record<string, any>> {
  game.stdin.write(cmd + "\n");
  return JSON.parse((await lines.next()).value);
}

before(async () => {
  game = spawn(process.execPath, ["examples/demo-game/game.mjs", "--headless", "--offline"]);
  lines = readline.createInterface({ input: game.stdout })[Symbol.asyncIterator]();
  const ready = JSON.parse((await lines.next()).value);
  assert.equal(ready.gold, 350);
  session = new GameSession({ pid: game.pid!, name: "demo" }, openBackend(game.pid!));
});

after(() => {
  session?.close();
  game?.kill();
});

test("find gold, narrow it down, set it, undo it", async () => {
  const first = await session.scanner.firstScan("int32", { mode: "exact", value: 350 });
  assert.ok(first.count >= 1, "gold should be found");

  let state = await command("spend 25");
  assert.equal(state.gold, 325);
  await session.scanner.refine({ mode: "exact", value: 325 });
  state = await command("earn 100");
  await session.scanner.refine({ mode: "exact", value: 425 });
  assert.equal(session.scanner.count, 1, "exactly one address should hold the gold");

  const [address] = session.scanner.resultAddresses(1);
  const change = session.write(address, "int32", 99999, "Gold");
  assert.equal((await command("print")).gold, 99999);

  session.undo(change.id);
  assert.equal((await command("print")).gold, 425);
});

test("find a float health value by how it changed, then freeze it", async () => {
  await session.scanner.firstScan("float", { mode: "exact", value: 100 });
  await command("damage 12.5");
  await session.scanner.refine({ mode: "decreased" });
  await command("damage 3");
  await session.scanner.refine({ mode: "decreased_by", value: 3 });
  await session.scanner.refine({ mode: "exact", value: 84.5, tolerance: 0.01 });
  assert.equal(session.scanner.count, 1);

  const [address] = session.scanner.resultAddresses(1);
  session.freeze(address, "float", 100, "Health");
  await command("damage 50");
  await new Promise((r) => setTimeout(r, 250)); // freeze loop rewrites it
  assert.equal((await command("print")).health, 100);

  session.undo();
  assert.equal(session.watch.get(address)?.frozenValue, null);
});

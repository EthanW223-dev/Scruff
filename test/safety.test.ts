import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAttachSafety } from "../src/memory/safety.ts";

const game = { pid: 10, name: "Stardew Valley.exe", title: "Stardew Valley" };

test("allows a single-player game", () => {
  assert.equal(checkAttachSafety(game, [game, { pid: 2, name: "explorer.exe" }]).ok, true);
});

test("refuses while an anti-cheat service is running, however Windows names it", () => {
  for (const name of ["EasyAntiCheat.exe", "BEService", "vgc.exe", "GameMon.des"]) {
    const verdict = checkAttachSafety(game, [game, { pid: 3, name }]);
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.reason!, /anti-cheat|banned/i);
  }
});

test("refuses known online games even without a separate anti-cheat process", () => {
  assert.equal(checkAttachSafety({ pid: 11, name: "cs2.exe" }, []).ok, false);
  assert.equal(checkAttachSafety({ pid: 11, name: "cs2" }, []).ok, false);
});

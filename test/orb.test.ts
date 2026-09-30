import assert from "node:assert/strict";
import { test } from "node:test";
import { MODE_FRAMES, resolvePreset, STATE_TO_MODE } from "thinking-orbs/engine";

// dashboard/orb.js is plain JS outside the TS build; import it dynamically.
// @ts-ignore: no declaration file for the dashboard JS
const { ORB_STATES, parseTint } = (await import("../dashboard/orb.js")) as {
  ORB_STATES: string[];
  parseTint: (c: string | null | undefined) => { r: number; g: number; b: number } | undefined;
};

// The HUD icon: nine thinking-orbs animations, one per agent state.

test("all nine orb states resolve to a tuned preset with a frame function", () => {
  assert.equal(ORB_STATES.length, 9);
  for (const state of ORB_STATES) {
    const { mode, speed, opts } = resolvePreset(state as any, 64);
    assert.equal(mode, (STATE_TO_MODE as any)[state], `${state} maps to its mode`);
    assert.equal(typeof MODE_FRAMES[mode], "function", `${state} has a frame function`);
    assert.ok(speed > 0 && opts, `${state} has speed and opts`);
  }
});

test("every agent state Ethan named has a matching orb", () => {
  for (const s of ["listening", "breathing", "composing", "weaving", "working", "searching", "solving", "shaping", "connecting"]) {
    assert.ok(ORB_STATES.includes(s), `orb state: ${s}`);
  }
});

test("parseTint reads hex and rgb, and yields grayscale (undefined) otherwise", () => {
  assert.deepEqual(parseTint("#ef7b9c"), { r: 239, g: 123, b: 156 });
  assert.deepEqual(parseTint("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseTint("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30 });
  assert.equal(parseTint("not a color"), undefined);
  assert.equal(parseTint(null), undefined);
  assert.equal(parseTint(undefined), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";

// dashboard/orb.js is plain JS outside the TS build; import it dynamically.
// @ts-ignore: no declaration file for the dashboard JS
const { ORB_STATES, GRID, parseTint, AgentOrb } = (await import("../dashboard/orb.js")) as {
  ORB_STATES: string[];
  GRID: number;
  parseTint: (c: string | null | undefined) => { r: number; g: number; b: number } | undefined;
  AgentOrb: new (
    canvas: any,
    opts?: { size?: number; speed?: number; dark?: boolean },
  ) => {
    setHover: (h: boolean) => void;
    setState: (s: string) => void;
    setColor: (c: string | null) => void;
    destroy: () => void;
    paint: (t: number) => void;
    frame: (state: string, t: number, into: Float32Array) => Float32Array;
    energy: number;
    prev: string | null;
  };
};

// The HUD icon: a 16×16 pixel sprite of the spark, one stepped animation per agent state
// (and the mod builder's hammer).

/** A canvas whose 2d context records every fill. Node has no canvas or rAF. */
function fakeCanvas() {
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  const ctx: any = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: ctx.fillStyle, x, y, w, h });
    },
    clearRect() {
      fills.length = 0;
    },
    setTransform() {},
  };
  return { canvas: { width: 0, height: 0, getContext: () => ctx, setAttribute: () => {} }, fills };
}

const lit = (f: Float32Array) => [...f].filter((v) => v > 0.1).length;

test("all eleven states draw a sprite inside the grid, and all but the resting hammer move", () => {
  const { canvas } = fakeCanvas();
  const orb = new AgentOrb(canvas, { size: 64 });
  try {
    assert.equal(canvas.width, GRID, "the canvas is the sprite's own size; CSS scales it up crisp");
    assert.equal(ORB_STATES.length, 11);
    for (const state of ORB_STATES) {
      const frames = [0, 0.4, 0.9, 1.7, 2.6].map((t) => Array.from(orb.frame(state, t, new Float32Array(GRID * GRID))));
      for (const f of frames) {
        assert.ok(lit(Float32Array.from(f)) >= 1, `${state} draws something (the reply page starts empty)`);
        assert.ok(f.every((v) => v >= 0 && v <= 1), `${state} stays in tone range`);
      }
      assert.ok(Math.max(...frames.map((f) => lit(Float32Array.from(f)))) >= 8, `${state} draws a shape`);
      const distinct = new Set(frames.map((f) => f.join(","))).size;
      if (state === "resting") assert.equal(distinct, 1, "a finished build's hammer lies still");
      else assert.ok(distinct >= 2, `${state} moves (got ${distinct} distinct frames)`);
    }
  } finally {
    orb.destroy();
  }
});

test("the spark at rest is symmetric: the middle falls between the center cells", () => {
  const { canvas } = fakeCanvas();
  const orb = new AgentOrb(canvas);
  try {
    // A frame with no glint running across the gem.
    const f = orb.frame("breathing", 1.0, new Float32Array(GRID * GRID));
    const on = (x: number, y: number) => f[y * GRID + x] > 0.1;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        assert.equal(on(x, y), on(GRID - 1 - x, y), `left-right at ${x},${y}`);
        assert.equal(on(x, y), on(x, GRID - 1 - y), `top-bottom at ${x},${y}`);
      }
    }
  } finally {
    orb.destroy();
  }
});

test("every agent state Ethan named has a matching orb", () => {
  for (const s of ["listening", "breathing", "composing", "weaving", "working", "searching", "solving", "shaping", "connecting"]) {
    assert.ok(ORB_STATES.includes(s), `orb state: ${s}`);
  }
});

test("parseTint reads hex and rgb, and yields the default ink (undefined) otherwise", () => {
  assert.deepEqual(parseTint("#ef7b9c"), { r: 239, g: 123, b: 156 });
  assert.deepEqual(parseTint("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseTint("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30 });
  assert.equal(parseTint("not a color"), undefined);
  assert.equal(parseTint(null), undefined);
  assert.equal(parseTint(undefined), undefined);
});

test("one ink in a few shades: the game's accent when set, with a hard shadow", () => {
  const { canvas, fills } = fakeCanvas();
  const orb = new AgentOrb(canvas);
  try {
    orb.setColor("#8fd14f");
    orb.paint(1.0);
    assert.ok(fills.length > 0);
    for (const { style } of fills) assert.match(style, /^rgba?\(143, 209, 79(, [\d.]+)?\)$/, `drawn in the accent: ${style}`);
    const shades = new Set(fills.map((f) => f.style));
    assert.ok(shades.has("rgb(143, 209, 79)"), "solid cells");
    assert.ok([...shades].some((s) => s.startsWith("rgba(")), "dimmer shades and the shadow");
    for (const { x, y, w, h } of fills) assert.ok(x >= 0 && y >= 0 && x + w <= GRID && y + h <= GRID && h === 1, "whole cells in the grid");
  } finally {
    orb.destroy();
  }
});

test("a new state dissolves in, then takes over", async () => {
  const { canvas } = fakeCanvas();
  const orb = new AgentOrb(canvas);
  try {
    orb.setState("listening");
    orb.paint(0.5);
    assert.equal(orb.prev, "breathing", "mid-dissolve, the old state still shows through");
    await new Promise((r) => setTimeout(r, 360));
    orb.paint(0.6);
    assert.equal(orb.prev, null);
  } finally {
    orb.destroy();
  }
});

test("hover wakes the orb itself: energy rises under the cursor and settles after", () => {
  const { canvas } = fakeCanvas();
  const orb = new AgentOrb(canvas, { size: 64 });
  try {
    assert.equal(orb.energy, 0);
    orb.setHover(true);
    for (let i = 0; i < 40; i++) orb.paint(i / 60);
    assert.ok(orb.energy > 0.9, `energy rises on hover, got ${orb.energy}`);
    orb.setHover(false);
    for (let i = 0; i < 80; i++) orb.paint(i / 60);
    assert.ok(orb.energy < 0.05, `energy settles after hover, got ${orb.energy}`);
  } finally {
    orb.destroy();
  }
});

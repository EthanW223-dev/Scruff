import assert from "node:assert/strict";
import { test } from "node:test";
import { detectModIntent, engineModSupport, planMod } from "../src/hub/mods.ts";
import { parseVisual, visualQuestion } from "../src/hub/vision.ts";

// ---------- capability matrix ----------

test("Unity gets full mod support, gated on the bridge connection", () => {
  const on = engineModSupport("Unity (Mono)", true);
  assert.equal(on.tier, "full");
  assert.match(on.note, /unity__ tools/);
  assert.match(on.note, /connected/);
  const off = engineModSupport("Unity (IL2CPP)", false);
  assert.equal(off.tier, "full");
  assert.match(off.note, /install_unity_bridge/);
});

test("Unreal has its own tier: bridge installable, unverified on real games", () => {
  const s = engineModSupport("Unreal Engine", false);
  assert.equal(s.tier, "unreal");
  assert.match(s.note, /UNVERIFIED/);
  assert.match(s.note, /unreal_bridge_status/);
  const on = engineModSupport("Unreal Engine", false, true);
  assert.equal(on.tier, "unreal");
  assert.match(on.note, /unreal__ tools/);
});

test("other engines are numbers-only", () => {
  for (const e of ["Godot", "GameMaker", "Source", "Unknown", "RPG Maker MV/MZ"]) {
    const s = engineModSupport(e, false);
    assert.equal(s.tier, "numbers");
    assert.match(s.note, /Only number changes work/);
  }
});

// ---------- intent detection ----------

test("detectModIntent classifies structural mods", () => {
  assert.equal(detectModIntent("make the trees purple").kind, "recolor");
  assert.equal(detectModIntent("paint my car red").kind, "recolor");
  assert.equal(detectModIntent("hide that wall").kind, "hide");
  assert.equal(detectModIntent("get rid of the HUD").kind, "hide");
  assert.equal(detectModIntent("spawn 5 enemies near me").kind, "spawn");
  assert.equal(detectModIntent("slow motion").kind, "time_scale");
  assert.equal(detectModIntent("half speed").kind, "time_scale");
  assert.equal(detectModIntent("make it bigger").kind, "resize");
  assert.equal(detectModIntent("turn off gravity").kind, "gravity");
});

test("detectModIntent leaves number changes to the fast path", () => {
  assert.equal(detectModIntent("give me 99 food").kind, "unknown");
  assert.equal(detectModIntent("I have 5 cans, set to 50").kind, "unknown");
});

// ---------- plans ----------

test("recolor plans find then color", () => {
  const plan = planMod(detectModIntent("make the trees purple"));
  assert.ok(plan);
  assert.deepEqual(plan.steps.map((s) => s.tool), ["unity__find", "unity__color"]);
  assert.match(plan.verify, /purple|trees/);
});

test("hide prefers set_active over destroy", () => {
  const plan = planMod(detectModIntent("hide that wall"));
  assert.ok(plan);
  assert.equal(plan.steps[1].tool, "unity__set_active");
  assert.equal(plan.steps[1].input.active, false);
});

test("time_scale goes straight to world", () => {
  const plan = planMod(detectModIntent("slow motion"));
  assert.ok(plan);
  assert.equal(plan.steps[0].tool, "unity__world");
});

test("unknown intent has no plan", () => {
  assert.equal(planMod(detectModIntent("give me 99 food")), null);
});

// ---------- visual verification ----------

test("visualQuestion names the requested change", () => {
  const q = visualQuestion("the trees are purple");
  assert.match(q, /the trees are purple/);
  assert.match(q, /not visible/);
});

test("parseVisual reads yes/no/unknown honestly", () => {
  assert.equal(parseVisual("yes"), "yes");
  assert.equal(parseVisual("Yes, the trees are purple now."), "yes");
  assert.equal(parseVisual("no"), "no");
  assert.equal(parseVisual("No, nothing changed."), "no");
  assert.equal(parseVisual("not visible"), "unknown");
  assert.equal(parseVisual("I can't tell from this shot."), "unknown");
  assert.equal(parseVisual("maybe?"), "unknown");
});

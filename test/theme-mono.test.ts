import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME, ThemeStore } from "../src/hub/themes.ts";

// Telos's default look is black & white; game colors only arrive with a game's own theme.

const isGray = (hex: string): boolean => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  // Near-gray: #f5f5f7 counts, #ef7b9c (pink) does not.
  return Math.max(r, g, b) - Math.min(r, g, b) <= 8;
};

test("the default theme is black & white, no pink", () => {
  assert.equal(DEFAULT_THEME.source, "default");
  for (const key of ["accent", "background", "text"] as const) {
    assert.ok(isGray(DEFAULT_THEME[key]), `${key} (${DEFAULT_THEME[key]}) is grayscale`);
  }
  assert.notEqual(DEFAULT_THEME.accent.toLowerCase(), "#ef7b9c");
});

test("an unreadable accent falls back to monochrome, never pink or gold", () => {
  const gamesStub = { on() {}, session: null };
  const store = new ThemeStore("/nonexistent-dir/themes.json", gamesStub as any);
  const onDark = store.set({ accent: "#101010", background: "#101010" }, "user");
  assert.equal(onDark.accent, "#f5f5f7");
  const onLight = store.set({ accent: "#f0f0f0", background: "#f0f0f0" }, "user");
  assert.equal(onLight.accent, "#1e1e1e");
});

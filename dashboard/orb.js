// AgentOrb — Telos's HUD icon, built on the thinking-orbs canvas engine
// (https://orbs.jakubantalik.com, MIT). The package ships a framework-free
// engine (dist/engine.es.js, vendored under dashboard/vendor/); this file is
// the vanilla-JS equivalent of its React <ThinkingOrb> component: same tuned
// size presets, same DPR-aware rAF loop, same pause-when-hidden behavior,
// plus a crossfade so the orb melts from one agent state into the next
// instead of snapping.
//
// States: working, searching, solving, listening, connecting, weaving,
//          composing, breathing, shaping.
// Ink: grayscale by default (black & white theme); setColor() tints it with
// the active game's accent while preserving the depth-shading ramp.

import { MODE_FRAMES, paintFrame, resolvePreset } from "./vendor/thinking-orbs-engine.js";

export const ORB_STATES = [
  "working",
  "searching",
  "solving",
  "listening",
  "connecting",
  "weaving",
  "composing",
  "breathing",
  "shaping",
];

const LABELS = {
  working: "Working…",
  searching: "Searching…",
  solving: "Solving…",
  listening: "Listening…",
  connecting: "Connecting…",
  weaving: "Weaving…",
  composing: "Composing…",
  breathing: "Thinking…",
  shaping: "Shaping…",
};

/** "#rgb" / "#rrggbb" / "rgb()" → {r,g,b} ink tint, or undefined for grayscale. */
export function parseTint(color) {
  if (!color) return undefined;
  const hex = String(color).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const fn = String(color).trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
  return undefined;
}

const XFADE_MS = 350;

function resolve(state, size) {
  const { mode, speed, opts } = resolvePreset(state, size);
  return { state, frameFn: MODE_FRAMES[mode], opts, effSpeed: speed };
}

export class AgentOrb {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{size?: 64|32|20, speed?: number, dark?: boolean}} opts
   *   dark=true renders light ink (for the dark overlay over a game).
   */
  constructor(canvas, { size = 64, speed = 1, dark = true } = {}) {
    this.canvas = canvas;
    this.size = size;
    this.dark = dark;
    this.speedMul = speed;
    this.tint = undefined;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(2, (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1);
    canvas.width = Math.round(size * this.dpr);
    canvas.height = Math.round(size * this.dpr);
    this.cur = resolve("breathing", size);
    this.prev = null;
    this.xfadeStart = 0;
    this.state = "breathing";
    this.running = false;
    this.raf = 0;
    this.hoverTarget = 0; // 1 while the cursor is over the orb
    this.energy = 0; // lerped toward hoverTarget; brightens + quickens the orb itself
    this.reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    canvas.setAttribute("aria-label", LABELS[this.state]);

    this.onVis = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") this.stop();
      else this.start();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVis);
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) this.start();
        else this.stop();
      });
      this.io.observe(canvas);
    } else {
      this.start();
    }
    // Paint one frame immediately so there's never a blank canvas.
    this.paint(performance.now() / 1000);
  }

  /** Switch animation, crossfading from the current one. Unknown → breathing. */
  setState(state) {
    const next = ORB_STATES.includes(state) ? state : "breathing";
    if (next === this.state) return;
    this.prev = this.cur;
    this.xfadeStart = performance.now();
    this.cur = resolve(next, this.size);
    this.state = next;
    this.canvas.setAttribute("aria-label", LABELS[next]);
    if (this.reduced) this.paint(0.6);
  }

  /** Hovering the HUD button wakes the orb itself: it brightens and quickens
      while the cursor is over it, then settles back. No external glow. */
  setHover(hovering) {
    this.hoverTarget = hovering ? 1 : 0;
    if (this.reduced) {
      this.energy = this.hoverTarget;
      this.paint(performance.now() / 1000);
    }
  }

  /** Tint the ink with a CSS color, or null/undefined for black & white. */
  setColor(cssColor) {
    this.tint = parseTint(cssColor);
  }

  setSpeed(mult) {
    this.speedMul = mult > 0 ? mult : 1;
  }

  paint(tSec) {
    const { ctx, size, dpr } = this;
    if (!ctx) return;
    // Ease the hover energy toward its target: the orb wakes up under the
    // cursor and settles when it leaves. Reduced motion skips the effect.
    if (!this.reduced) this.energy += (this.hoverTarget - this.energy) * 0.14;
    else this.energy = this.hoverTarget;
    const boost = this.energy;
    const speedK = 1 + 0.55 * boost;
    const filter = boost > 0.01 ? `brightness(${(1 + 0.32 * boost).toFixed(3)}) saturate(${(1 + 0.3 * boost).toFixed(3)})` : "none";
    const layer = (resolved, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.filter = filter;
      paintFrame(ctx, resolved.frameFn(size, tSec * resolved.effSpeed * this.speedMul * speedK, resolved.opts), this.dark, this.tint);
      ctx.filter = "none";
      ctx.restore();
    };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (this.prev) {
      const k = Math.min(1, (performance.now() - this.xfadeStart) / XFADE_MS);
      if (k >= 1) {
        this.prev = null;
      } else {
        layer(this.prev, 1 - k);
        layer(this.cur, k);
        return;
      }
    }
    layer(this.cur, 1);
  }

  start() {
    if (this.running || this.reduced) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.paint(performance.now() / 1000);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy() {
    this.stop();
    this.io?.disconnect();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVis);
  }
}

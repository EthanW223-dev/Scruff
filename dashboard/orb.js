// AgentOrb: Telos's HUD icon, a 16×16 pixel sprite that matches the retro chrome. It's
// the spark mark (a faceted gem with four rays) in four shades of one ink, like an old
// handheld's screen, with the windows' hard drop shadow. Each agent state has its own pixel
// animation, stepped at 12 frames a second like the rest of the UI, and a new state
// dissolves in pixel by pixel (ordered dither) instead of fading.
//
// States: working, searching, solving, listening, connecting, weaving,
//          composing, breathing, shaping, building (the mod builder at work), resting
//          (its work over).
// Ink: the page's text color by default (black & white theme); setColor() uses the
// active game's accent instead.

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
  "building",
  "resting",
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
  building: "Building a mod…",
  resting: "Mod builder finished",
};

/** "#rgb" / "#rrggbb" / "rgb()" → {r,g,b} ink tint, or undefined for the default ink. */
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

/** The sprite is N×N cells; the canvas is that many pixels, scaled up crisp by CSS. */
export const GRID = 16;
const N = GRID;
/** The middle falls between the two center cells, so every shape is symmetric. */
const C = (N - 1) / 2;
const FPS = 12;
const DISSOLVE_MS = 320;
/**
 * The four shades: a cell's tone (0..1) picks one. The hard shadow, one cell down and right
 * of solid cells like the windows', uses the faintest.
 */
const SHADES = [
  { min: 0.75, alpha: 1 },
  { min: 0.4, alpha: 0.55 },
  { min: 0.12, alpha: 0.24 },
];
const FULL = 1;
const DIM = 0.5;
const FAINT = 0.2;

// 4×4 ordered-dither thresholds: the order cells switch in when one state dissolves into the next.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

/** A repeatable 0..1 noise from integers (flickering bits). */
function hash(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- drawing into a frame: Float32Array(N*N) of tones, 0 (off) to 1 (solid) ----

function put(f, x, y, v) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = y * N + x;
  if (v > f[i]) f[i] = v;
}

/** |dx| + |dy| from the middle: 1 for the four center cells, 2 around them, … */
const dia = (x, y) => Math.abs(x - C) + Math.abs(y - C);

/** The spark's gem: lit facet top-left, dim facet bottom-right. */
function gem(f, r, lit = FULL, shade = DIM) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (dia(x, y) <= r) put(f, x, y, x - C + (y - C) > 0 ? shade : lit);
    }
  }
}

/** The spark's four rays, two cells wide, from `from` cells out, `len` long. */
function rays(f, from, len, v = 1) {
  const lo = Math.floor(C);
  for (let k = 0; k < len; k++) {
    const near = lo - from - k;
    const far = lo + 1 + from + k;
    for (const w of [lo, lo + 1]) {
      put(f, w, near, v);
      put(f, w, far, v);
      put(f, near, w, v);
      put(f, far, w, v);
    }
  }
}

/** A 2×2 dot centered on (px, py). */
function dot(f, px, py, v) {
  const x0 = Math.round(px - 0.5);
  const y0 = Math.round(py - 0.5);
  put(f, x0, y0, v);
  put(f, x0 + 1, y0, v);
  put(f, x0, y0 + 1, v);
  put(f, x0 + 1, y0 + 1, v);
}

/** The throbber's eight spokes, clockwise from the top: two cells wide straight, a staircase diagonally. */
const SPOKES = (() => {
  const n = [
    [7, 1], [8, 1], [7, 2], [8, 2], [7, 3], [8, 3],
  ];
  const ne = [
    [10, 5], [11, 4], [12, 3], [13, 2], [11, 5], [12, 4],
  ];
  // Rotate a quarter turn about the middle: (x, y) → (15 - y, x).
  const turn = (cells) => cells.map(([x, y]) => [N - 1 - y, x]);
  const out = [n, ne];
  for (let k = 2; k < 8; k++) out.push(turn(out[k - 2]));
  return out;
})();

// ---- the animations: (frame number at 12 fps, seconds) → tones ----

const SPRITES = {
  // Ready: the spark at rest. Its rays breathe in and out, and now and then a glint
  // runs across the gem.
  breathing(f, n) {
    const phase = n % 40; // 3.3 s
    const len = phase < 14 ? 2 : phase < 20 ? 3 : phase < 34 ? 2 : 1;
    gem(f, 3);
    rays(f, 4, len);
    const glint = n % 52; // a diagonal sweep, once every 4.3 s
    if (glint < 9) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (dia(x, y) <= 3 && x + y === 4 + glint * 2) f[y * N + x] = f[y * N + x] >= FULL ? DIM : FULL;
        }
      }
    }
  },
  // Booting / reconnecting: the rays light up in turn, like a signal going round, and the gem blinks.
  connecting(f, n) {
    gem(f, 3, (n >> 2) % 2 ? FULL : DIM, (n >> 2) % 2 ? DIM : FAINT);
    const lo = Math.floor(C);
    const head = (n >> 1) % 4;
    for (let r = 0; r < 4; r++) {
      const age = (head - r + 4) % 4;
      const v = [FULL, DIM, FAINT, FAINT][age];
      for (let k = 0; k < 2; k++) {
        const d = 4 + k;
        const cells = [
          [[lo, lo - d], [lo + 1, lo - d]], // up
          [[lo + 1 + d, lo], [lo + 1 + d, lo + 1]], // right
          [[lo, lo + 1 + d], [lo + 1, lo + 1 + d]], // down
          [[lo - d, lo], [lo - d, lo + 1]], // left
        ][r];
        for (const [x, y] of cells) put(f, x, y, v);
      }
    }
  },
  // The mic is open: a level meter, tallest in the middle.
  listening(f, n, t) {
    const scale = [0.5, 0.85, 1, 0.85, 0.5];
    for (let b = 0; b < 5; b++) {
      const level = 0.5 + 0.28 * Math.sin(t * 9.1 + b * 1.9) + 0.22 * Math.sin(t * 4.3 + b * 3.7);
      const half = 1 + Math.round(Math.max(0, Math.min(1, level)) * 5 * scale[b]);
      const x0 = 1 + b * 3;
      for (let y = 8 - half; y < 8 + half; y++) {
        const v = y === 8 - half || y === 7 + half ? DIM : FULL; // softer caps
        put(f, x0, y, v);
        put(f, x0 + 1, y, v);
      }
    }
  },
  // Thinking: three dots orbit the gem.
  composing(f, n) {
    gem(f, 2);
    const steps = 12;
    for (let s = 0; s < 3; s++) {
      for (let k = 1; k >= 0; k--) {
        const a = ((n - k + s * 4) / steps) * Math.PI * 2;
        dot(f, C + 5.5 * Math.sin(a), C - 5.5 * Math.cos(a), k ? FAINT : FULL);
      }
    }
  },
  // Searching memory: a magnifier drifts over a grid of cells, lighting the ones under it.
  searching(f, n) {
    // Whole-cell moves, so the lens keeps its exact shape as it goes.
    const a = (n / 24) * Math.PI * 2;
    const lx = Math.round(C - 1.5 + 1.8 * Math.cos(a)) + 0.5;
    const ly = Math.round(C - 1.5 + 1.8 * Math.sin(a)) + 0.5;
    for (let y = 1; y < N; y += 3) {
      for (let x = 1; x < N; x += 3) {
        put(f, x, y, Math.hypot(x - lx, y - ly) < 3.2 ? FULL : FAINT);
      }
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.hypot(x - lx, y - ly);
        if (d >= 3.4 && d < 4.6) put(f, x, y, FULL); // the lens
        // The handle, down and right.
        const along = (x - lx + (y - ly)) / Math.SQRT2;
        const across = Math.abs(x - lx - (y - ly)) / Math.SQRT2;
        if (along > 4.4 && along < 7.6 && across < 0.8) put(f, x, y, FULL);
      }
    }
  },
  // Working something out: the gem turns a click at a time while bits flicker in the corners.
  solving(f, n) {
    const step = n % 12; // hold, then a quarter turn in six steps
    const a = step < 6 ? 0 : ((step - 5) / 6) * (Math.PI / 2);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x - C) * cos + (y - C) * sin;
        const v = -(x - C) * sin + (y - C) * cos;
        if (Math.abs(u) + Math.abs(v) <= 4.2) put(f, x, y, u + v > 0 ? DIM : FULL);
      }
    }
    const corners = [
      [1, 1],
      [N - 3, 1],
      [1, N - 3],
      [N - 3, N - 3],
    ];
    corners.forEach(([cx, cy], i) => {
      for (let k = 0; k < 4; k++) {
        const h = hash(n >> 1, i * 4 + k);
        if (h > 0.45) put(f, cx + (k & 1), cy + (k >> 1), h > 0.75 ? FULL : DIM);
      }
    });
  },
  // Running a tool: an eight-spoke throbber round a small gem.
  working(f, n) {
    gem(f, 2);
    const head = n % 8;
    SPOKES.forEach((cells, s) => {
      const age = (head - s + 8) % 8;
      const v = [FULL, DIM, DIM, FAINT, FAINT, FAINT, FAINT, FAINT][age];
      for (const [x, y] of cells) put(f, x, y, v);
    });
  },
  // The reply is being written: lines of text type themselves out.
  weaving(f, n) {
    const lines = ["#### ### ###", "### ####", "## ##### ###", "#### ##"];
    const total = lines.reduce((s, l) => s + l.length, 0);
    const pos = n % (total + 14); // type, then hold the full page a moment
    let before = 0;
    lines.forEach((text, i) => {
      const y = 3 + i * 3;
      const shown = Math.max(0, Math.min(text.length, pos - before));
      for (let k = 0; k < shown; k++) if (text[k] === "#") put(f, 2 + k, y, FULL);
      // The cursor: a blinking block after the last cell typed.
      if (pos >= before && pos < before + text.length && (n >> 2) % 2 === 0) {
        put(f, 2 + shown, y, FULL);
        put(f, 2 + shown, y + 1, DIM);
      }
      before += text.length;
    });
  },
  // A change just landed in the game: the spark flares, then sparks fly out.
  shaping(f, n) {
    const p = (n % 15) / 15; // 1.25 s
    if (p < 0.2) {
      gem(f, 3, FULL, FULL);
      rays(f, 4, 3);
      return;
    }
    gem(f, 2);
    const d = 4 + (p - 0.2) * 5;
    const v = p < 0.55 ? FULL : p < 0.8 ? DIM : FAINT;
    for (let s = 0; s < 8; s++) {
      const a = (s / 8) * Math.PI * 2;
      const r = s % 2 ? d * 0.85 : d;
      dot(f, C + r * Math.sin(a), C - r * Math.cos(a), v);
    }
  },
  // The mod builder at work: a hammer swings down onto an anvil, and sparks fly.
  building(f, n) {
    anvil(f);
    // Raised, down onto the anvil, a bounce, back up.
    const step = n % 12;
    hammer(f, [58, 58, 58, 66, 40, 16, 0, 0, 6, 18, 36, 50][step]);
    // Sparks off the strike, flying out and fading.
    const sparks = [
      [[5, 8], [4, 6], [6, 5], [3, 9]],
      [[3, 7], [3, 4], [6, 3], [1, 9]],
      [[2, 6], [2, 3], [6, 1], [0, 8]],
    ];
    const age = step - 6;
    if (age >= 0 && age < 3) for (const [x, y] of sparks[age]) put(f, x, y, [FULL, DIM, FAINT][age]);
  },
  // The mod builder's work is over: the hammer lies still on the anvil.
  resting(f) {
    anvil(f);
    hammer(f, 0);
  },
};

/** The mod builder's anvil: a lit top with its horn to the left, a dim waist, a solid base. */
function anvil(f) {
  for (let x = 2; x <= 12; x++) put(f, x, 10, x === 2 ? DIM : FULL);
  for (let x = 4; x <= 12; x++) put(f, x, 11, x === 4 ? FAINT : DIM);
  for (let y = 12; y <= 13; y++) for (let x = 6; x <= 10; x++) put(f, x, y, DIM);
  for (let x = 4; x <= 12; x++) put(f, x, 14, FULL);
}

/** Its hammer, held at the right and raised `deg` degrees (0: its head on the anvil). */
function hammer(f, deg) {
  const angle = deg * (Math.PI / 180);
  const px = 14;
  const py = 7.5;
  const dx = -Math.cos(angle);
  const dy = -Math.sin(angle);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const along = (x - px) * dx + (y - py) * dy;
      const across = Math.abs((x - px) * -dy + (y - py) * dx);
      if (along >= 4.5 && along <= 7.5 && across <= 2) put(f, x, y, FULL); // the head
      else if (along >= 0.5 && along < 4.5 && across <= 0.5) put(f, x, y, DIM); // the handle
    }
  }
}

export class AgentOrb {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{size?: number, speed?: number, dark?: boolean}} opts
   *   size is the CSS size it's shown at (the sprite is always GRID cells; CSS scales it).
   *   dark=true: light ink for a dark background (the overlay); false: dark ink.
   */
  constructor(canvas, { size = 64, speed = 1, dark = true } = {}) {
    this.canvas = canvas;
    this.size = size;
    this.dark = dark;
    this.speedMul = speed;
    this.tint = undefined;
    this.ctx = canvas.getContext("2d");
    canvas.width = N;
    canvas.height = N;
    this.state = "breathing";
    this.prev = null; // the state dissolving away
    this.switchedAt = 0;
    this.running = false;
    this.raf = 0;
    this.lastFrame = -1;
    this.hoverTarget = 0; // 1 while the cursor is over the orb
    this.energy = 0; // eased toward hoverTarget: hovering wakes the sprite (fuller, quicker)
    this.inkCache = null;
    this.inkReadAt = -Infinity;
    this.cur = new Float32Array(N * N);
    this.old = new Float32Array(N * N);
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
    // Paint one frame now so the canvas is never blank.
    this.paint(performance.now() / 1000);
  }

  /** Switch animation; the new one dissolves in over the old. Unknown → breathing. */
  setState(state) {
    const next = ORB_STATES.includes(state) ? state : "breathing";
    if (next === this.state) return;
    this.prev = this.state;
    this.switchedAt = performance.now();
    this.state = next;
    this.canvas.setAttribute("aria-label", LABELS[next]);
    if (this.reduced) this.paint(0.6);
  }

  /** Hovering the HUD button wakes the sprite: dithered parts fill in and it runs quicker. */
  setHover(hovering) {
    this.hoverTarget = hovering ? 1 : 0;
    if (this.reduced) {
      this.energy = this.hoverTarget;
      this.paint(performance.now() / 1000);
    }
  }

  /** Ink in a CSS color, or null/undefined for the page's own text color. */
  setColor(cssColor) {
    this.tint = parseTint(cssColor);
    this.inkReadAt = -Infinity;
  }

  setSpeed(mult) {
    this.speedMul = mult > 0 ? mult : 1;
  }

  /** The ink: the tint, else the canvas's CSS color (re-read now and then, for theme changes). */
  ink() {
    if (this.tint) return this.tint;
    const now = performance.now();
    if (now - this.inkReadAt > 1000) {
      this.inkReadAt = now;
      let css;
      try {
        css = typeof getComputedStyle !== "undefined" ? getComputedStyle(this.canvas).color : undefined;
      } catch {
        css = undefined;
      }
      this.inkCache = parseTint(css) ?? (this.dark ? { r: 245, g: 245, b: 247 } : { r: 20, g: 20, b: 23 });
    }
    return this.inkCache;
  }

  /** The sprite's tones for a state at time t (seconds of animation). */
  frame(state, t, into) {
    into.fill(0);
    const sprite = SPRITES[state] ?? SPRITES.breathing;
    sprite(into, Math.floor(t * FPS), t);
    return into;
  }

  paint(tSec) {
    const { ctx } = this;
    if (!ctx) return;
    if (!this.reduced) this.energy += (this.hoverTarget - this.energy) * 0.3;
    else this.energy = this.hoverTarget;
    const boost = this.energy;
    // Animation time runs quicker under the cursor; stepped to whole frames.
    const t = tSec * this.speedMul * (1 + 0.6 * boost);
    const cur = this.frame(this.state, t, this.cur);
    let k = 1;
    if (this.prev) {
      k = this.reduced ? 1 : Math.min(1, (performance.now() - this.switchedAt) / DISSOLVE_MS);
      if (k >= 1) this.prev = null;
      else this.frame(this.prev, t, this.old);
    }
    // Each cell's shade (0 off … 3 full), the old state dissolving into the new through the dither.
    const shade = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const tone = k < 1 && bayer(x, y) >= k ? this.old[i] : cur[i];
        const lifted = tone > 0 ? Math.min(1, tone + 0.3 * boost) : 0;
        const s = SHADES.findIndex((sh) => lifted >= sh.min);
        shade[i] = s < 0 ? 0 : 3 - s;
      }
    }
    const { r, g, b } = this.ink();
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, N, N);
    SHADES.forEach(({ alpha }, s) => {
      const level = 3 - s;
      ctx.fillStyle = alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
      this.fillRuns((i, x, y) => {
        if (shade[i] === level) return true;
        // The hard shadow: empty cells just down-right of a solid one.
        return level === 1 && !shade[i] && x > 0 && y > 0 && shade[i - N - 1] === 3;
      });
    });
  }

  /** Fills the cells `lit` picks, one rectangle per horizontal run. */
  fillRuns(lit) {
    for (let y = 0; y < N; y++) {
      let start = -1;
      for (let x = 0; x <= N; x++) {
        const yes = x < N && lit(y * N + x, x, y);
        if (yes && start < 0) start = x;
        if (!yes && start >= 0) {
          this.ctx.fillRect(start, y, x - start, 1);
          start = -1;
        }
      }
    }
  }

  start() {
    if (this.running || this.reduced) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      // A new frame only when the sprite steps (or while dissolving / easing the hover).
      const step = Math.floor((now / 1000) * FPS * this.speedMul * (1 + 0.6 * this.energy));
      if (step !== this.lastFrame || this.prev || Math.abs(this.hoverTarget - this.energy) > 0.01) {
        this.lastFrame = step;
        this.paint(now / 1000);
      }
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

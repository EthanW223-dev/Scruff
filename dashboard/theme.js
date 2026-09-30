// Per-game look: applies the hub's theme as CSS variables, and picks a starting palette from a
// screenshot of the game.

const FONTS = {
  clean: { display: null, body: null },
  fantasy: { display: "Cinzel", body: "Alegreya Sans" },
  scifi: { display: "Orbitron", body: "Exo 2" },
  pixel: { display: "Press Start 2P", body: "VT323" },
  horror: { display: "Creepster", body: "Special Elite" },
  western: { display: "Rye", body: "Bitter" },
  cartoon: { display: "Bangers", body: "Nunito" },
  military: { display: "Black Ops One", body: "Share Tech Mono" },
};
const SYSTEM = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
// Shipped in dashboard/fonts, so they work offline and never go to Google.
const BUNDLED = new Set(["Inter Tight", "VT323"]);
const CLEAN = '"Inter Tight"';

let applied = "";

export function applyTheme(theme) {
  const key = JSON.stringify(theme);
  if (!theme || key === applied) return;
  applied = key;
  const root = document.documentElement.style;
  const { accent, background: bg, text } = theme;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-2", mix(accent, "#ffffff", 0.35));
  root.setProperty("--accent-ink", readableOn(accent));
  root.setProperty("--bg", bg);
  root.setProperty("--page", mix(bg, text, 0.1));
  root.setProperty("--surface", mix(bg, text, 0.035));
  root.setProperty("--surface-2", mix(bg, text, 0.07));
  root.setProperty("--soft", mix(bg, text, 0.2));
  root.setProperty("--text", text);
  root.setProperty("--line", text);
  root.setProperty("--muted", mix(text, bg, 0.42));

  const fonts = FONTS[theme.font] ?? FONTS.clean;
  loadFonts(fonts);
  const stack = (family) => (family ? `"${family}", ${CLEAN}, ${SYSTEM}` : `${CLEAN}, ${SYSTEM}`);
  root.setProperty("--font", stack(fonts.body));
  root.setProperty("--font-display", stack(fonts.display));
  document.body.dataset.corner = theme.corner ?? "top-right";
  document.body.dataset.font = theme.font ?? "clean";
  // The font mood doubles as the game's genre key for motion: animations follow
  // the genre while colors keep coming from the theme. Fonts are never touched here.
  document.body.dataset.genre = theme.font ?? "clean";
}

function loadFonts({ display, body }) {
  const families = [display, body].filter((f) => f && !BUNDLED.has(f));
  if (!families.length) return;
  const id = `font-${families.join("-").replace(/\W+/g, "")}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  // Offline, this just fails and the system font is used.
  link.href = `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f.replace(/ /g, "+")}:wght@400;700`).join("&")}&display=swap`;
  document.head.append(link);
}

// ---------- color helpers ----------

function toRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function mix(a, b, t) {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function readableOn(hex) {
  return luminance(hex) > 0.3 ? "#1e1e1e" : "#ffffff";
}
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/**
 * A starting palette from a game screenshot (an <img> or <canvas>): the accent is the game's
 * most prominent vivid hue, the background a deep shade of its darker tones, so the overlay
 * reads as part of the game.
 */
export function paletteFrom(source) {
  const w = 64;
  const h = Math.max(1, Math.round((w * (source.naturalHeight || source.height)) / (source.naturalWidth || source.width)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // Weight each 15° hue band by how vivid its pixels are; remember the average dark tone.
  const weights = new Array(24).fill(0);
  let dark = [0, 0, 0];
  let darkCount = 0;
  for (let i = 0; i < px.length; i += 4) {
    const { hue, s, l } = hslOf(px[i], px[i + 1], px[i + 2]);
    if (l < 0.35) {
      dark = dark.map((v, k) => v + px[i + k]);
      darkCount++;
    }
    if (s < 0.25 || l < 0.15 || l > 0.9) continue;
    weights[Math.floor(hue / 15)] += s * (1 - Math.abs(l - 0.55));
  }
  const top = weights.indexOf(Math.max(...weights));
  const accentHue = weights[top] > 0 ? averageHue(px, top) : 265;

  const base = darkCount ? dark.map((v) => v / darkCount) : [11, 13, 20];
  // Deepen the game's dark tones so text stays readable over any scene.
  const background = toHex(base.map((v) => v * 0.45 + 6));
  return {
    accent: hsl(accentHue, 0.75, 0.6),
    background,
    text: mix("#f2f3f7", hsl(accentHue, 0.6, 0.85), 0.15),
  };
}

function hslOf(r8, g8, b8) {
  const [r, g, b] = [r8 / 255, g8 / 255, b8 / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { hue: 0, s: 0, l };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, s, l };
}

/** Circular mean of the hues in one band, so reds near 0°/360° average correctly. */
function averageHue(px, bucket) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < px.length; i += 4) {
    const { hue, s, l } = hslOf(px[i], px[i + 1], px[i + 2]);
    if (s < 0.25 || l < 0.15 || l > 0.9 || Math.floor(hue / 15) !== bucket) continue;
    x += Math.cos((hue * Math.PI) / 180);
    y += Math.sin((hue * Math.PI) / 180);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/* Scruff web preview - core: utilities, audio, mesh building, materials, particles, collision world. */
'use strict';
const S = (window.S = {});
const V3 = THREE.Vector3;

// ------------------------------------------------------------------ utilities
S.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
S.clamp01 = (v) => S.clamp(v, 0, 1);
S.lerp = (a, b, t) => a + (b - a) * t;
S.invLerp = (a, b, v) => S.clamp01((v - a) / (b - a));
S.damp = (k, dt) => 1 - Math.exp(-k * dt);
S.smooth = (t) => { t = S.clamp01(t); return t * t * (3 - 2 * t); };
S.rand = (a, b) => a + Math.random() * (b - a);
S.randi = (a, b) => Math.floor(S.rand(a, b));
S.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
S.rng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
};
S.money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
S.fmtTime = (m) => {
  m = ((Math.floor(m) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  let h12 = h % 12; if (!h12) h12 = 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
S.fmtDur = (m) => {
  m = Math.max(0, Math.ceil(m));
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};
S.DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
S.dayName = (d) => S.DAYS[(Math.max(1, d) - 1) % 7];
S.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
S.css = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
S.mix = (a, b, t) => [S.lerp(a[0], b[0], t), S.lerp(a[1], b[1], t), S.lerp(a[2], b[2], t)];
S.dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

// ------------------------------------------------------------------ palette (sRGB 0..1, same values as the Unity game)
S.C = {
  grass: [0.36, 0.52, 0.28], grassDark: [0.29, 0.43, 0.23], asphalt: [0.22, 0.22, 0.24], line: [0.92, 0.82, 0.35],
  sidewalk: [0.62, 0.61, 0.58], curb: [0.52, 0.51, 0.49], brick: [0.62, 0.33, 0.26], brickDark: [0.48, 0.25, 0.21],
  concrete: [0.58, 0.57, 0.55], concreteDark: [0.40, 0.40, 0.40], plaster: [0.82, 0.78, 0.68], siding: [0.55, 0.66, 0.72],
  sidingYellow: [0.86, 0.78, 0.52], sidingGreen: [0.55, 0.68, 0.52], roof: [0.30, 0.27, 0.28], window: [0.8, 0.8, 0.66],
  door: [0.36, 0.24, 0.17], wood: [0.62, 0.45, 0.30], woodDark: [0.42, 0.30, 0.20], woodLight: [0.78, 0.62, 0.44],
  metal: [0.55, 0.58, 0.62], metalDark: [0.25, 0.27, 0.30], floor: [0.55, 0.44, 0.33], wall: [0.78, 0.74, 0.64],
  trunk: [0.40, 0.29, 0.20], leaves: [0.30, 0.50, 0.25], leavesLight: [0.40, 0.60, 0.30], dumpster: [0.20, 0.42, 0.30],
  lamp: [1.0, 0.88, 0.60], white: [1, 1, 1], black: [0.08, 0.08, 0.1], policeBlue: [0.14, 0.20, 0.38], policeShirt: [0.30, 0.40, 0.62],
  badge: [0.95, 0.80, 0.30], money: [0.45, 0.85, 0.45], terracotta: [0.72, 0.40, 0.26], soilDry: [0.42, 0.30, 0.20], soilWet: [0.22, 0.15, 0.10],
};
S.SKIN = [[0.96, 0.80, 0.69], [0.91, 0.72, 0.57], [0.80, 0.60, 0.45], [0.63, 0.45, 0.32], [0.47, 0.33, 0.24], [0.36, 0.25, 0.18]];
S.HAIR = [[0.10, 0.08, 0.07], [0.28, 0.18, 0.10], [0.50, 0.33, 0.18], [0.80, 0.65, 0.38], [0.60, 0.22, 0.12], [0.70, 0.70, 0.72]];
S.CLOTHES = [[0.80, 0.25, 0.22], [0.22, 0.40, 0.72], [0.25, 0.55, 0.35], [0.92, 0.75, 0.25], [0.55, 0.35, 0.65], [0.90, 0.90, 0.88], [0.18, 0.18, 0.20], [0.95, 0.55, 0.25], [0.40, 0.62, 0.70], [0.70, 0.40, 0.45]];
S.PANTS = [[0.22, 0.28, 0.42], [0.15, 0.15, 0.17], [0.45, 0.40, 0.32], [0.35, 0.36, 0.38], [0.30, 0.36, 0.26]];

// ------------------------------------------------------------------ settings (per-viewer, localStorage)
S.settings = { sensitivity: 1, volume: 0.8, timeScale: 1 };
try {
  const raw = localStorage.getItem('scruff-web-settings');
  if (raw) Object.assign(S.settings, JSON.parse(raw));
} catch (e) { /* storage unavailable */ }
S.saveSettings = () => { try { localStorage.setItem('scruff-web-settings', JSON.stringify(S.settings)); } catch (e) { /* ignore */ } };

// ------------------------------------------------------------------ audio (everything synthesised, like the Unity build)
S.audio = (() => {
  let ctx = null, master = null;
  const buffers = {};
  const RATE = 22050;
  const noiseLP = (alpha, seed) => { const r = S.rng(seed); let st = 0; return () => { st += alpha * ((r() * 2 - 1) - st); return st * (1.5 / Math.sqrt(alpha)); }; };
  const noiseHP = (seed) => { const r = S.rng(seed); let prev = 0; return () => { const w = r() * 2 - 1, v = w - prev; prev = w; return v * 0.6; }; };
  const TAU = Math.PI * 2;
  const defs = {
    tap: [0.09, noiseLP(0.25, 1), (t, n) => n * 0.7 * Math.exp(-t * 60) + Math.sin(TAU * 140 * t) * 0.6 * Math.exp(-t * 40)],
    click: [0.05, null, (t) => Math.sin(TAU * 1800 * t) * 0.5 * Math.exp(-t * 170) + Math.sin(TAU * 600 * t) * 0.35 * Math.exp(-t * 60)],
    pop: [0.09, null, (t) => Math.sin(TAU * (380 * t + 0.5 * (380 / 0.09) * t * t)) * 0.55 * Math.exp(-t * 35)],
    drop: [0.11, null, (t) => Math.sin(TAU * (560 * t - 0.5 * (300 / 0.11) * t * t)) * 0.45 * Math.exp(-t * 30)],
    error: [0.32, null, (t) => ((t < 0.12 || (t > 0.17 && t < 0.3)) ? Math.sign(Math.sin(TAU * 165 * t)) * 0.18 : 0)],
    notify: [0.36, null, (t) => { const f = t < 0.12 ? 880 : 1320, l = t < 0.12 ? t : t - 0.12; return Math.sin(TAU * f * t) * 0.35 * Math.exp(-l * 9) * Math.min(1, l * 200); }],
    success: [0.5, null, (t) => arp([523.25, 659.25, 783.99, 1046.5], 0.09, t)],
    rankup: [1.1, null, (t) => arp([392, 523.25, 659.25, 783.99, 1046.5, 1318.5], 0.08, t, true)],
    cash: [0.6, noiseLP(0.7, 5), (t, n) => {
      let v = n * 0.25 * Math.exp(-t * 50) + (Math.sin(TAU * 1318.5 * t) + 0.35 * Math.sin(TAU * 2637 * t)) * 0.28 * Math.exp(-t * 7);
      if (t > 0.09) { const u = t - 0.09; v += (Math.sin(TAU * 1760 * u) + 0.3 * Math.sin(TAU * 3520 * u)) * 0.28 * Math.exp(-u * 6); }
      return v;
    }],
    coin: [0.35, null, (t) => Math.sin(TAU * 1568 * t) * 0.3 * Math.exp(-t * 12) + (t > 0.06 ? Math.sin(TAU * 2093 * (t - 0.06)) * 0.3 * Math.exp(-(t - 0.06) * 10) : 0)],
    thud: [0.16, noiseLP(0.2, 6), (t, n) => Math.sin(TAU * 90 * t) * 0.6 * Math.exp(-t * 25) + n * 0.35 * Math.exp(-t * 60)],
    rustle: [0.28, noiseHP(7), (t, n) => n * 0.3 * (0.5 + 0.5 * Math.sin(TAU * 22 * t)) * Math.exp(-t * 9) * Math.min(1, t * 60)],
    snap: [0.07, noiseHP(9), (t, n) => n * 0.5 * Math.exp(-t * 90) + Math.sin(TAU * 1200 * t) * 0.2 * Math.exp(-t * 120)],
    door: [0.7, noiseLP(0.3, 8), (t, n) => { const f = 170 + 40 * Math.sin(TAU * 3 * t) + 25 * Math.sin(TAU * 11 * t); return ((2 * ((f * t) % 1) - 1) * 0.15 + n * 0.1) * Math.sin(Math.PI * S.clamp01(t / 0.7)); }],
    blip: [0.075, null, (t) => { const env = Math.min(1, t * 250) * Math.exp(-t * 30); const tri = 1 - 4 * Math.abs(((330 * t) % 1) - 0.5); return (tri * 0.3 + Math.sign(Math.sin(TAU * 330 * t)) * 0.08) * env; }],
    whistle: [0.95, null, (t) => { const f = Math.floor(t / 0.075) % 2 === 0 ? 2300 : 1900; return Math.sin(TAU * f * t) * 0.25 * Math.min(1, t * 30) * S.clamp01((0.95 - t) * 12); }],
    pour_water: [1, null, bubbly(10, 0.07, 0.35, 900, 1800, 14)],
    pour_soil: [1, null, crackle(11)],
    bubble: [1.2, null, bubbly(12, 0.02, 0.1, 260, 620, 6)],
    whir: [0.5, noiseLP(0.3, 13), (t, n) => (2 * ((110 * t) % 1) - 1) * 0.12 + (2 * ((220 * t) % 1) - 1) * 0.06 + n * 0.12],
  };
  function arp(notes, step, t, tail) {
    let v = 0;
    for (let i = 0; i < notes.length; i++) {
      const s = i * step; if (t < s) break;
      const u = t - s, decay = tail && i === notes.length - 1 ? 3 : 10;
      v += Math.sin(TAU * notes[i] * u) * 0.35 * Math.exp(-u * decay) * Math.min(1, u * 300);
    }
    return v * 0.6;
  }
  function bubbly(seed, alpha, gain, lo, hi, rate) {
    const r = S.rng(seed), nz = noiseLP(alpha, seed + 100), count = Math.ceil(rate * 1.5), st = [], fr = [];
    for (let i = 0; i < count; i++) { st.push(r() * 1.2); fr.push(S.lerp(lo, hi, r())); }
    return (t) => {
      let v = nz() * gain * 0.4;
      for (let i = 0; i < count; i++) { const u = t - st[i]; if (u < 0 || u > 0.05) continue; v += Math.sin(TAU * fr[i] * (1 + u * 12) * u) * 0.18 * Math.exp(-u * 70); }
      return v;
    };
  }
  function crackle(seed) {
    const r = S.rng(seed), lp = noiseLP(0.3, seed + 1); let burst = 0;
    return () => { if (r() < 0.004) burst = 1; burst *= 0.995; return lp() * (0.08 + 0.35 * burst); };
  }
  function build() {
    for (const [name, [secs, noise, fn]] of Object.entries(defs)) {
      const n = Math.max(1, Math.round(secs * RATE));
      const buf = ctx.createBuffer(1, n, RATE), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = S.clamp(fn(i / RATE, noise ? noise() : 0), -1, 1);
      const fade = Math.min(Math.floor(n / 4), 64);
      for (let i = 0; i < fade; i++) { const k = i / fade; d[i] *= k; d[n - 1 - i] *= k; }
      buffers[name] = buf;
    }
  }
  const api = {
    get ready() { return !!ctx; },
    unlock() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = S.settings.volume; master.connect(ctx.destination);
        build();
      } catch (e) { ctx = null; }
    },
    setVolume(v) { if (master) master.gain.value = v; },
    /** pos: optional world position for distance + stereo panning */
    play(name, vol = 1, pitch = 1, pos = null) {
      if (!ctx || !buffers[name]) return;
      let gainV = vol, pan = 0;
      if (pos && S.camera) {
        const d = S.camera.position.distanceTo(pos);
        gainV *= S.clamp01(1.4 / Math.max(1, d * 0.8));
        if (gainV < 0.01) return;
        const right = new V3(1, 0, 0).applyQuaternion(S.camera.quaternion);
        pan = S.clamp(right.dot(pos.clone().sub(S.camera.position).normalize()), -0.9, 0.9);
      }
      const src = ctx.createBufferSource(); src.buffer = buffers[name]; src.playbackRate.value = pitch;
      const g = ctx.createGain(); g.gain.value = gainV;
      let node = src.connect(g);
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node.connect(p); p.connect(master); }
      else node.connect(master);
      src.start();
    },
    /** Returns a loop handle with setLevel(0..1). */
    loop(name) {
      const h = { src: null, g: null, level: 0, setLevel(v) { this.level = v; if (this.g) this.g.gain.value = v; } };
      h.start = () => {
        if (!ctx || h.src || !buffers[name]) return;
        h.src = ctx.createBufferSource(); h.src.buffer = buffers[name]; h.src.loop = true;
        h.g = ctx.createGain(); h.g.gain.value = h.level; h.src.connect(h.g); h.g.connect(master); h.src.start();
      };
      return h;
    },
  };
  return api;
})();

// ------------------------------------------------------------------ materials (one flat-shaded vertex-colour shader, like ScruffFlat.shader)
THREE.ColorManagement.enabled = false;
S.U = {
  uLightDir: { value: new V3(0.4, 0.8, -0.3).normalize() }, uLightColor: { value: new V3(0.75, 0.72, 0.65) },
  uAmbSky: { value: new V3(0.52, 0.56, 0.62) }, uAmbGround: { value: new V3(0.36, 0.33, 0.3) },
  uFogColor: { value: new V3(0.62, 0.76, 0.9) }, uFogParams: { value: new V3(40, 160, 0.85) }, uNightGlow: { value: 0 },
  uIndoorMin0: { value: new V3(1e5, 1e5, 1e5) }, uIndoorMax0: { value: new V3(-1e5, -1e5, -1e5) },
  uIndoorMin1: { value: new V3(1e5, 1e5, 1e5) }, uIndoorMax1: { value: new V3(-1e5, -1e5, -1e5) },
  uIndoorLight: { value: new V3(0.4, 0.4, 0.4) },
};
const FLAT_VS = `
attribute vec4 vcolor;
uniform vec3 uLightDir, uLightColor, uAmbSky, uAmbGround, uIndoorMin0, uIndoorMax0, uIndoorMin1, uIndoorMax1, uIndoorLight;
uniform float uNightGlow; uniform vec4 uHighlight;
varying vec3 vCol; varying float vDepth;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  float ndl = max(dot(n, normalize(uLightDir)), 0.0);
  float hemi = n.y * 0.5 + 0.5;
  vec3 lighting = mix(uAmbGround, uAmbSky, hemi) + uLightColor * ndl;
  vec3 i0 = step(uIndoorMin0, wp.xyz) * step(wp.xyz, uIndoorMax0);
  vec3 i1 = step(uIndoorMin1, wp.xyz) * step(wp.xyz, uIndoorMax1);
  float indoor = clamp(i0.x * i0.y * i0.z + i1.x * i1.y * i1.z, 0.0, 1.0);
  vec3 room = uIndoorLight * (0.7 + 0.3 * hemi) + uIndoorLight * 0.25 * max(dot(n, vec3(0.3, 0.8, 0.5)), 0.0);
  lighting = mix(lighting, max(lighting, room), indoor);
  float e = 1.0 - vcolor.a;
  float always = clamp((e - 0.5) * 2.0, 0.0, 1.0);
  float night = (e <= 0.5 ? e * 2.0 : 0.0) * uNightGlow;
  vec3 col = vcolor.rgb * mix(lighting, vec3(1.0), max(always, night));
  float rim = 1.0 - clamp(dot(n, normalize(cameraPosition - wp.xyz)), 0.0, 1.0);
  vCol = mix(col, uHighlight.rgb, uHighlight.a * (0.4 + 0.6 * rim));
  vec4 mv = viewMatrix * wp; vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FLAT_FS = `
uniform vec3 uFogColor, uFogParams; varying vec3 vCol; varying float vDepth;
void main() {
  float f = clamp((vDepth - uFogParams.x) / max(0.01, uFogParams.y - uFogParams.x), 0.0, 1.0) * uFogParams.z;
  gl_FragColor = vec4(mix(vCol, uFogColor, f), 1.0);
}`;
S.makeFlat = (highlight) => new THREE.ShaderMaterial({
  uniforms: Object.assign({}, S.U, { uHighlight: { value: highlight || new THREE.Vector4(0, 0, 0, 0) } }),
  vertexShader: FLAT_VS, fragmentShader: FLAT_FS,
});
S.mat = {
  flat: S.makeFlat(),
  highlight: S.makeFlat(new THREE.Vector4(1, 0.95, 0.75, 0.32)),
  glass: new THREE.ShaderMaterial({
    uniforms: {}, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'attribute vec4 vcolor; varying vec4 vC; void main(){ vC = vcolor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec4 vC; void main(){ gl_FragColor = vC; }',
  }),
};

// ------------------------------------------------------------------ MeshBuilder (port of the Unity MeshBuilder: flat normals, vertex colour, emission in alpha)
class MeshBuilder {
  constructor() { this.clear(); }
  clear() {
    this.pos = []; this.nor = []; this.col = [];
    this.m = new THREE.Matrix4(); this.stack = [];
    this.emission = 0; this.night = 0; this.flip = false; this.raw = false;
    return this;
  }
  push(m) { this.stack.push(this.m.clone()); this.m.multiply(m); }
  pushTRS(p, yawDeg = 0, s = 1) {
    this.push(new THREE.Matrix4().compose(new V3(p[0], p[1], p[2]), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawDeg * Math.PI / 180, 0)), new V3(s, s, s)));
  }
  pop() { this.m = this.stack.pop() || new THREE.Matrix4(); }
  get count() { return this.pos.length / 3; }
  enc(c) {
    if (this.raw) return [c[0], c[1], c[2], c[3] === undefined ? 1 : c[3]];
    let a = 1;
    if (this.emission > 0) a = 1 - (0.5 + 0.5 * S.clamp01(this.emission));
    else if (this.night > 0) a = 1 - 0.5 * S.clamp01(this.night);
    return [c[0], c[1], c[2], a];
  }
  tri(a, b, c, col) {
    if (this.flip) { const t = b; b = c; c = t; }
    const A = new V3(a[0], a[1], a[2]).applyMatrix4(this.m), B = new V3(b[0], b[1], b[2]).applyMatrix4(this.m), C = new V3(c[0], c[1], c[2]).applyMatrix4(this.m);
    const n = new V3().subVectors(B, A).cross(new V3().subVectors(C, A));
    if (n.lengthSq() < 1e-14) return;
    n.normalize();
    const e = this.enc(col);
    for (const p of [A, B, C]) { this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.col.push(e[0], e[1], e[2], e[3]); }
  }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  /** Box by centre + size, optional yaw (deg) around centre, separate top colour. */
  box(c, s, side, top = side, yaw = 0, pitch = 0) {
    const hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * Math.PI / 180, yaw * Math.PI / 180, 0, 'YXZ'));
    const P = (x, y, z) => { const v = new V3(x * hx, y * hy, z * hz).applyQuaternion(q); return [c[0] + v.x, c[1] + v.y, c[2] + v.z]; };
    this.quad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), top);
    this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), side);
    this.quad(P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), P(-1, -1, 1), side);
    this.quad(P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), side);
    this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), side);
    this.quad(P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1), side);
  }
  boxMM(min, max, side, top = side) { this.box([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], [max[0] - min[0], max[1] - min[1], max[2] - min[2]], side, top); }
  /** Frustum standing on bottom centre along +Y (optionally rotated about X/Z by rx/rz degrees). */
  frustum(b, r0, r1, h, seg, col, capTop = true, capBot = true, capCol = col, rx = 0, rz = 0) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * Math.PI / 180, 0, rz * Math.PI / 180));
    const up = new V3(0, 1, 0).applyQuaternion(q);
    const top = [b[0] + up.x * h, b[1] + up.y * h, b[2] + up.z * h];
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      const d0 = new V3(Math.cos(a0), 0, Math.sin(a0)).applyQuaternion(q), d1 = new V3(Math.cos(a1), 0, Math.sin(a1)).applyQuaternion(q);
      const b0 = [b[0] + d0.x * r0, b[1] + d0.y * r0, b[2] + d0.z * r0], b1 = [b[0] + d1.x * r0, b[1] + d1.y * r0, b[2] + d1.z * r0];
      const t0 = [top[0] + d0.x * r1, top[1] + d0.y * r1, top[2] + d0.z * r1], t1 = [top[0] + d1.x * r1, top[1] + d1.y * r1, top[2] + d1.z * r1];
      if (r1 > 1e-4) this.quad(b0, t0, t1, b1, col); else this.tri(b0, top, b1, col);
      if (capTop && r1 > 1e-4) this.tri(top, t1, t0, capCol);
      if (capBot && r0 > 1e-4) this.tri(b, b0, b1, capCol);
    }
  }
  cyl(b, r, h, seg, col, capCol = col, rx = 0, rz = 0) { this.frustum(b, r, r, h, seg, col, true, true, capCol, rx, rz); }
  sphere(c, r, col, seg = 8, rings = 5, sc = [1, 1, 1]) {
    const P = (j, i) => {
      const phi = Math.PI * j / rings, th = Math.PI * 2 * i / seg;
      return [c[0] + Math.sin(phi) * Math.cos(th) * r * sc[0], c[1] + Math.cos(phi) * r * sc[1], c[2] + Math.sin(phi) * Math.sin(th) * r * sc[2]];
    };
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) this.quad(P(j + 1, i), P(j, i), P(j, i + 1), P(j + 1, i + 1), col);
  }
  gem(c, r, h, sides, col, twist = 0) {
    const top = [c[0], c[1] + h / 2, c[2]], bot = [c[0], c[1] - h / 2, c[2]];
    for (let i = 0; i < sides; i++) {
      const a0 = twist + i / sides * Math.PI * 2, a1 = twist + (i + 1) / sides * Math.PI * 2;
      const p0 = [c[0] + Math.cos(a0) * r, c[1], c[2] + Math.sin(a0) * r], p1 = [c[0] + Math.cos(a1) * r, c[1], c[2] + Math.sin(a1) * r];
      this.tri(p0, top, p1, col); this.tri(p1, bot, p0, col);
    }
  }
  /** Flat double-sided leaf pointing along +Z after yaw/tilt (deg). */
  leaf(base, yaw, tilt, len, wid, col, droop = 0) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-tilt * Math.PI / 180, yaw * Math.PI / 180, 0, 'YXZ'));
    const T = (x, y, z) => { const v = new V3(x, y, z).applyQuaternion(q); return [base[0] + v.x, base[1] + v.y, base[2] + v.z]; };
    const tip = T(0, -droop, len), mid = T(0, droop * 0.25, len * 0.45), l = T(-wid / 2, droop * 0.25, len * 0.45), r = T(wid / 2, droop * 0.25, len * 0.45);
    const under = [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
    this.tri(base, l, mid, col); this.tri(base, mid, r, col); this.tri(l, tip, mid, col); this.tri(mid, tip, r, col);
    this.tri(base, mid, l, under); this.tri(base, r, mid, under); this.tri(l, mid, tip, under); this.tri(mid, r, tip, under);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('vcolor', new THREE.Float32BufferAttribute(this.col, 4));
    g.computeBoundingSphere();
    return g;
  }
  mesh(material = S.mat.flat) { return new THREE.Mesh(this.geometry(), material); }
}
S.MeshBuilder = MeshBuilder;
S.geoCache = new Map();
S.cachedGeo = (key, build) => {
  if (!S.geoCache.has(key)) { const mb = new MeshBuilder(); build(mb); S.geoCache.set(key, mb.geometry()); }
  return S.geoCache.get(key);
};
S.meshFrom = (key, build, material = S.mat.flat) => new THREE.Mesh(S.cachedGeo(key, build), material);

/** Swap every mesh under obj to the highlight material (or back). */
S.setHighlight = (obj, on) => {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (on && o.material === S.mat.flat) { o.userData.baseMat = o.material; o.material = S.mat.highlight; }
    else if (!on && o.userData.baseMat) { o.material = o.userData.baseMat; delete o.userData.baseMat; }
  });
};

// ------------------------------------------------------------------ particles (cube-ish points, one pool for everything)
S.particles = (() => {
  const MAX = 700;
  const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 3), vel = new Float32Array(MAX * 3), life = new Float32Array(MAX), grav = new Float32Array(MAX);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.028, vertexColors: true, sizeAttenuation: true }));
  pts.frustumCulled = false;
  let next = 0;
  for (let i = 0; i < MAX; i++) pos[i * 3 + 1] = -999;
  return {
    object: pts,
    emit(p, v, c, lifeS = 0.6, g = 1) {
      const i = next; next = (next + 1) % MAX;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      vel[i * 3] = v.x; vel[i * 3 + 1] = v.y; vel[i * 3 + 2] = v.z;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      life[i] = lifeS; grav[i] = g;
    },
    burst(p, c, n = 10, speed = 1) {
      for (let k = 0; k < n; k++) {
        const v = new V3(S.rand(-1, 1), S.rand(0.2, 1.6), S.rand(-1, 1)).multiplyScalar(speed);
        const cc = S.mix(c, [1, 1, 1], Math.random() * 0.25);
        this.emit(p, v, cc, S.rand(0.35, 0.7), 0.8);
      }
    },
    update(dt) {
      for (let i = 0; i < MAX; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) { pos[i * 3 + 1] = -999; continue; }
        vel[i * 3 + 1] -= 9.8 * grav[i] * dt;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    },
  };
})();

// ------------------------------------------------------------------ collision world: axis-aligned boxes in a uniform grid
class CollisionWorld {
  constructor() { this.boxes = []; this.grid = new Map(); this.cell = 4; this.stamp = 0; }
  key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  add(min, max, sound = 'default') {
    const b = { min: min.slice(), max: max.slice(), sound, s: 0, enabled: true };
    this.boxes.push(b);
    this.index(b);
    return b;
  }
  index(b) {
    const c = this.cell;
    for (let ix = Math.floor(b.min[0] / c); ix <= Math.floor(b.max[0] / c); ix++)
      for (let iz = Math.floor(b.min[2] / c); iz <= Math.floor(b.max[2] / c); iz++) {
        const k = this.key(ix, iz);
        let l = this.grid.get(k); if (!l) { l = []; this.grid.set(k, l); }
        l.push(b);
      }
  }
  query(minx, minz, maxx, maxz, out) {
    out.length = 0; const st = ++this.stamp, c = this.cell;
    for (let ix = Math.floor(minx / c); ix <= Math.floor(maxx / c); ix++)
      for (let iz = Math.floor(minz / c); iz <= Math.floor(maxz / c); iz++) {
        const l = this.grid.get(this.key(ix, iz)); if (!l) continue;
        for (const b of l) if (b.s !== st && b.enabled) { b.s = st; out.push(b); }
      }
    return out;
  }
  /** Ray vs boxes. Returns {t, box, n:[x,y,z]} or null. */
  raycast(o, d, maxT) {
    const ex = [o.x + d.x * maxT, o.z + d.z * maxT];
    const list = this.query(Math.min(o.x, ex[0]) - 0.1, Math.min(o.z, ex[1]) - 0.1, Math.max(o.x, ex[0]) + 0.1, Math.max(o.z, ex[1]) + 0.1, this._tmp || (this._tmp = []));
    let best = null;
    for (const b of list) {
      const r = S.rayBox(o, d, b.min, b.max, maxT);
      if (r && (!best || r.t < best.t)) best = { t: r.t, n: r.n, box: b };
    }
    return best;
  }
  /** Top of the highest box under (x,z) whose top is at most y+climb. */
  groundY(x, z, y, climb = 0.45) {
    const l = this.query(x, z, x, z, this._tmp2 || (this._tmp2 = []));
    let g = -Infinity;
    for (const b of l) if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2] && b.max[1] <= y + climb && b.max[1] > g) g = b.max[1];
    return g;
  }
}
S.CollisionWorld = CollisionWorld;

S.rayBox = (o, d, mn, mx, maxT) => {
  let t0 = 0, t1 = maxT, n = null;
  const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(D[a]) < 1e-9) { if (O[a] < mn[a] || O[a] > mx[a]) return null; continue; }
    let ta = (mn[a] - O[a]) / D[a], tb = (mx[a] - O[a]) / D[a], sign = -1;
    if (ta > tb) { const t = ta; ta = tb; tb = t; sign = 1; }
    if (ta > t0) { t0 = ta; n = [0, 0, 0]; n[a] = sign; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  if (!n) return null; // started inside
  return { t: t0, n };
};

S.raySphere = (o, d, c, r) => {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : (cc < 0 ? 0 : -1);
};

/**
 * Moves an upright box body (feet at pos, half-width r, height h) through the world, axis by axis,
 * stepping up small ledges. Mutates pos & vel. Returns {grounded, wall}.
 */
S.moveBody = (world, pos, vel, dt, r, h, step) => {
  const out = { grounded: false, wall: false, wallNormal: null };
  const list = S._moveList || (S._moveList = []);
  const eps = 0.001;
  const overlaps = (b, p) => p.x + r > b.min[0] + eps && p.x - r < b.max[0] - eps && p.y + h > b.min[1] + eps && p.y < b.max[1] - eps && p.z + r > b.min[2] + eps && p.z - r < b.max[2] - eps;
  const gather = (p) => world.query(p.x - r - 0.5, p.z - r - 0.5, p.x + r + 0.5, p.z + r + 0.5, list);
  const axes = [0, 2];
  for (const ax of axes) {
    const key = ax === 0 ? 'x' : 'z';
    const delta = vel[key] * dt;
    if (delta === 0) continue;
    pos[key] += delta;
    gather(pos);
    for (const b of list) {
      if (!overlaps(b, pos)) continue;
      const rise = b.max[1] - pos.y;
      if (step > 0 && rise > 0 && rise <= step) {
        const saved = pos.y; pos.y = b.max[1] + eps;
        let blocked = false;
        for (const b2 of list) if (overlaps(b2, pos)) { blocked = true; break; }
        if (!blocked) continue;
        pos.y = saved;
      }
      if (delta > 0) pos[key] = b.min[ax] - r - eps; else pos[key] = b.max[ax] + r + eps;
      out.wall = true;
      out.wallNormal = ax === 0 ? [delta > 0 ? -1 : 1, 0, 0] : [0, 0, delta > 0 ? -1 : 1];
      vel[key] = 0;
    }
  }
  const dy = vel.y * dt;
  pos.y += dy;
  gather(pos);
  for (const b of list) {
    if (!overlaps(b, pos)) continue;
    if (dy <= 0) { pos.y = b.max[1]; out.grounded = true; }
    else pos.y = b.min[1] - h - eps;
    vel.y = 0;
  }
  if (!out.grounded && vel.y <= 0) {
    // standing exactly on a surface counts as grounded
    const probe = pos.clone(); probe.y -= 0.02;
    for (const b of list) if (overlaps(b, probe)) { out.grounded = true; break; }
  }
  return out;
};

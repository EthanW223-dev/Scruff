/* Scruff web preview - product catalog, item definitions/models, item physics, plant pots, containers. */
'use strict';
(() => {
  const V3 = THREE.Vector3;
  const C = S.C;

  // ---------------------------------------------------------------- catalog (port of ProductCatalog.cs)
  const P = (S.catalog = {
    MAX_EFFECTS: 4,
    strains: {
      backyard_green: { id: 'backyard_green', name: 'Backyard Green', family: 'green', base: 18, color: [0.45, 0.68, 0.30], grow: 300, min: 4, max: 6, addict: 0.15, packet: 'seeds_backyard', seed: 'seed_backyard' },
      alley_purple: { id: 'alley_purple', name: 'Alley Purple', family: 'green', base: 28, color: [0.55, 0.40, 0.65], grow: 420, min: 4, max: 7, addict: 0.2, packet: 'seeds_purple', seed: 'seed_purple' },
      midnight_gold: { id: 'midnight_gold', name: 'Midnight Gold', family: 'green', base: 42, color: [0.78, 0.68, 0.30], grow: 540, min: 5, max: 8, addict: 0.25, packet: 'seeds_gold', seed: 'seed_gold' },
      blue_crystal: { id: 'blue_crystal', name: 'Blue Crystal', family: 'crystal', base: 55, color: [0.45, 0.75, 0.95], min: 5, max: 5, addict: 0.5 },
    },
    effects: {
      energizing: { name: 'Energizing', adj: 'Zippy', bonus: 0.22, color: [1, 0.9, 0.3] },
      chill: { name: 'Chill', adj: 'Mellow', bonus: 0.10, color: [0.55, 0.85, 1] },
      spicy: { name: 'Spicy', adj: 'Fire', bonus: 0.18, color: [1, 0.4, 0.25] },
      giggly: { name: 'Giggly', adj: 'Goofy', bonus: 0.15, color: [1, 0.55, 0.75] },
      sparkly: { name: 'Sparkly', adj: 'Disco', bonus: 0.32, color: [0.85, 0.6, 1] },
      glowing: { name: 'Glowing', adj: 'Neon', bonus: 0.45, color: [0.4, 1, 0.6] },
      munchies: { name: 'Munchies', adj: 'Snacky', bonus: 0.08, color: [0.9, 0.7, 0.4] },
      paranoid: { name: 'Paranoid', adj: 'Sketchy', bonus: -0.12, color: [0.6, 0.6, 0.6] },
      sleepy: { name: 'Sleepy', adj: 'Dozy', bonus: 0.05, color: [0.5, 0.5, 0.85] },
      smooth: { name: 'Smooth', adj: 'Silky', bonus: 0.28, color: [0.95, 0.85, 0.7] },
      euphoric: { name: 'Euphoric', adj: 'Cloud', bonus: 0.38, color: [1, 0.8, 0.95] },
    },
    rules: [['chill', 'energizing', 'paranoid'], ['paranoid', 'chill', 'chill'], ['giggly', 'chill', 'smooth'], ['energizing', 'giggly', 'euphoric'],
      ['spicy', 'chill', 'munchies'], ['sleepy', 'energizing', 'energizing'], ['smooth', 'sparkly', 'euphoric'], ['munchies', 'spicy', 'sleepy'], ['euphoric', 'spicy', 'paranoid']],
    TIERS: ['Trash', 'Poor', 'Standard', 'Premium', 'Heavenly'],
    TIER_COLORS: ['#9a8c80', '#d9a673', '#e6e6e6', '#80d9ff', '#ffd95a'],
    tier: (q) => (q < 0.2 ? 0 : q < 0.4 ? 1 : q < 0.6 ? 2 : q < 0.8 ? 3 : 4),
    qualityMult: (q) => 0.6 + 0.8 * S.clamp01(q),
    bonus(p) { return (p.effects || []).reduce((s, e) => s + (P.effects[e] ? P.effects[e].bonus : 0), 0); },
    value(p) { const s = P.strains[p.strain]; return s ? s.base * P.qualityMult(p.quality) * Math.max(0.3, 1 + P.bonus(p)) : 0; },
    ask(p) { const s = P.strains[p.strain]; if (!s) return 0; return Math.max(1, Math.round(P.value(p) * S.game.markup(s.family))); },
    name(p) {
      const s = P.strains[p.strain]; if (!s) return 'Unknown';
      let top = null;
      for (const e of p.effects || []) { const d = P.effects[e]; if (d && (!top || d.bonus > top.bonus)) top = d; }
      return top ? `${top.adj} ${s.name}` : s.name;
    },
    qualityTag(q) { const t = P.tier(q); return `<b style="color:${P.TIER_COLORS[t]}">${P.TIERS[t]}</b>`; },
    effectsTag(p) {
      if (!p.effects || !p.effects.length) return '<span class="dim">No effects</span>';
      return p.effects.map((e) => `<b style="color:${S.css(P.effects[e].color)}">${P.effects[e].name}</b>`).join(', ');
    },
    mix(p, add) {
      const r = { strain: p.strain, quality: p.quality, effects: (p.effects || []).slice(), units: p.units };
      for (let i = 0; i < r.effects.length; i++) {
        const rule = P.rules.find((x) => x[0] === r.effects[i] && x[1] === add);
        if (rule) r.effects[i] = rule[2];
      }
      r.effects = [...new Set(r.effects)];
      if (!r.effects.includes(add) && r.effects.length < P.MAX_EFFECTS) r.effects.push(add);
      return r;
    },
    same(a, b) {
      if (!a || !b || a.strain !== b.strain) return false;
      const ea = a.effects || [], eb = b.effects || [];
      return ea.length === eb.length && ea.every((e) => eb.includes(e));
    },
    family: (p) => (P.strains[p.strain] ? P.strains[p.strain].family : 'green'),
    cheapest(fam) { return Object.values(P.strains).filter((s) => s.family === fam).sort((a, b) => a.base - b.base)[0]; },
  });

  // ---------------------------------------------------------------- models (ports of ModelFactory)
  const M = {
    pot: (b) => {
      b.frustum([0, 0, 0], 0.105, 0.135, 0.19, 10, C.terracotta, false);
      const rim = S.mix(C.terracotta, [0, 0, 0], 0.08);
      b.frustum([0, 0.17, 0], 0.145, 0.148, 0.035, 10, rim, false, true);
      b.flip = true; b.frustum([0, 0.015, 0], 0.095, 0.13, 0.19, 10, [0.34, 0.21, 0.15], false, false); b.flip = false;
      b.cyl([0, 0.005, 0], 0.098, 0.01, 10, [0.3, 0.2, 0.14]);
      for (let i = 0; i < 10; i++) {
        const a0 = i / 10 * Math.PI * 2, a1 = (i + 1) / 10 * Math.PI * 2, y = 0.205;
        b.quad([Math.cos(a0) * 0.13, y, Math.sin(a0) * 0.13], [Math.cos(a1) * 0.13, y, Math.sin(a1) * 0.13], [Math.cos(a1) * 0.148, y, Math.sin(a1) * 0.148], [Math.cos(a0) * 0.148, y, Math.sin(a0) * 0.148], rim);
      }
    },
    soil: (col) => (b) => {
      b.cyl([0, -0.012, 0], 0.128, 0.012, 10, col);
      b.box([0.04, 0.002, 0.03], [0.025, 0.012, 0.02], S.mix(col, [0, 0, 0], 0.1), undefined, 30);
    },
    bud: (col) => (b) => {
      const dark = S.mix(col, [0, 0, 0], 0.2), hair = [0.9, 0.55, 0.25];
      b.sphere([0, 0.022, 0], 0.022, col, 7, 4, [1, 1.2, 1]);
      b.sphere([0.014, 0.016, 0.006], 0.015, dark, 6, 3); b.sphere([-0.012, 0.018, -0.008], 0.014, dark, 6, 3);
      b.sphere([0.002, 0.042, 0.002], 0.012, col, 6, 3);
      b.box([0.01, 0.03, 0.018], [0.004, 0.012, 0.004], hair); b.box([-0.015, 0.036, 0.01], [0.004, 0.01, 0.004], hair);
    },
    crystal: (col) => (b) => {
      const light = S.mix(col, [1, 1, 1], 0.35);
      b.emission = 0.15; b.gem([0, 0.03, 0], 0.017, 0.06, 5, col); b.gem([0.016, 0.02, 0.006], 0.01, 0.036, 4, light, 0.4); b.gem([-0.012, 0.018, -0.01], 0.009, 0.03, 4, light, 0.9);
    },
    seed: (b) => b.sphere([0, 0.006, 0], 0.007, [0.45, 0.35, 0.22], 6, 3, [0.8, 1, 1.3]),
    packet: (col) => (b) => {
      b.box([0, 0.045, 0], [0.065, 0.09, 0.008], col);
      b.box([0, 0.035, 0], [0.05, 0.04, 0.0095], [0.95, 0.93, 0.85]);
      b.leaf([0, 0.022, -0.0051], 0, 90, 0.028, 0.016, [0.3, 0.55, 0.25]);
      b.box([0, 0.087, 0], [0.066, 0.008, 0.009], S.mix(col, [0, 0, 0], 0.3));
    },
    soilBag: (b) => {
      const bag = [0.45, 0.33, 0.22];
      b.box([0, 0.12, 0], [0.19, 0.24, 0.085], bag); b.box([0, 0.25, 0], [0.17, 0.03, 0.05], S.mix(bag, [0, 0, 0], 0.25));
      b.box([0, 0.12, -0.0435], [0.13, 0.1, 0.002], [0.9, 0.86, 0.7]); b.box([0, 0.12, 0.0435], [0.13, 0.1, 0.002], [0.9, 0.86, 0.7]);
    },
    can: (b) => {
      const c = [0.3, 0.62, 0.52], d = S.mix(c, [0, 0, 0], 0.3);
      b.cyl([0, 0, 0], 0.07, 0.15, 10, c, d); b.frustum([0, 0.15, -0.01], 0.045, 0.035, 0.02, 8, d);
      b.box([0, 0.12, 0.12], [0.022, 0.022, 0.2], c, c, 0, -40);
      b.frustum([0, 0.2, 0.19], 0.013, 0.026, 0.025, 8, d, true, true, d, 45);
      b.box([0, 0.21, -0.035], [0.022, 0.02, 0.1], d); b.box([0, 0.18, -0.085], [0.022, 0.07, 0.02], d); b.box([0, 0.105, -0.08], [0.022, 0.09, 0.02], d);
    },
    bottle: (body, cap, r, h) => (b) => {
      const bh = h * 0.7;
      b.cyl([0, 0, 0], r, bh, 8, body); b.frustum([0, bh, 0], r, r * 0.4, h * 0.12, 8, body, false);
      b.cyl([0, bh + h * 0.12, 0], r * 0.4, h * 0.08, 8, body); b.cyl([0, bh + h * 0.2, 0], r * 0.45, h * 0.08, 8, cap);
      b.cyl([0, bh * 0.25, 0], r * 1.02, bh * 0.45, 8, [0.95, 0.94, 0.9]);
    },
    tin: (main, stripe) => (b) => { b.cyl([0, 0, 0], 0.028, 0.105, 10, main, C.metal); b.cyl([0, 0.035, 0], 0.0285, 0.03, 10, stripe); b.cyl([0, 0.105, 0], 0.024, 0.006, 10, C.metal); },
    smallBox: (main, stripe, s) => (b) => { b.box([0, s[1] / 2, 0], s, main); b.box([0, s[1] * 0.55, 0], [s[0] * 1.01, s[1] * 0.25, s[2] * 1.01], stripe); },
    candy: (b) => {
      b.sphere([0, 0.022, 0], 0.022, [0.95, 0.45, 0.65], 8, 5, [1.2, 1, 1]);
      b.frustum([0.024, 0.022, 0], 0.004, 0.016, 0.025, 6, [0.98, 0.9, 0.95], true, true, undefined, 0, -90);
      b.frustum([-0.024, 0.022, 0], 0.004, 0.016, 0.025, 6, [0.98, 0.9, 0.95], true, true, undefined, 0, 90);
    },
    glitter: (b) => {
      b.cyl([0, 0, 0], 0.014, 0.1, 8, [0.6, 0.35, 0.8]); b.emission = 0.9;
      for (let i = 0; i < 6; i++) { const a = i * 1.1; b.box([Math.cos(a) * 0.0145, 0.015 + i * 0.013, Math.sin(a) * 0.0145], [0.004, 0.004, 0.004], i % 2 ? [0.8, 0.95, 1] : [1, 0.85, 1]); }
      b.emission = 0; b.cyl([0, 0.1, 0], 0.015, 0.012, 8, [0.95, 0.95, 0.95]);
    },
    glow: (b) => { b.emission = 0.8; b.cyl([0, 0, 0], 0.03, 0.09, 8, [0.35, 1, 0.55]); b.emission = 0; b.frustum([0, 0.09, 0], 0.03, 0.012, 0.02, 8, [0.35, 1, 0.55], false); b.cyl([0, 0.11, 0], 0.013, 0.015, 8, [0.15, 0.15, 0.18]); },
    baggie: (b) => { b.box([0, 0.045, 0], [0.07, 0.09, 0.012], [0.86, 0.9, 0.94]); b.box([0, 0.086, 0], [0.072, 0.007, 0.014], [0.35, 0.55, 0.9]); },
    jarLid: (b) => { b.cyl([0, 0.1, 0], 0.044, 0.018, 10, [0.18, 0.2, 0.22]); b.cyl([0, 0, 0], 0.043, 0.006, 10, [0.7, 0.82, 0.9]); },
    jarGlass: (b) => { b.raw = true; b.cyl([0, 0, 0], 0.042, 0.1, 10, [0.8, 0.92, 1, 0.28]); },
    cash: (stacks) => (b) => {
      for (let i = 0; i < stacks; i++) {
        const c = [0, 0.007 + i * 0.0125, 0];
        b.box(c, [0.078, 0.012, 0.036], [0.45, 0.68, 0.4], [0.53, 0.73, 0.49], i * 7);
        b.box(c, [0.016, 0.0128, 0.0365], [0.95, 0.9, 0.7], [0.95, 0.9, 0.7], i * 7);
      }
    },
  };
  S.models = M;

  // ---------------------------------------------------------------- item definitions (port of ItemDatabase)
  const D = (S.itemDefs = {});
  const def = (d) => { D[d.id] = Object.assign({ radius: 0.04, h: 0.08, mass: 0.3, uses: 0, charge: 0, price: 0, rank: 0, catalog: null, desc: '' }, d); };
  def({ id: 'pot', name: 'Plant Pot', cat: 'tool', catalog: 'supplies', price: 30, radius: 0.14, h: 0.21, mass: 2.5, desc: 'Fill with soil, drop a seed in, keep it watered.', geo: 'pot', build: M.pot });
  def({ id: 'soil_bag', name: 'Soil Bag', cat: 'soil', catalog: 'supplies', price: 20, radius: 0.1, h: 0.27, mass: 3, charge: 3, desc: 'Fills three pots. Tip it over an empty pot.', geo: 'soilbag', build: M.soilBag, pour: { type: 'soil', angle: 100, rate: 0.6, color: [0.35, 0.25, 0.17], tip: [0, 0.27, 0] } });
  def({ id: 'watering_can', name: 'Watering Can', cat: 'tool', catalog: 'supplies', price: 25, radius: 0.1, h: 0.22, mass: 1.2, charge: 1, desc: 'Tilt to water plants. Refill at the sink.', geo: 'can', build: M.can, pour: { type: 'water', angle: 45, rate: 0.3, color: [0.45, 0.7, 0.95], tip: [0, 0.215, 0.205] } });
  def({ id: 'fertilizer', name: 'Fertilizer', cat: 'tool', catalog: 'supplies', price: 35, rank: 1, radius: 0.04, h: 0.15, mass: 0.6, charge: 1, desc: 'Pour a splash into a pot for better quality.', geo: 'fert', build: M.bottle([0.35, 0.62, 0.45], [0.9, 0.9, 0.9], 0.035, 0.15), pour: { type: 'fertilizer', angle: 100, rate: 0.25, color: [0.5, 0.85, 0.4], tip: [0, 0.15, 0] } });
  for (const s of Object.values(P.strains)) {
    if (!s.packet) continue;
    const price = s.id === 'backyard_green' ? 15 : s.id === 'alley_purple' ? 30 : 55, rank = s.id === 'backyard_green' ? 0 : s.id === 'alley_purple' ? 1 : 3;
    def({ id: s.packet, name: s.name + ' Seeds', cat: 'packet', catalog: 'supplies', price, rank, uses: 3, strain: s.id, radius: 0.04, h: 0.09, mass: 0.05, desc: `3 seeds. Grows in ~${Math.round(s.grow / 60)}h. Base $${s.base}/unit.`, geo: 'packet_' + s.id, build: M.packet(s.color), pour: { type: 'seeds', angle: 110, tip: [0, 0.095, 0] } });
  }
  def({ id: 'bud', name: 'Bud', cat: 'unit', radius: 0.03, h: 0.05, mass: 0.02, geoFor: (p) => ['bud_' + (p ? p.strain : ''), M.bud(p && P.strains[p.strain] ? P.strains[p.strain].color : [0.45, 0.68, 0.3])] });
  def({ id: 'crystal', name: 'Crystal', cat: 'unit', radius: 0.03, h: 0.06, mass: 0.03, geoFor: (p) => ['crystal', M.crystal([0.45, 0.75, 0.95])] });
  def({ id: 'baggie', name: 'Baggie', cat: 'container', capacity: 1, radius: 0.04, h: 0.09, mass: 0.01, geo: 'baggie', build: M.baggie });
  def({ id: 'jar', name: 'Jar', cat: 'container', capacity: 5, radius: 0.045, h: 0.12, mass: 0.25, geo: 'jarlid', build: M.jarLid });
  const additive = (id, name, effect, price, rank, geo, build, h) => def({ id, name, cat: 'additive', catalog: 'corner', price, rank, effect, radius: 0.035, h, mass: 0.2, desc: 'Mixer: ' + P.effects[effect].name, geo, build });
  additive('energy_drink', 'Energy Drink', 'energizing', 6, 0, 'tin_energy', M.tin([0.95, 0.85, 0.2], [0.12, 0.12, 0.14]), 0.11);
  additive('mint_gum', 'Mint Gum', 'chill', 4, 0, 'gum', M.smallBox([0.55, 0.9, 0.75], [1, 1, 1], [0.07, 0.02, 0.035]), 0.03);
  additive('chili_flakes', 'Chili Flakes', 'spicy', 5, 0, 'chili', M.bottle([0.85, 0.22, 0.15], [0.95, 0.9, 0.85], 0.025, 0.08), 0.08);
  additive('candy', 'Candy', 'giggly', 3, 0, 'candy', M.candy, 0.045);
  additive('glitter', 'Glitter', 'sparkly', 12, 2, 'glitter', M.glitter, 0.11);
  additive('glow_juice', 'Glow Juice', 'glowing', 20, 3, 'glow', M.glow, 0.125);
  def({ id: 'blue_syrup', name: 'Blue Syrup', cat: 'ingredient', catalog: 'supplies', price: 40, rank: 2, radius: 0.04, h: 0.16, mass: 0.8, desc: 'Chem station ingredient.', geo: 'syrup', build: M.bottle([0.3, 0.5, 0.95], [0.15, 0.15, 0.18], 0.037, 0.16) });
  def({ id: 'fizz_salt', name: 'Fizz Salt', cat: 'ingredient', catalog: 'supplies', price: 25, rank: 2, radius: 0.045, h: 0.1, mass: 0.5, desc: 'Chem station ingredient.', geo: 'salt', build: M.smallBox([0.95, 0.95, 0.92], [0.95, 0.55, 0.25], [0.08, 0.1, 0.05]) });
  for (const s of Object.values(P.strains)) if (s.seed) def({ id: s.seed, name: s.name + ' Seed', cat: 'seed', strain: s.id, radius: 0.012, h: 0.012, mass: 0.01, geo: 'seed', build: M.seed });
  // non-physical shop entries
  def({ id: 'baggies_10', name: 'Baggies x10', cat: 'supply', catalog: 'supplies', price: 10, desc: 'Restocks the baggie box on your packing table.', buy: () => { S.game.state.baggieStock += 10; } });
  def({ id: 'jars_5', name: 'Jars x5', cat: 'supply', catalog: 'supplies', price: 20, rank: 1, desc: 'Jars hold 5 units. Restocks the jar crate.', buy: () => { S.game.state.jarStock += 5; } });
  def({ id: 'unlock_mixer', name: 'Mixing Station', cat: 'unlock', catalog: 'supplies', price: 250, rank: 1, desc: 'Mix product with additives to add effects and value.', buy: () => S.game.unlock('mixer'), owned: () => S.game.state.unlocks.includes('mixer') });
  def({ id: 'unlock_chem', name: 'Chem Station', cat: 'unlock', catalog: 'supplies', price: 600, rank: 2, desc: 'Cook Blue Crystal from Blue Syrup + Fizz Salt.', buy: () => S.game.unlock('chem'), owned: () => S.game.state.unlocks.includes('chem') });
  S.shopOrder = ['pot', 'soil_bag', 'watering_can', 'seeds_backyard', 'baggies_10', 'fertilizer', 'seeds_purple', 'jars_5', 'unlock_mixer', 'blue_syrup', 'fizz_salt', 'unlock_chem', 'seeds_gold',
    'energy_drink', 'mint_gum', 'chili_flakes', 'candy', 'glitter', 'glow_juice'];

  // ---------------------------------------------------------------- plant visuals (port of PlantVisual)
  const STEPS = 24;
  const plantGeo = (strain, growth, variant) => {
    const step = S.clamp(Math.round(growth * STEPS), 0, STEPS), v = Math.abs(variant) % 6;
    return S.cachedGeo(`plant_${strain.id}_${step}_${v}`, (b) => {
      const g = step / STEPS, rng = S.rng(v * 7919 + 17);
      const leafA = S.mix([0.22, 0.45, 0.18], strain.color, 0.2), leafB = S.mix([0.36, 0.62, 0.26], strain.color, 0.25);
      const h = 0.035 + g * 0.46, sr = 0.004 + 0.007 * g;
      b.frustum([0, 0, 0], sr, sr * 0.5, h, 5, [0.38, 0.48, 0.22]);
      const fan = (y, yaw, size, col, tilt = 25) => { for (let i = 0; i < 5; i++) { const len = size * (1 - Math.abs(i - 2) * 0.2); b.leaf([0, y, 0], yaw + (i - 2) * 26, tilt - Math.abs(i - 2) * 8, len, len * 0.26, col, len * 0.18 * g); } };
      if (g < 0.08) { const s = 0.018 + g * 0.3; b.leaf([0, h, 0], 0, 25, s, s * 0.7, leafB); b.leaf([0, h, 0], 180, 25, s, s * 0.7, leafB); }
      else {
        const nodes = 1 + Math.floor(g * 5), baseYaw = rng() * 360;
        for (let n = 0; n < nodes; n++) {
          const t = nodes === 1 ? 0.8 : 0.25 + 0.7 * n / (nodes - 1), size = (0.035 + 0.11 * g) * (1 - 0.35 * n / Math.max(1, nodes)), yaw = baseYaw + n * 90 + rng() * 20;
          for (let side = 0; side < 2; side++) fan(h * t, yaw + side * 180, size, n % 2 ? leafB : leafA);
        }
        fan(h, baseYaw + 45, 0.03 + 0.04 * g, leafB, 60);
      }
    });
  };
  const budPositions = (growth, variant, count) => {
    const h = 0.035 + growth * 0.46, rng = S.rng(variant * 104729 + 3), out = [[0, h + 0.005, 0]];
    for (let i = 1; i < count; i++) {
      const yaw = (i * 137.5 + rng() * 20) * Math.PI / 180, t = 0.55 + 0.4 * (i % 3) / 2, r = 0.03 + 0.04 * (1 - t);
      out.push([Math.cos(yaw) * r, h * t, Math.sin(yaw) * r]);
    }
    return out;
  };

  // ---------------------------------------------------------------- items
  S.items = new Set();
  let nextId = 1;

  class Item {
    constructor(defId, product) {
      const d = D[defId];
      this.def = d; this.id = nextId++;
      this.product = product ? { strain: product.strain, quality: product.quality, effects: (product.effects || []).slice(), units: product.units || 1 } : null;
      this.uses = d.uses; this.charge = d.charge;
      this.group = new THREE.Group();
      this.pos = this.group.position;
      this.vel = new V3(); this.spin = 0;
      this.state = 'world'; // world | held | slot | gone
      this.slot = null; this.resting = false;
      if (d.geoFor) { const [key, build] = d.geoFor(this.product); this.group.add(S.meshFrom(key, build)); }
      else this.group.add(S.meshFrom(d.geo, d.build));
      if (d.id === 'jar') { const gl = S.meshFrom('jarglass', M.jarGlass, S.mat.glass); gl.renderOrder = 2; this.group.add(gl); }
      if (d.cat === 'container') { this.fill = new THREE.Group(); this.group.add(this.fill); this.updateFill(); }
      if (d.id === 'pot') this.pot = new PlantPot(this);
      S.scene.add(this.group);
      S.items.add(this);
    }
    get isUnit() { return this.def.cat === 'unit'; }
    get isContainer() { return this.def.cat === 'container'; }
    get units() { return this.product ? this.product.units : 0; }
    get packaged() { return this.isContainer && this.units > 0; }
    get hasProduct() { return !!this.product && this.product.units > 0 && (this.isUnit || this.isContainer); }
    get center() {
      if (this.pot && this.pot.hasPlant) return new V3(this.pos.x, this.pos.y + 0.12 + this.pot.s.growth * 0.25, this.pos.z);
      return new V3(this.pos.x, this.pos.y + this.def.h / 2, this.pos.z);
    }
    get pickRadius() {
      if (this.pot && this.pot.hasPlant) return 0.2 + this.pot.s.growth * 0.15;
      return Math.max(0.07, this.def.radius * 1.2, this.def.h * 0.6);
    }

    label() {
      const d = this.def, p = this.product;
      if (this.pot) return this.pot.label();
      switch (d.cat) {
        case 'unit': return `${P.name(p)}<br>${P.qualityTag(p.quality)} <span class="money">~$${P.ask(p)}</span>`;
        case 'container':
          if (!this.units) return `Empty ${d.name} <span class="dim">(holds ${d.capacity})</span>`;
          return `${P.name(p)} x${p.units}<br>${P.qualityTag(p.quality)} <span class="money">$${P.ask(p) * p.units}</span>`;
        case 'packet': return this.uses > 0 ? `${d.name} (${this.uses} left)` : `Empty ${d.name}`;
        case 'soil': return this.charge > 0.01 ? `${d.name} (${this.charge.toFixed(1)} pots)` : `Empty ${d.name}`;
        case 'additive': { const e = P.effects[d.effect]; return `${d.name}<br><b style="color:${S.css(e.color)}">${e.name}</b> <span class="dim">(${e.bonus >= 0 ? '+' : ''}${Math.round(e.bonus * 100)}%)</span>`; }
        default:
          if (d.id === 'watering_can') return `${d.name} ${Math.round(this.charge * 100)}%` + (this.charge < 0.05 ? '<br><span class="dim">Refill at the sink</span>' : '');
          if (d.id === 'fertilizer') return `${d.name} ${Math.round(this.charge * 100)}%`;
          return d.name;
      }
    }

    updateFill() {
      if (!this.fill) return;
      this.fill.clear();
      if (!this.units) return;
      const s = P.strains[this.product.strain];
      let col = s ? s.color : [0.4, 0.7, 0.3];
      const eff = this.product.effects;
      if (eff && eff.length) col = S.mix(col, P.effects[eff[eff.length - 1]].color, 0.35);
      const key = col.map((c) => c.toFixed(2)).join('_');
      const frac = S.clamp01(this.units / this.def.capacity);
      if (this.def.id === 'baggie') {
        const m = S.meshFrom('bagfill_' + key, (b) => b.box([0, 0.5, 0], [1, 1, 1], col));
        m.scale.set(0.056, 0.06 * frac, 0.0165); m.position.y = 0.008; this.fill.add(m);
      } else {
        const m = S.meshFrom('jarfill_' + key, (b) => b.cyl([0, 0, 0], 1, 1, 10, col));
        m.scale.set(0.036, 0.085 * frac, 0.036); m.position.y = 0.008; this.fill.add(m);
      }
    }

    /** Put a loose unit into this container. Returns true on success. */
    addUnit(unit) {
      if (!this.isContainer || !unit || !unit.isUnit || this.units >= this.def.capacity) return false;
      if (this.units && !P.same(this.product, unit.product)) return false;
      if (!this.units) this.product = { strain: unit.product.strain, quality: unit.product.quality, effects: unit.product.effects.slice(), units: 1 };
      else { const c = this.product; c.quality = (c.quality * c.units + unit.product.quality) / (c.units + 1); c.units++; }
      unit.destroy();
      this.updateFill();
      S.audio.play('rustle', 0.55, S.rand(0.95, 1.15), this.center);
      S.particles.burst(this.center, P.strains[this.product.strain].color, 5, 0.6);
      S.game.addXp(1);
      S.game.event('packaged');
      return true;
    }

    update(dt) {
      if (this.state !== 'world') return;
      if (this.resting && this.vel.lengthSq() < 1e-6) return;
      this.vel.y -= 9.8 * dt;
      const r = Math.min(this.def.radius, 0.12), h = Math.max(0.02, Math.min(this.def.h, 0.3));
      const before = this.vel.clone();
      const res = S.moveBody(S.cw, this.pos, this.vel, dt, r, h, 0);
      if (res.wall) { this.vel.x = -before.x * 0.3; this.vel.z = -before.z * 0.3; }
      if (res.grounded) {
        if (before.y < -2.5) { this.vel.y = -before.y * 0.25; S.audio.play('thud', S.clamp(-before.y / 8, 0.05, 0.5), S.lerp(1.5, 0.7, S.invLerp(0.02, 3, this.def.mass)), this.pos); }
        const f = Math.exp(-10 * dt); this.vel.x *= f; this.vel.z *= f; this.spin *= f;
        if (this.vel.lengthSq() < 0.01) { this.vel.set(0, 0, 0); this.resting = true; this.spin = 0; }
      } else this.resting = false;
      this.group.rotation.y += this.spin * dt;
      if (this.pos.y < -10) { this.pos.copy(S.refs.homeDelivery).y += 0.3; this.vel.set(0, 0, 0); }
    }

    wake() { this.resting = false; }

    destroy() {
      if (this.state === 'gone') return;
      if (this.slot) this.slot.item = null;
      this.state = 'gone';
      this.group.removeFromParent();
      S.items.delete(this);
      if (S.game && S.game.onItemGone) S.game.onItemGone(this);
    }

    save() {
      return { id: this.def.id, p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.group.rotation.y, product: this.product, uses: this.uses, charge: this.charge, slot: this.slot ? this.slot.key : null, pot: this.pot ? this.pot.s : null };
    }
  }
  S.Item = Item;

  S.spawn = (id, pos, product, yaw = Math.random() * Math.PI * 2) => {
    const it = new Item(id, product);
    it.pos.copy(pos); it.group.rotation.y = yaw;
    return it;
  };
  S.spawnUnit = (product, pos) => S.spawn(P.family(product) === 'crystal' ? 'crystal' : 'bud', pos, Object.assign({}, product, { units: 1 }));
  S.restoreItem = (d) => {
    if (!D[d.id]) return null;
    const it = S.spawn(d.id, new V3(d.p[0], d.p[1], d.p[2]), d.product, d.yaw);
    it.uses = d.uses; it.charge = d.charge;
    if (it.pot && d.pot) { Object.assign(it.pot.s, d.pot); it.pot.refresh(true); }
    if (it.isContainer) it.updateFill();
    if (d.slot && S.slots[d.slot] && !S.slots[d.slot].item) S.game.putInSlot(it, S.slots[d.slot]);
    return it;
  };

  // ---------------------------------------------------------------- plant pot (port of PlantPot.cs)
  class PlantPot {
    constructor(item) {
      this.item = item;
      this.s = { soil: 0, water: 0, fert: 0, strain: null, growth: 0, care: 0, total: 0, fertMin: 0, yield: 0, harvested: 0, variant: S.randi(0, 1000), roll: S.rand(-0.04, 0.04) };
      this.soilMesh = new THREE.Group(); item.group.add(this.soilMesh);
      this.plant = new THREE.Group(); item.group.add(this.plant);
      this.budGroup = new THREE.Group(); this.plant.add(this.budGroup);
      this.built = -1; this.soilKey = '';
      this.wateredFlag = false;
      this.refresh(true);
    }
    get hasSoil() { return this.s.soil >= 0.999; }
    get hasPlant() { return !!this.s.strain; }
    get mature() { return this.hasPlant && this.s.growth >= 1; }
    get strain() { return P.strains[this.s.strain]; }
    get quality() {
      const s = this.s, care = s.total > 0 ? s.care / s.total : 0.5, fert = s.total > 0 ? s.fertMin / s.total : 0;
      return S.clamp01(0.28 + 0.42 * care + 0.28 * fert + s.roll);
    }
    soilY() { return S.lerp(0.03, 0.185, this.s.soil); }

    pour(type, amount) {
      const s = this.s;
      if (type === 'soil') {
        if (this.hasPlant || this.hasSoil) return 0;
        const used = Math.min(amount, 1 - s.soil); s.soil += used;
        if (s.soil >= 0.999) { s.soil = 1; S.audio.play('pop', 0.4, 0.8, this.item.pos); S.particles.burst(this.item.center, C.soilDry, 6, 0.5); S.game.event('soil'); }
        this.refresh(false); return used;
      }
      if (type === 'water') {
        if (!this.hasSoil && !this.hasPlant) return amount;
        s.water = Math.min(1, s.water + amount * 2.5);
        const enough = s.water > 0.5;
        if (enough && !this.wateredFlag && this.hasPlant) S.game.event('watered');
        this.wateredFlag = enough; this.refresh(false); return amount;
      }
      if (type === 'fertilizer') { if (this.hasSoil) s.fert = Math.min(1, s.fert + amount * 4); return amount; }
      return 0;
    }
    plantSeed(strainId) {
      if (!this.hasSoil || this.hasPlant) return false;
      const s = this.s;
      Object.assign(s, { strain: strainId, growth: 0, care: 0, total: 0, fertMin: 0, harvested: 0, yield: 0, roll: S.rand(-0.04, 0.04) });
      this.wateredFlag = false;
      S.audio.play('pop', 0.45, 1.3, this.item.pos);
      S.particles.burst(this.item.center, [0.4, 0.7, 0.3], 6, 0.5);
      S.game.addXp(2); S.game.event('planted');
      this.refresh(true); return true;
    }
    advance(min) {
      const s = this.s;
      if (!this.hasPlant) { s.water = Math.max(0, s.water - min / 900); this.refresh(false); return; }
      const st = this.strain;
      if (!this.mature && st) {
        const watered = s.water > 0.05 ? 1 : 0.15;
        s.growth = Math.min(1, s.growth + min / st.grow * watered * (1 + 0.2 * s.fert));
        s.care += (s.water >= 0.25 ? 1 : s.water > 0.05 ? 0.5 : 0) * min; s.total += min;
        s.fertMin += S.clamp01(s.fert * 2) * min; s.fert = Math.max(0, s.fert - min / 720);
        if (s.growth >= 1 && !s.yield) { s.yield = S.randi(st.min, st.max + 1) + (this.quality > 0.7 ? 1 : 0); S.audio.play('success', 0.35, 1, this.item.pos); this.refresh(true); }
      }
      s.water = Math.max(0, s.water - min / (this.mature ? 960 : 480));
      if (s.water < 0.5) this.wateredFlag = false;
      this.refresh(false);
    }
    harvest() {
      if (!this.mature) return null;
      const s = this.s;
      const product = { strain: s.strain, quality: this.quality, effects: [], units: 1 };
      s.harvested++;
      const top = this.item.pos.clone(); top.y += 0.4;
      S.audio.play('snap', 0.5, S.rand(0.9, 1.1), top);
      S.particles.burst(top, this.strain.color, 5, 0.4);
      S.game.addXp(2);
      if (s.harvested >= s.yield) Object.assign(s, { strain: null, growth: 0, soil: 0, yield: 0, harvested: 0 });
      this.refresh(true);
      S.game.event('harvested');
      return product;
    }
    refresh(force) {
      const s = this.s;
      // soil
      const sk = s.soil > 0.01 || this.hasPlant ? (s.water > 0.35 ? 'wet' : 'dry') : '';
      if (sk !== this.soilKey) {
        this.soilKey = sk; this.soilMesh.clear();
        if (sk) this.soilMesh.add(S.meshFrom('soil_' + sk, M.soil(sk === 'wet' ? C.soilWet : C.soilDry)));
      }
      this.soilMesh.position.y = this.soilY();
      // plant
      this.plant.visible = this.hasPlant;
      if (!this.hasPlant) { this.built = -1; this.budGroup.clear(); return; }
      this.plant.position.y = this.soilY();
      const step = Math.round(s.growth * STEPS);
      if (force || step !== this.built) {
        this.built = step;
        for (let i = this.plant.children.length - 1; i >= 0; i--) if (this.plant.children[i] !== this.budGroup) this.plant.remove(this.plant.children[i]);
        this.plant.add(new THREE.Mesh(plantGeo(this.strain, s.growth, s.variant), S.mat.flat));
        this.budGroup.clear();
        if (s.growth >= 0.7) {
          const count = s.yield ? s.yield - s.harvested : this.strain.min;
          const pos = budPositions(s.growth, s.variant, s.yield || count);
          const sc = S.lerp(0.35, 1, S.invLerp(0.7, 1, s.growth));
          for (let i = 0; i < count; i++) {
            const m = S.meshFrom('bud_' + this.strain.id, M.bud(this.strain.color));
            const p = pos[Math.min(pos.length - 1, (s.yield ? s.harvested : 0) + i)];
            m.position.set(p[0], p[1], p[2]); m.scale.setScalar(sc); m.rotation.y = i * 2.1;
            this.budGroup.add(m);
          }
        }
      }
    }
    label() {
      const s = this.s;
      if (!this.hasPlant) {
        if (s.soil < 0.01) return 'Plant Pot<br><span class="dim">Pour soil in</span>';
        if (!this.hasSoil) return `Plant Pot<br><span class="dim">Soil ${Math.round(s.soil * 100)}%</span>`;
        return 'Plant Pot<br><span class="dim">Drop a seed in</span>';
      }
      const st = this.strain;
      const wc = s.water > 0.25 ? '#7bf' : s.water > 0.05 ? '#fc5' : '#f65';
      if (this.mature) return `${st.name} - <b class="money">Ready!</b><br>${P.qualityTag(this.quality)} - ${s.yield - s.harvested} buds`;
      const eta = s.water > 0.05 ? S.fmtDur((1 - s.growth) * st.grow) : '<b style="color:#f65">needs water</b>';
      return `${st.name} ${Math.round(s.growth * 100)}%<br><span style="color:${wc}">Water ${Math.round(s.water * 100)}%</span> - ${eta}`;
    }
  }
  S.PlantPot = PlantPot;
})();

/* Scruff web preview - game state, player, interaction, stations, tutorial, input, main loop. */
'use strict';
(() => {
  const V3 = THREE.Vector3;
  const P = S.catalog;
  const $ = (id) => document.getElementById(id);
  const EYE = 1.05, RADIUS = 0.22, HEIGHT = 1.15, REACH = 2.6;
  const SAVE_KEY = 'scruff-web-save';
  S.now = 0; S.dt = 0.016;

  // ================================================================ renderer
  function initRenderer() {
    const canvas = $('view');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    S.renderer = renderer;
    S.scene = new THREE.Scene();
    S.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 260);
    S.camera.rotation.order = 'YXZ';
    S.scene.add(S.camera);
    S.scene.add(S.particles.object);
    const resize = () => {
      const r = $('app').getBoundingClientRect();
      renderer.setSize(r.width, r.height, false);
      S.camera.aspect = r.width / Math.max(1, r.height); S.camera.updateProjectionMatrix();
    };
    resize(); window.addEventListener('resize', resize);
  }

  // ================================================================ player
  const player = (S.player = {
    pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, grounded: false, wall: false, held: null, bob: 0, stepDist: 0, tilt: 0, reach: 0, holdPt: null,
    get head() { return new V3(this.pos.x, this.pos.y + EYE, this.pos.z); },
    get fwd() { return new V3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); },
    get right() { return new V3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); },
    holdingProduct() { return !!(this.held && this.held.hasProduct); },
    teleport(p, yaw) { this.pos.copy(p); this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = 0; },
  });

  // monke mitts in view
  const hands = {};
  function buildHands() {
    const fur = [0.55, 0.36, 0.24], skin = [0.3, 0.24, 0.22];
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? -1 : 1, g = new THREE.Group();
      const mb = new S.MeshBuilder();
      mb.box([0, 0, 0], [0.085, 0.04, 0.09], fur); mb.box([0, -0.021, 0.005], [0.07, 0.004, 0.075], skin);
      mb.box([0, 0, -0.055], [0.07, 0.034, 0.03], S.mix(fur, [0, 0, 0], 0.15));
      mb.box([s * 0.012, -0.005, 0.075], [0.058, 0.032, 0.06], fur, fur, 0, 25);
      mb.box([-s * 0.03, 0.004, 0.08], [0.024, 0.028, 0.064], fur);
      mb.box([-s * 0.05, -0.006, 0.02], [0.026, 0.026, 0.05], fur, fur, -s * 35);
      const m = mb.mesh(); m.rotation.y = Math.PI; m.rotation.z = s * -0.5; g.add(m);
      g.position.set(s * 0.21, -0.26, -0.4); S.camera.add(g); hands[side] = g;
    }
  }

  // ================================================================ stations & slots
  S.slots = {};
  S.stations = {};
  function makeSlot(key, pos, accepts) { const s = { key, pos, accepts, item: null }; S.slots[key] = s; return s; }
  function initStations() {
    const R = S.refs.stations;
    S.stations.mixer = {
      slots: R.mixer.slots.map((p, i) => makeSlot('mixer_' + i, p, (it) => it.isUnit)),
      cup: makeSlot('mixer_cup', R.mixer.cup, (it) => it.def.cat === 'additive'),
      mixing: false, timer: 0, loop: S.audio.loop('whir'),
    };
    S.stations.chem = {
      syrup: makeSlot('chem_syrup', R.chem.syrup, (it) => it.def.id === 'blue_syrup'),
      salt: makeSlot('chem_salt', R.chem.salt, (it) => it.def.id === 'fizz_salt'),
      cooking: false, progress: 0, heat: 0, dial: 0, band: 0, total: 0, burn: 0, loop: S.audio.loop('bubble'),
    };
  }
  const unlocked = (id) => !!(S.game.state && S.game.state.unlocks.includes(id));
  function applyUnlocks() {
    for (const id of ['mixer', 'chem']) for (const m of S.refs.stations[id].locked) m.visible = !unlocked(id);
  }

  // ================================================================ game
  const game = (S.game = {
    mode: 'menu', state: null, RENT: 150,
    get absMin() { return this.state ? (this.state.day - 1) * 1440 + this.state.minute : 0; },
    get isNight() { const m = this.state ? this.state.minute : 0; return m >= 21 * 60 || m < 6 * 60; },
    get isCurfew() { const m = this.state ? this.state.minute : 0; return m >= 23 * 60 || m < 5 * 60; },
    get canSleep() { const m = this.state ? this.state.minute : 0; return this.mode === 'playing' && (m >= 18 * 60 || m < 5 * 60); },
    markup(fam) { return this.state && this.state.markup[fam] != null ? this.state.markup[fam] : 1; },
    addCash(n, pos) {
      if (!this.state || !n) return;
      this.state.cash += n; if (n > 0) this.state.earned += n;
      if (n > 0) { S.audio.play('cash', 0.6, 1, pos || null); if (pos) { S.ui.floatText(pos, `+$${n}`); S.particles.burst(pos, S.C.money, 8, 0.7); } }
      S.ui.phoneDirty();
    },
    spend(n) { if (!this.state || this.state.cash < n) return false; this.state.cash -= n; S.ui.phoneDirty(); return true; },
    take(n) { const t = S.clamp(n, 0, this.state.cash); this.state.cash -= t; return t; },
    addXp(n) {
      if (!this.state || n <= 0) return;
      const before = S.rankFor(this.state.xp); this.state.xp += n; const after = S.rankFor(this.state.xp);
      if (after > before) { S.audio.play('rankup', 0.8); S.ui.toast('RANK UP!', `You're now a ${S.RANKS[after]}. New stuff in the shop.`, 'warn', 5); }
    },
    event(type) { S.tutorial.on(type); },
    inSafeZone(p) { const z = S.refs.safeZone; return p.x > z.min[0] && p.x < z.max[0] && p.y > z.min[1] && p.y < z.max[1] && p.z > z.min[2] && p.z < z.max[2]; },
    zoneAt(p) { return S.refs.turf.find((z) => p.x >= z.min[0] && p.x <= z.max[0] && p.z >= z.min[1] && p.z <= z.max[1]) || null; },
    influence(id) { return this.state ? this.state.turf[id] || 0 : 0; },
    turfPriceAt(p) { const z = this.zoneAt(p); return z && this.influence(z.id) >= 0.5 ? 1.1 : 1; },
    recordSale(pos, pay) {
      const z = this.zoneAt(pos); if (!z) return;
      const before = this.influence(z.id);
      this.state.turf[z.id] = S.clamp01(before + 0.03 + pay / 1500);
      if (before < 0.5 && this.state.turf[z.id] >= 0.5) { S.ui.toast('TURF TAKEN', `${z.name} is your turf now. Customers here pay +10%.`, 'warn', 5); S.audio.play('rankup', 0.6); }
    },
    unlock(id) { this.state.unlocks.push(id); applyUnlocks(); S.ui.toast('Unlocked: ' + (id === 'mixer' ? 'Mixing Station' : 'Chem Station'), "It's set up in your apartment.", 'warn', 4); S.audio.play('rankup', 0.6); },
    putInSlot(item, slot) {
      if (player.held === item) player.held = null;
      if (item.slot) item.slot.item = null;
      item.state = 'slot'; item.slot = slot; slot.item = item;
      item.pos.copy(slot.pos); item.group.rotation.set(0, Math.random() * 6, 0); item.vel.set(0, 0, 0);
      S.audio.play('snap', 0.35, S.rand(0.95, 1.1), slot.pos);
    },
    onItemGone(item) { if (player.held === item) player.held = null; },

    newState() {
      const st = {
        v: 1, seed: Math.floor(Math.random() * 2e9), day: 1, minute: 8 * 60, cash: 80, xp: 0, earned: 0, unitsSold: 0,
        rentDebt: 0, nextRent: 7, unlocks: [], baggieStock: 5, jarStock: 0, markup: { green: 1, crystal: 1 },
        customers: [], deals: [], messages: [], nextDeal: 1, turf: {}, tutorial: 0, items: [],
      };
      S.npcs.generate(st, 12);
      return st;
    },
    clearWorld() {
      player.held = null;
      for (const it of [...S.items]) it.destroy();
      for (const s of Object.values(S.slots)) s.item = null;
      S.npcs.despawnAll(); S.deals.clear();
      const ch = S.stations.chem; Object.assign(ch, { cooking: false, progress: 0, band: 0, total: 0, burn: 0 });
      S.stations.mixer.mixing = false;
    },
    startPlaying() {
      applyUnlocks();
      S.npcs.spawnAll();
      S.deals.syncBeacons();
      player.teleport(S.refs.homeSpawn, S.refs.homeYaw);
      this.mode = 'playing';
      $('title').hidden = true; $('hud').hidden = false;
      S.input.showTouch(true);
    },
    async newGame() {
      S.ui.closePanel();
      await S.ui.fade('Day 1', () => {
        this.clearWorld();
        this.state = this.newState();
        const st = S.refs.starter;
        S.spawn('pot', st.pot, null, 0); S.spawn('soil_bag', st.soil); S.spawn('seeds_backyard', st.seeds); S.spawn('watering_can', st.can);
        this.startPlaying();
        S.deals.message('Uncle Ray', 'heard u got kicked out lol. got u this dump of an apartment.', 0);
        S.deals.message('Uncle Ray', "left u a pot, soil and some seeds. grow it, bag it, sell it. rent's $150, due sunday.", 0);
        S.deals.message('Uncle Ray', 'two of my guys already know ur selling. check ur CREW app.', 0);
        S.ui.toast('Welcome to Scruff', "You've got $80 and a pot. Follow the goal card." + (S.input.touch ? '' : ' Phone: Tab.'), 'good', 6);
        this.save(true);
      });
    },
    async continueGame() {
      let loaded = null;
      try { loaded = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { loaded = null; }
      if (!loaded || !loaded.customers) return this.newGame();
      await S.ui.fade('Welcome back', () => {
        this.clearWorld();
        this.state = loaded;
        applyUnlocks();
        for (const d of loaded.items || []) S.restoreItem(d);
        this.startPlaying();
        S.ui.toast(`Day ${loaded.day}`, `${S.fmtTime(loaded.minute)} - ${S.money(loaded.cash)}`, 'good');
      });
    },
    save(silent) {
      const st = this.state; if (!st) return false;
      for (const c of S.npcs.customers) if (c.cash) c.collectCash();
      st.items = [...S.items].filter((i) => i.state === 'world' || i.state === 'slot' || i === player.held).map((i) => i.save());
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(st)); } catch (e) { if (!silent) S.ui.toast("Couldn't save", 'This browser is blocking storage for the page.', 'bad'); return false; }
      if (!silent) S.ui.toast('Saved', `Day ${st.day}, ${S.fmtTime(st.minute)}`, 'good', 2);
      return true;
    },
    hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } },
    async quitToMenu() {
      this.save(true);
      this.mode = 'transition';
      await S.ui.fade('Saved', () => { this.clearWorld(); this.state = null; enterMenu(); });
    },
    async sleep() {
      if (!this.canSleep) { S.ui.toast("Can't sleep yet", 'You can sleep after 6 PM.', 'info', 2.5); return; }
      this.mode = 'transition';
      await S.ui.fade('Zzz...', () => {
        skipTo(7 * 60); S.police.reset(); this.mode = 'playing'; this.save(true);
        S.ui.toast(`Day ${this.state.day} - ${S.dayName(this.state.day)}`, 'Rise and grind. Game saved.', 'good');
      });
    },
    async bust() {
      if (this.mode !== 'playing') return;
      this.mode = 'transition';
      let lost = 0;
      if (player.held && player.held.hasProduct) { lost = player.held.product.units; player.held.destroy(); player.held = null; }
      await S.ui.fade('BUSTED', () => {
        const fine = this.take(Math.max(20, Math.round(this.state.cash * 0.25)));
        player.teleport(S.refs.homeSpawn, S.refs.homeYaw);
        advance(120); S.police.reset(); this.mode = 'playing';
        S.ui.toast('BUSTED', `${lost ? `They took ${lost} units of product` : "They didn't find anything"} and fined you $${fine}. Released 2 hours later.`, 'bad', 6);
        this.save(true);
      });
    },
    async passOut() {
      this.mode = 'transition';
      await S.ui.fade('You passed out...', () => {
        const lost = this.take(Math.round(this.state.cash * 0.1));
        player.teleport(S.refs.homeSpawn, S.refs.homeYaw);
        skipTo(7 * 60); S.police.reset(); this.mode = 'playing'; this.save(true);
        S.ui.toast('You passed out', lost ? `Woke up at home. $${lost} is missing from your pocket...` : 'Woke up at home. Get some sleep next time.', 'warn', 5);
      });
    },
  });

  // ================================================================ clock (port of GameClock + GameManager time events)
  function advance(minutes) {
    const st = game.state; if (!st || minutes <= 0) return;
    let rem = minutes;
    while (rem > 0) {
      const toNext = Math.floor(st.minute + 1) - st.minute || 1;
      const step = Math.min(rem, toNext), prev = Math.floor(st.minute);
      st.minute += step; rem -= step;
      if (Math.floor(st.minute) !== prev) {
        if (st.minute >= 1440) { st.minute -= 1440; st.day++; newDay(); }
        if (game.mode === 'playing') S.deals.tick();
        const whole = Math.floor(st.minute);
        if (whole % 60 === 0) hour(whole / 60);
      }
    }
    for (const it of S.items) if (it.pot) it.pot.advance(minutes);
    chemAdvance(minutes);
  }
  function skipTo(target) { let d = target - game.state.minute; if (d <= 0) d += 1440; advance(d); }
  function hour(h) {
    if (game.mode !== 'playing') return;
    const st = game.state;
    if (h === 4) game.passOut();
    else if (h === 20 && st.day + 1 >= st.nextRent && !st.rentDebt) S.ui.toast('Rent due tomorrow', `$${game.RENT} comes out in the morning. You have ${S.money(st.cash)}.`, 'warn', 4);
  }
  function newDay() {
    const st = game.state;
    if (st.rentDebt > 0 && st.cash >= st.rentDebt) { st.cash -= st.rentDebt; S.ui.toast('Debt paid', `Paid off the $${st.rentDebt} you owed.`, 'good'); st.rentDebt = 0; }
    if (st.day >= st.nextRent) {
      st.nextRent += 7;
      if (st.cash >= game.RENT) { st.cash -= game.RENT; S.ui.toast('Rent paid', `-$${game.RENT}. Next due ${S.dayName(st.nextRent)}.`, 'info'); }
      else { st.rentDebt += game.RENT; S.deals.message('Landlord', `rent's late. you owe $${st.rentDebt}. pay up or you're out.`, 0); S.ui.toast('Rent missed!', `You owe $${st.rentDebt}. It'll be taken as soon as you have it.`, 'bad', 5); }
    }
    for (const k of Object.keys(st.turf)) st.turf[k] = Math.max(0, st.turf[k] - 0.03);
  }

  // ================================================================ tutorial (port of TutorialSystem)
  const STEPS = [
    ['Grab the soil bag in the grow corner, look at the empty pot and hold R to pour.', 'soil'],
    ['Grab the seed packet, look at the pot and hold R so a seed drops in.', 'planted'],
    ['Water it: grab the watering can, look at the pot, hold R. (Refill at the sink.)', 'watered'],
    ['Let it grow and keep it watered. Sleep after 6 PM to skip time. Click the plant to pick buds when ready.', 'harvested'],
    ['Click the baggie box on the packing table while holding a bud to bag it.', 'packaged'],
    ['Sell it: accept a deal on your phone (Tab) and hand the bag to the customer. Or find someone who wants some.', 'sold'],
  ];
  S.tutorial = {
    current() { const st = game.state; return st && st.tutorial < STEPS.length ? STEPS[st.tutorial][0] : null; },
    on(type) {
      const st = game.state; if (!st || st.tutorial >= STEPS.length || STEPS[st.tutorial][1] !== type) return;
      st.tutorial++;
      S.audio.play('success', 0.5);
      if (st.tutorial < STEPS.length) S.ui.toast('Goal complete', 'New goal, top right.', 'warn', 2.5);
      else { S.ui.toast("You're in business", 'Buy more seeds and pots on the computer, set prices on your phone, and keep away from the cops.', 'warn', 7); S.deals.message('Uncle Ray', "look at u go. rent's still due sunday tho", 0); }
    },
  };

  // ================================================================ aiming
  const tmpBox = { min: [0, 0, 0], max: [0, 0, 0] };
  function target() {
    const o = S.camera.position.clone(), d = new V3(0, 0, -1).applyQuaternion(S.camera.quaternion);
    const wh = S.cw.raycast(o, d, 30), tw = wh ? wh.t : Infinity;
    const lim = Math.min(REACH, tw + 0.05);
    let best = null;
    const consider = (t, obj) => { if (t >= 0 && t < lim && (!best || t < best.t)) best = Object.assign({ t }, obj); };
    // cash held out by customers first
    for (const c of S.npcs.customers) if (c.cash && c.group.visible) consider(S.raySphere(o, d, c.cashWorldPos(), 0.14), { kind: 'cash', npc: c });
    if (best) return best;
    for (const it of S.items) if ((it.state === 'world' || it.state === 'slot') && it !== player.held) consider(S.raySphere(o, d, it.center, it.pickRadius), { kind: 'item', item: it });
    if (best) return best;
    for (const n of S.npcs.all()) consider(S.raySphere(o, d, n.chest, 0.42), { kind: 'npc', npc: n });
    const R = S.refs.stations;
    const boxT = (b) => { const r = S.rayBox(o, d, b.min, b.max, lim); return r ? r.t : -1; };
    const stationBoxes = [['bed', R.bed.pick], ['sink', R.sink.pick], ['trash', R.trash.pick], ['baggies', R.packing.baggies], ['jars', R.packing.jars],
      ['mixer', R.mixer.pick], ['chem', R.chem.pick], ['computer', R.computer.pick], ['kiosk', R.kiosk.pick], ['door', S.refs.door.pick]];
    for (const [name, b] of stationBoxes) consider(boxT(b), { kind: 'station', name });
    if (best) return best;
    if (wh && wh.t < REACH) return { kind: 'surface', t: wh.t, point: o.clone().add(d.clone().multiplyScalar(wh.t)), normal: wh.n };
    return null;
  }

  function describe(t) {
    const held = player.held;
    if (!t) return [held ? held.label() : '', held ? (held.def.pour ? '<kbd>R</kbd> hold to pour - <kbd>Q</kbd> drop - <kbd>F</kbd> throw' : '<kbd>Q</kbd> drop - <kbd>F</kbd> throw') : ''];
    if (t.kind === 'cash') return [`<b class="money">$${t.npc.cash.amount}</b>`, '<kbd>Click</kbd> take the cash'];
    if (t.kind === 'item') {
      const it = t.item;
      if (held && held.isUnit && it.isContainer) return [it.label(), '<kbd>Click</kbd> put it in the bag'];
      if (held && held.isContainer && it.isUnit) return [it.label(), '<kbd>Click</kbd> bag it'];
      if (held && held.def.pour && it.pot) return [it.label(), `<kbd>R</kbd> hold to pour the ${held.def.name.toLowerCase()}`];
      if (held && held.def.cat === 'seed' && it.pot) return [it.label(), '<kbd>Click</kbd> plant the seed'];
      if (it.pot && it.pot.mature) return [it.label(), held && !(held.isContainer) ? 'Hands full' : '<kbd>Click</kbd> pick a bud'];
      if (held) return [it.label(), '<kbd>Click</kbd> put it down here'];
      return [it.label(), '<kbd>Click</kbd> pick up'];
    }
    if (t.kind === 'npc') {
      const n = t.npc;
      if (n instanceof S.Customer) {
        const name = n.p.contact ? n.p.name : 'Stranger';
        if (n.cash) return [`<b>${S.esc(name)}</b> <b class="money">$${n.cash.amount}</b>`, '<kbd>Click</kbd> take the cash'];
        if (held && held.packaged) return [`<b>${S.esc(name)}</b><br><i>"${S.esc(n.preview(held))}"</i>`, '<kbd>Click</kbd> hand it over'];
        if (held && held.isUnit) return [`<b>${S.esc(name)}</b>`, 'Bag it first - customers only buy packaged product'];
        return [`<b>${S.esc(name)}</b>${n.p.contact ? `<br><span class="dim">${n.p.fam === 'green' ? 'Green' : 'Crystal'} customer</span>` : ''}`, '<kbd>Click</kbd> talk'];
      }
      return [`<b>${S.esc(n.name)}</b>`, held && held.hasProduct ? '<span class="bad">Hide that!</span>' : ''];
    }
    if (t.kind === 'station') {
      const st = game.state;
      switch (t.name) {
        case 'bed': return ['Bed', game.canSleep ? '<kbd>Click</kbd> sleep until morning (saves)' : 'You can sleep after 6 PM'];
        case 'sink': return ['Sink', held && held.def.id === 'watering_can' ? '<kbd>Click</kbd> fill the watering can' : 'Fill a watering can here'];
        case 'trash': return ['Trash', held ? '<kbd>Click</kbd> throw it away' : ''];
        case 'baggies': return [`Baggies (${st.baggieStock} left)`, st.baggieStock ? (held && held.isUnit ? '<kbd>Click</kbd> bag what you are holding' : held ? 'Hands full' : '<kbd>Click</kbd> take a baggie') : 'Out of baggies - buy more on the computer'];
        case 'jars': return [`Jars (${st.jarStock} left)`, st.jarStock ? (held && held.isUnit ? '<kbd>Click</kbd> jar what you are holding' : held ? 'Hands full' : '<kbd>Click</kbd> take a jar (holds 5)') : 'Out of jars - buy on the computer (rank 1)'];
        case 'mixer': return ['Mixing station', !unlocked('mixer') ? 'Locked - buy it on the computer (rank 1)' : held && (held.isUnit || held.def.cat === 'additive') ? '<kbd>Click</kbd> place it on the station' : '<kbd>Click</kbd> open the mixer'];
        case 'chem': return ['Chem station', !unlocked('chem') ? 'Locked - buy it on the computer (rank 2)' : held && (held.def.id === 'blue_syrup' || held.def.id === 'fizz_salt') ? '<kbd>Click</kbd> place it on the pad' : '<kbd>Click</kbd> open the stove'];
        case 'computer': return ['Computer', '<kbd>Click</kbd> order supplies'];
        case 'kiosk': return ['Corner Mart kiosk', '<kbd>Click</kbd> buy mixers'];
        case 'door': return ['Door', '<kbd>Click</kbd> open / close'];
      }
    }
    if (t.kind === 'surface' && held) return [held.label(), '<kbd>Click</kbd> put it down'];
    return [held ? held.label() : '', ''];
  }

  // ================================================================ actions
  function pickUp(it) {
    if (it.slot) { it.slot.item = null; it.slot = null; }
    it.state = 'held'; it.resting = false; player.held = it; player.reach = 1;
    S.audio.play('pop', 0.3, S.rand(0.95, 1.15));
  }
  function placeHeld(point) {
    const it = player.held; if (!it) return;
    player.held = null; it.state = 'world'; it.resting = false;
    it.pos.copy(point); it.pos.y += 0.01; it.vel.set(0, 0, 0);
    it.group.rotation.set(0, player.yaw + Math.PI, 0);
    S.audio.play('drop', 0.3, S.rand(0.95, 1.1), point);
  }
  function dropHeld(throwIt) {
    const it = player.held; if (!it) return;
    player.held = null; it.state = 'world'; it.resting = false;
    const f = new V3(0, 0, -1).applyQuaternion(S.camera.quaternion);
    it.vel.copy(player.vel).add(throwIt ? f.multiplyScalar(7).add(new V3(0, 1.2, 0)) : f.multiplyScalar(0.8));
    it.spin = throwIt ? S.rand(-8, 8) : 0; it.thrown = throwIt;
    it.group.rotation.x = 0; it.group.rotation.z = 0;
    S.audio.play('drop', 0.3, throwIt ? 0.8 : 1);
  }
  function takeFromDispenser(kind) {
    const st = game.state, key = kind === 'baggies' ? 'baggieStock' : 'jarStock';
    if (st[key] <= 0) { S.audio.play('error', 0.4); return; }
    const held = player.held;
    if (held && !held.isUnit) { S.audio.play('error', 0.3); return; }
    st[key]--;
    const box = S.refs.stations.packing[kind];
    const c = S.spawn(kind === 'baggies' ? 'baggie' : 'jar', new V3((box.min[0] + box.max[0]) / 2, box.max[1], (box.min[2] + box.max[2]) / 2));
    S.audio.play('rustle', 0.4);
    if (held) { player.held = null; held.state = 'world'; c.addUnit(held); }
    pickUp(c);
  }
  function use() {
    if (game.mode !== 'playing') return;
    const t = target(), held = player.held;
    player.reach = 1;
    if (!t) return; // clicking at nothing never drops what you hold (Q drops, F throws)
    switch (t.kind) {
      case 'cash': t.npc.collectCash(); return;
      case 'item': {
        const it = t.item;
        if (held) {
          if (held.isUnit && it.isContainer) { player.held = null; held.state = 'world'; if (!it.addUnit(held)) { player.held = held; held.state = 'held'; S.audio.play('error', 0.4); S.ui.toast("Doesn't fit", it.units ? 'Containers only take one kind of product.' : 'That one is full.', 'info', 2); } return; }
          if (held.isContainer && it.isUnit) { if (!held.addUnit(it)) { S.audio.play('error', 0.4); } return; }
          if (held.def.cat === 'seed' && it.pot) { if (it.pot.plantSeed(held.def.strain)) { const h = held; player.held = null; h.destroy(); } else S.audio.play('error', 0.4); return; }
          if (it.pot && it.pot.mature && held.isContainer) { const p = it.pot.harvest(); if (p) { const u = S.spawnUnit(p, it.center); if (!held.addUnit(u)) { u.destroy(); S.spawnUnit(p, it.center.add(new V3(0, 0.3, 0))); } } return; }
          placeHeld(new V3(it.pos.x + S.rand(-0.05, 0.05), it.pos.y + it.def.h, it.pos.z + S.rand(-0.05, 0.05)));
          return;
        }
        if (it.pot && it.pot.mature) { const p = it.pot.harvest(); if (p) pickUp(S.spawnUnit(p, it.center.add(new V3(0, 0.2, 0)))); return; }
        pickUp(it); return;
      }
      case 'npc': {
        const n = t.npc;
        if (n instanceof S.Customer) {
          if (n.cash) { n.collectCash(); return; }
          if (held && held.packaged) { if (n.receive(held)) player.held = null; return; }
          if (held && held.isUnit) { n.say('Bag it up first.', 2); return; }
          n.face(player.head, 2); n.greetCd = 0; n.greet(S.deals.active(n.p.id));
          return;
        }
        n.say(held && held.hasProduct ? "What's that?!" : 'Move along.', 2);
        if (held && held.hasProduct) n.suspicion = Math.min(1, n.suspicion + 0.6);
        return;
      }
      case 'station': return useStation(t.name, held);
      case 'surface':
        if (held) { if (t.normal[1] > 0.5) placeHeld(t.point); else dropHeld(false); }
        return;
    }
  }
  function useStation(name, held) {
    const st = game.state;
    switch (name) {
      case 'bed': game.sleep(); return;
      case 'computer': S.ui.openPanel('shop', 'supplies'); return;
      case 'kiosk': S.ui.openPanel('shop', 'corner'); return;
      case 'door': { const d = S.refs.door; d.target = d.target > 10 ? 0 : 95; S.audio.play('door', 0.35, S.rand(0.9, 1.1), new V3(0, 1, 15.9)); return; }
      case 'trash': if (held) { const h = held; player.held = null; S.particles.burst(S.refs.stations.trash.mouth, [0.5, 0.5, 0.5], 6, 0.4); S.audio.play('thud', 0.4, 0.8, S.refs.stations.trash.mouth); h.destroy(); } return;
      case 'sink':
        if (held && held.def.id === 'watering_can') { held.charge = 1; const tap = S.refs.stations.sink.tap; for (let i = 0; i < 30; i++) S.particles.emit(tap, new V3(S.rand(-0.05, 0.05), -0.5, S.rand(-0.05, 0.05)), [0.5, 0.75, 1], 0.4, 1); S.audio.play('rustle', 0.4, 1.6, tap); S.ui.toast('Filled up', 'Watering can is full.', 'info', 1.5); }
        return;
      case 'baggies': case 'jars': takeFromDispenser(name); return;
      case 'mixer': {
        if (!unlocked('mixer')) { S.audio.play('error', 0.4); return; }
        const m = S.stations.mixer;
        if (held && held.isUnit) { const s = m.slots.find((x) => !x.item); if (s) game.putInSlot(held, s); else S.ui.toast('Tray is full', 'Four units at a time.', 'info', 2); return; }
        if (held && held.def.cat === 'additive') { if (!m.cup.item) game.putInSlot(held, m.cup); else S.ui.toast('Cup is taken', 'Take the other mixer out first.', 'info', 2); return; }
        S.ui.openPanel('mixer'); return;
      }
      case 'chem': {
        if (!unlocked('chem')) { S.audio.play('error', 0.4); return; }
        const c = S.stations.chem;
        if (held && held.def.id === 'blue_syrup') { if (!c.syrup.item) game.putInSlot(held, c.syrup); return; }
        if (held && held.def.id === 'fizz_salt') { if (!c.salt.item) game.putInSlot(held, c.salt); return; }
        S.ui.openPanel('chem'); return;
      }
    }
  }

  // ================================================================ station logic
  function mixStart() {
    const m = S.stations.mixer;
    if (m.mixing || !m.cup.item || !m.slots.some((s) => s.item)) return;
    m.mixing = true; m.timer = 0; m.loop.start(); S.ui.renderPanel();
  }
  function mixUpdate(dt) {
    const m = S.stations.mixer;
    m.loop.setLevel(S.lerp(m.loop.level, m.mixing ? 0.5 : 0, S.damp(4, dt)));
    if (!m.mixing) return;
    m.timer += dt;
    if (Math.random() < dt * 30) S.particles.emit(S.refs.stations.mixer.bowl, new V3(S.rand(-0.3, 0.3), S.rand(0.3, 0.8), S.rand(-0.3, 0.3)), [1, 0.85, 1], 0.6, 0.2);
    if (m.timer < 2.2) return;
    m.mixing = false;
    const add = m.cup.item, effect = add.def.effect;
    let n = 0;
    for (const s of m.slots) if (s.item) { s.item.product = P.mix(s.item.product, effect); S.particles.burst(s.item.center, P.effects[effect].color, 6, 0.5); n++; }
    add.destroy(); m.cup.item = null;
    S.audio.play('success', 0.5, 1, S.refs.stations.mixer.bowl);
    game.addXp(3 * n);
    S.ui.renderPanel();
  }
  function chemStart() {
    const c = S.stations.chem;
    if (c.cooking || !c.syrup.item || !c.salt.item) return;
    for (const s of [c.syrup, c.salt]) { S.particles.burst(s.item.center, [0.5, 0.7, 1], 8, 0.6); s.item.destroy(); s.item = null; }
    Object.assign(c, { cooking: true, progress: 0, band: 0, total: 0, burn: 0 });
    c.loop.start(); S.audio.play('pop', 0.5, 0.7, S.refs.stations.chem.potTop);
    S.ui.renderPanel();
  }
  function chemAdvance(min) {
    const c = S.stations.chem; if (!c.cooking) return;
    c.progress += min * S.lerp(0.25, 1.35, c.heat) / 50; c.total += min;
    if (c.heat >= 0.55 && c.heat <= 0.78) c.band += min;
    if (c.heat > 0.92) c.burn += min;
    if (c.progress < 1) return;
    c.cooking = false; c.progress = 0;
    const band = c.total ? c.band / c.total : 0, burnt = c.total ? c.burn / c.total : 0;
    const q = S.clamp01(0.2 + 0.72 * band - 0.6 * burnt + S.rand(-0.04, 0.04));
    const units = Math.max(1, 5 - Math.round(burnt * 3)), out = S.refs.stations.chem.output;
    for (let i = 0; i < units; i++) S.spawn('crystal', out.clone().add(new V3((i % 3 - 1) * 0.06, 0.02 + Math.floor(i / 3) * 0.05, 0)), { strain: 'blue_crystal', quality: q, effects: [], units: 1 });
    S.particles.burst(out, P.strains.blue_crystal.color, 14, 0.8);
    S.audio.play('success', 0.6, 1, out); game.addXp(15);
    S.ui.toast('Cook finished', `${units}x Blue Crystal (${P.TIERS[P.tier(q)]})`, 'good');
    S.ui.renderPanel();
  }
  function chemUpdate(dt) {
    const c = S.stations.chem, R = S.refs.stations.chem;
    const drift = c.cooking ? (Math.sin(S.now * 0.37) * 0.6 + Math.sin(S.now * 0.91 + 1.3) * 0.4) * 0.17 : 0;
    c.heat = S.lerp(c.heat, S.clamp01(c.dial + drift), 1 - Math.exp(-dt * 0.9));
    R.flame.visible = c.cooking && c.heat > 0.05;
    c.loop.setLevel(S.lerp(c.loop.level, c.cooking ? 0.2 + c.heat * 0.4 : 0, S.damp(2, dt)));
    if (c.cooking && c.heat > 0.3 && Math.random() < dt * 20) S.particles.emit(R.potTop.clone().add(new V3(S.rand(-0.05, 0.05), 0, S.rand(-0.05, 0.05))), new V3(0, S.rand(0.2, 0.4), 0), [0.6, 0.85, 1], 0.7, -0.05);
    if (S.ui.panel && S.ui.panel.kind === 'chem') {
      const n = $('heatNeedle'); if (n) n.style.left = c.heat * 100 + '%';
      const pr = $('chemProgress'); if (pr) pr.style.width = c.progress * 100 + '%';
      const stx = $('chemStatus');
      if (stx && c.cooking) {
        const zone = c.heat > 0.92 ? '<b class="bad">TOO HOT - burning!</b>' : c.heat >= 0.55 && c.heat <= 0.78 ? '<b class="good">Perfect heat</b>' : c.heat > 0.78 ? '<b class="warn">A bit hot</b>' : '<b style="color:#8cf">Too cold - slow</b>';
        stx.innerHTML = `${zone} - in the zone ${c.total ? Math.round(c.band / c.total * 100) : 0}%`;
      }
    }
  }

  // ================================================================ pouring (hold R with a pourable)
  const pourLoops = {};
  let seedTimer = 0;
  function pourUpdate(dt, t) {
    const held = player.held, pour = held && held.def.pour;
    const want = pour && S.input.pourHeld ? 115 : 0;
    player.tilt = S.lerp(player.tilt, want, S.damp(9, dt));
    const pot = t && t.kind === 'item' && t.item.pot ? t.item : null;
    player.pourTarget = pour && S.input.pourHeld && pot ? pot : null;
    let active = false, type = pour ? pour.type : null;
    if (pour && player.tilt > pour.angle) {
      const has = pour.type === 'seeds' ? held.uses > 0 : held.charge > 0.0001;
      if (has) {
        active = true;
        const tip = held.group.localToWorld(new V3(...pour.tip));
        if (pour.type === 'seeds') {
          seedTimer -= dt;
          if (seedTimer <= 0) {
            seedTimer = 0.55; held.uses--;
            S.audio.play('rustle', 0.3, 1.5, tip);
            if (pot && pot.pot.hasSoil && !pot.pot.hasPlant) { S.particles.emit(tip, new V3(0, -1, 0), [0.45, 0.35, 0.22], 0.3, 1); pot.pot.plantSeed(held.def.strain); }
            else { const sd = S.spawn(P.strains[held.def.strain].seed, tip); sd.vel.set(0, -0.5, 0); }
          }
        } else {
          const strength = S.clamp01(S.invLerp(pour.angle, pour.angle + 35, player.tilt) * 0.7 + 0.3);
          const amount = Math.min(held.charge, pour.rate * strength * dt);
          if (pot) { const used = pot.pot.pour(pour.type, amount); held.charge -= pour.type === 'soil' ? used : amount; }
          else if (pour.type !== 'soil') held.charge -= amount;
          held.charge = Math.max(0, held.charge);
          const n = Math.ceil(90 * strength * dt);
          for (let i = 0; i < n; i++) S.particles.emit(tip.clone().add(new V3(S.rand(-0.01, 0.01), 0, S.rand(-0.01, 0.01))), new V3(S.rand(-0.1, 0.1), -0.3, S.rand(-0.1, 0.1)), S.mix(pour.color, [1, 1, 1], Math.random() * 0.2), 0.45, 1);
        }
      }
    }
    for (const kind of ['soil', 'water']) {
      const loop = pourLoops[kind] || (pourLoops[kind] = S.audio.loop(kind === 'soil' ? 'pour_soil' : 'pour_water'));
      const on = active && (kind === 'soil' ? type === 'soil' : type === 'water' || type === 'fertilizer');
      if (on) loop.start();
      loop.setLevel(S.lerp(loop.level, on ? 0.45 : 0, S.damp(6, dt)));
    }
  }

  // ================================================================ per-frame player update
  function updatePlayer(dt) {
    const inp = S.input;
    if (!S.ui.phoneOpen && !S.ui.panel) {
      player.yaw -= inp.lookDX * 0.0022 * S.settings.sensitivity;
      player.pitch = S.clamp(player.pitch - inp.lookDY * 0.0022 * S.settings.sensitivity, -1.45, 1.45);
    }
    inp.lookDX = inp.lookDY = 0;
    const blocked = !!(S.ui.panel || game.mode !== 'playing');
    let mx = blocked ? 0 : inp.moveX, mz = blocked ? 0 : inp.moveY;
    const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
    const speed = inp.run ? 5.2 : 3.0, f = player.fwd, r = player.right;
    const dx = (f.x * mz + r.x * mx) * speed, dz = (f.z * mz + r.z * mx) * speed;
    const k = S.damp(player.grounded ? 14 : 3, dt);
    player.vel.x = S.lerp(player.vel.x, dx, k); player.vel.z = S.lerp(player.vel.z, dz, k);
    player.vel.y -= 18 * dt;
    if (!blocked && inp.jumpPressed && player.grounded) { player.vel.y = 5.4; S.audio.play('tap', 0.25, 1.1); }
    // monke climbing: hold jump against a wall
    if (!blocked && inp.jumpHeld && player.wall && len > 0.1) {
      player.vel.y = Math.max(player.vel.y, 3.2);
      player.climbT = (player.climbT || 0) - dt;
      if (player.climbT <= 0) { player.climbT = 0.28; S.audio.play('tap', 0.35, S.rand(0.9, 1.2)); player.reach = 1; }
    }
    inp.jumpPressed = false;
    const vy = player.vel.y, wasGrounded = player.grounded;
    const res = S.moveBody(S.cw, player.pos, player.vel, dt, RADIUS, HEIGHT, 0.4);
    player.grounded = res.grounded; player.wall = res.wall;
    if (res.grounded && !wasGrounded && vy < -3.5) S.audio.play('tap', S.clamp(-vy / 10, 0.1, 0.7), S.rand(0.85, 1.1));
    const hs = Math.hypot(player.vel.x, player.vel.z);
    if (player.grounded && hs > 0.5) {
      player.bob += hs * dt * 2.2; player.stepDist += hs * dt;
      if (player.stepDist > 0.9) { player.stepDist = 0; S.audio.play('tap', 0.08, S.rand(0.8, 1.2)); }
    }
    if (player.pos.y < -15) player.teleport(S.refs.homeSpawn, S.refs.homeYaw);
    const cam = S.camera;
    cam.position.set(player.pos.x, player.pos.y + EYE + Math.abs(Math.sin(player.bob)) * 0.03 * S.clamp01(hs / 3), player.pos.z);
    cam.rotation.set(player.pitch, player.yaw, 0);
  }

  function updateHeld(dt, t) {
    const it = player.held;
    player.reach = Math.max(0, player.reach - dt * 5);
    const swing = Math.sin(player.bob) * 0.012;
    hands.R.position.set(0.21, -0.26 + swing - player.reach * 0.03, -0.4 - player.reach * 0.12);
    hands.L.position.set(-0.21, -0.26 - swing, -0.4);
    hands.R.visible = hands.L.visible = game.mode === 'playing';
    if (!it) return;
    const cam = S.camera;
    let want = cam.localToWorld(new V3(0.2, -0.24, -0.52));
    if (player.pourTarget) want = player.pourTarget.pos.clone().add(new V3(0, 0.42, 0)).add(player.fwd.multiplyScalar(-0.12));
    if (!player.holdPt || player.holdPt.distanceTo(want) > 1.5) player.holdPt = want.clone();
    player.holdPt.lerp(want, S.damp(player.pourTarget ? 10 : 30, dt));
    it.pos.copy(player.holdPt);
    it.group.rotation.set(player.tilt * Math.PI / 180, player.yaw + Math.PI, 0, 'YXZ');
    hands.R.position.set(0.21, -0.2, -0.46);
  }

  // thrown items that hit people
  function thrownHits() {
    for (const it of S.items) {
      if (!it.thrown || it.state !== 'world') continue;
      if (it.resting || it.vel.lengthSq() < 4) { it.thrown = false; continue; }
      for (const n of S.npcs.all()) if (n.chest.distanceTo(it.center) < 0.45) { n.hitBy(it, it.vel.length()); it.vel.multiplyScalar(-0.3); it.thrown = false; break; }
    }
  }

  // door animation
  function doorUpdate(dt) {
    const d = S.refs.door;
    d.angle = S.lerp(d.angle, d.target, S.damp(6, dt));
    d.group.rotation.y = d.angle * Math.PI / 180;
    d.collider.enabled = d.angle < 20;
  }

  // ================================================================ menu
  function enterMenu() {
    game.mode = 'menu';
    $('title').hidden = false; $('hud').hidden = true;
    S.ui.togglePhone(false); S.ui.closePanel();
    S.input.showTouch(false); S.input.releasePointer();
    $('continueBtn').hidden = !game.hasSave();
    $('newBtn').classList.toggle('primary', !game.hasSave());
  }

  // ================================================================ input
  const input = (S.input = {
    moveX: 0, moveY: 0, run: false, jumpHeld: false, jumpPressed: false, pourHeld: false, lookDX: 0, lookDY: 0,
    keys: new Set(), pointerOk: true, touch: false, lockFails: 0, lastGesture: -10,
    /** Only ever called from a click/key handler: browsers refuse pointer lock without a user gesture. */
    lockPointer() {
      if (this.touch || !this.pointerOk || S.ui.phoneOpen || S.ui.panel || game.mode !== 'playing') return;
      if (performance.now() - this.lastGesture > 1000) return;
      const c = S.renderer.domElement;
      try { const p = c.requestPointerLock(); if (p && p.catch) p.catch(() => this.lockFailed()); } catch (e) { this.lockFailed(); }
    },
    lockFailedAt: -10,
    /** Pointer lock refused (sandboxed page, or re-locking too soon). After a few refusals fall back to drag-to-look. */
    lockFailed() {
      const now = performance.now(); if (now - this.lockFailedAt < 100) return;
      this.lockFailedAt = now;
      if (++this.lockFails >= 2 && this.pointerOk) { this.pointerOk = false; S.ui.toast('Drag to look', "Mouse capture isn't available here, so drag to look around and click to use.", 'info', 5); }
    },
    releasePointer() { if (document.pointerLockElement) document.exitPointerLock(); },
    get locked() { return document.pointerLockElement === S.renderer.domElement; },
    showTouch(on) { $('touch').hidden = !(on && this.touch); },
    updateKeys() {
      const k = this.keys;
      const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      const kz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      this.moveX = kx + this.stickX; this.moveY = kz + this.stickY;
      this.run = k.has('ShiftLeft') || k.has('ShiftRight') || this.stickRun;
      this.jumpHeld = k.has('Space') || this.touchJump;
      this.pourHeld = k.has('KeyR') || this.touchPour;
    },
    stickX: 0, stickY: 0, stickRun: false, touchJump: false, touchPour: false,
  });

  function initInput() {
    const canvas = S.renderer.domElement;
    const gesture = () => { input.lastGesture = performance.now(); };
    window.addEventListener('pointerdown', gesture, true);
    window.addEventListener('keydown', gesture, true);
    window.addEventListener('keydown', (e) => {
      S.audio.unlock();
      if (e.target && (e.target.tagName === 'INPUT')) return;
      if (e.code === 'Tab' || e.code === 'KeyP') { e.preventDefault(); if (game.mode === 'playing') { if (S.ui.panel) S.ui.closePanel(); S.ui.togglePhone(); } return; }
      if (e.code === 'Escape') { if (S.ui.panel) S.ui.closePanel(); else if (S.ui.phoneOpen) S.ui.togglePhone(false); return; }
      if (e.code === 'Space') { e.preventDefault(); if (!input.keys.has('Space')) input.jumpPressed = true; }
      if (game.mode === 'playing' && !S.ui.panel && !S.ui.phoneOpen) {
        if (e.code === 'KeyE' && !e.repeat) use();
        if (e.code === 'KeyF' && !e.repeat && player.held) dropHeld(true);
        if (e.code === 'KeyQ' && !e.repeat && player.held) dropHeld(false);
      }
      input.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => input.keys.delete(e.code));
    window.addEventListener('blur', () => input.keys.clear());

    let dragStart = null, dragMoved = false;
    canvas.addEventListener('mousedown', (e) => {
      S.audio.unlock();
      if (game.mode !== 'playing' || input.touch) return;
      if (input.locked) { if (e.button === 0) use(); if (e.button === 2 && player.held) dropHeld(true); return; }
      if (!S.ui.panel && !S.ui.phoneOpen) {
        dragStart = { x: e.clientX, y: e.clientY, t: performance.now() }; dragMoved = false;
        if (input.pointerOk) input.lockPointer();
      }
    });
    // dragging looks around whenever the mouse isn't captured (and is the only way when capture is unavailable)
    window.addEventListener('mousemove', (e) => {
      if (input.locked) { input.lookDX += e.movementX; input.lookDY += e.movementY; return; }
      if (dragStart) {
        input.lookDX += e.movementX; input.lookDY += e.movementY;
        if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 6) dragMoved = true;
      }
    });
    window.addEventListener('mouseup', () => {
      const lockRefused = dragStart && input.lockFailedAt >= dragStart.t;
      if (dragStart && !dragMoved && !input.locked && (!input.pointerOk || lockRefused) && game.mode === 'playing') use();
      dragStart = null;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockerror', () => input.lockFailed());
    document.addEventListener('pointerlockchange', () => {
      if (input.locked) input.lockFails = 0; $('lockHint').hidden = input.locked || input.touch || game.mode !== 'playing' || !!S.ui.panel || S.ui.phoneOpen; });

    // ---- touch
    const touchArea = $('app');
    const look = { id: null, x: 0, y: 0, moved: 0 }, stick = { id: null, x: 0, y: 0 };
    const knob = $('stickKnob'), base = $('stick');
    touchArea.addEventListener('touchstart', (e) => {
      S.audio.unlock();
      if (!input.touch) { input.touch = true; input.showTouch(game.mode === 'playing'); }
      if (game.mode !== 'playing' || e.target.closest('button, #phone, #panel, input')) return;
      for (const t of e.changedTouches) {
        const w = window.innerWidth;
        if (t.clientX < w * 0.42 && stick.id === null) { stick.id = t.identifier; stick.x = t.clientX; stick.y = t.clientY; base.style.left = t.clientX + 'px'; base.style.top = t.clientY + 'px'; base.classList.add('on'); }
        else if (look.id === null) { look.id = t.identifier; look.x = t.clientX; look.y = t.clientY; look.moved = 0; }
      }
      e.preventDefault();
    }, { passive: false });
    touchArea.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stick.id) {
          let dx = t.clientX - stick.x, dy = t.clientY - stick.y; const d = Math.hypot(dx, dy), max = 50;
          if (d > max) { dx *= max / d; dy *= max / d; }
          knob.style.transform = `translate(${dx}px, ${dy}px)`;
          input.stickX = dx / max; input.stickY = -dy / max; input.stickRun = d > max * 0.95;
        } else if (t.identifier === look.id) {
          const dx = t.clientX - look.x, dy = t.clientY - look.y;
          input.lookDX += dx * 2.2; input.lookDY += dy * 2.2; look.moved += Math.abs(dx) + Math.abs(dy);
          look.x = t.clientX; look.y = t.clientY;
        }
      }
      if (game.mode === 'playing') e.preventDefault();
    }, { passive: false });
    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stick.id) { stick.id = null; input.stickX = input.stickY = 0; input.stickRun = false; knob.style.transform = ''; base.classList.remove('on'); }
        else if (t.identifier === look.id) { if (look.moved < 10 && game.mode === 'playing' && !S.ui.panel && !S.ui.phoneOpen) use(); look.id = null; }
      }
    };
    touchArea.addEventListener('touchend', endTouch); touchArea.addEventListener('touchcancel', endTouch);
    const hold = (id, on, off) => { const b = $(id); b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); on(); }, { passive: false }); b.addEventListener('touchend', (e) => { e.preventDefault(); off(); }); };
    hold('tUse', () => use(), () => {});
    hold('tPour', () => { input.touchPour = true; }, () => { input.touchPour = false; });
    hold('tJump', () => { input.touchJump = true; input.jumpPressed = true; }, () => { input.touchJump = false; });
    hold('tThrow', () => { if (player.held) dropHeld(true); }, () => {});
    hold('tPhone', () => S.ui.togglePhone(), () => {});

    // ---- UI buttons (event delegation)
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act], [data-app]');
      if (!b || b.disabled) return;
      S.audio.unlock(); S.audio.play('click', 0.5);
      if (b.dataset.app) { S.ui.app = b.dataset.app; S.ui.confirmQuit = false; S.ui.renderPhone(); return; }
      const act = b.dataset.act, id = Number(b.dataset.id);
      switch (act) {
        case 'continue': game.continueGame(); break;
        case 'newgame': if (game.hasSave()) S.ui.openPanel('confirmNew'); else game.newGame(); break;
        case 'newgame-yes': S.ui.closePanel(); game.newGame(); break;
        case 'howto': S.ui.openPanel('howto'); break;
        case 'close': S.ui.closePanel(); break;
        case 'phoneClose': S.ui.togglePhone(false); break;
        case 'accept': S.deals.accept(id); S.ui.renderPhone(); break;
        case 'decline': S.deals.decline(id); S.ui.renderPhone(); break;
        case 'markup': { const f = b.dataset.fam; game.state.markup[f] = S.clamp(Math.round((game.markup(f) + Number(b.dataset.d)) * 10) / 10, 0.5, 2.5); S.ui.renderPhone(); break; }
        case 'save': game.save(); break;
        case 'sens': S.settings.sensitivity = S.clamp(Math.round((S.settings.sensitivity + Number(b.dataset.d)) * 10) / 10, 0.3, 3); S.saveSettings(); S.ui.renderPhone(); break;
        case 'vol': S.settings.volume = S.clamp01(Math.round((S.settings.volume + Number(b.dataset.d)) * 10) / 10); S.audio.setVolume(S.settings.volume); S.saveSettings(); S.ui.renderPhone(); break;
        case 'timescale': S.settings.timeScale = Number(b.dataset.t); S.saveSettings(); S.ui.renderPhone(); break;
        case 'quit': if (!S.ui.confirmQuit) { S.ui.confirmQuit = true; S.ui.renderPhone(); } else { S.ui.togglePhone(false); game.quitToMenu(); } break;
        case 'buy': buy(b.dataset.id); break;
        case 'mix': mixStart(); break;
        case 'cook': chemStart(); break;
      }
    });
    document.addEventListener('input', (e) => { if (e.target.id === 'heatDial') S.stations.chem.dial = Number(e.target.value) / 100; });
  }

  function buy(id) {
    const d = S.itemDefs[id], st = game.state;
    if (!d || d.rank > S.rankFor(st.xp) || (d.owned && d.owned())) return;
    if (!game.spend(d.price)) { S.audio.play('error', 0.5); S.ui.toast("Can't afford that", `${d.name} costs $${d.price}.`, 'bad', 2.5); return; }
    if (d.buy) d.buy();
    else {
      const base = S.ui.panel.arg === 'supplies' ? S.refs.homeDelivery : S.refs.storeDelivery;
      const n = [...S.items].filter((i) => i.state === 'world' && i.pos.distanceTo(base) < 0.6).length;
      const a = n * 2.39996, p = base.clone().add(new V3(Math.cos(a) * 0.14 * Math.min(3, n), 0.05, Math.sin(a) * 0.14 * Math.min(3, n)));
      S.spawn(id, p); S.particles.burst(p, [0.45, 0.88, 0.5], 10, 0.8);
    }
    S.audio.play('coin', 0.6);
    S.ui.renderPanel();
  }

  // ================================================================ main loop
  let last = performance.now(), autosave = 0, phoneTimer = 0, orbit = 0;
  function frame(nowMs) {
    const dt = Math.min(0.05, Math.max(0.0001, (nowMs - last) / 1000)); last = nowMs;
    S.now += dt; S.dt = dt;
    input.updateKeys();
    if (game.mode === 'menu') {
      orbit += dt * 0.05;
      S.camera.position.set(8 + Math.cos(orbit) * 38, 16, 18 + Math.sin(orbit) * 38);
      S.camera.lookAt(8, 1, 16);
      S.applyDayNight(17.6 * 60, S.renderer);
    } else {
      updatePlayer(dt);
      if (game.mode === 'playing' && game.state) {
        advance(dt / Math.max(0.05, 1 / S.settings.timeScale));
        autosave += dt; if (autosave > 120) { autosave = 0; game.save(true); }
      }
      if (game.state) S.applyDayNight(game.state.minute, S.renderer);
      S.npcs.update(dt);
      const t = game.mode === 'playing' && !S.ui.panel && !S.ui.phoneOpen ? target() : null;
      pourUpdate(dt, t);
      updateHeld(dt, t);
      for (const it of S.items) it.update(dt);
      thrownHits();
      mixUpdate(dt); chemUpdate(dt); doorUpdate(dt);
      S.deals.updateBeacons();
      if (game.mode === 'playing' && !S.ui.panel && !S.ui.phoneOpen) { const [look, hint] = describe(t); S.ui.setLook(look, hint); } else S.ui.setLook('', '');
      $('crosshair').classList.toggle('hot', !!(t && t.kind !== 'surface'));
      S.ui.hud();
      phoneTimer -= dt;
      if (S.ui.phoneOpen && (S.ui.dirty || phoneTimer <= 0)) { phoneTimer = 2; S.ui.renderPhone(); }
      $('lockHint').hidden = input.locked || input.touch || !input.pointerOk || game.mode !== 'playing' || !!S.ui.panel || S.ui.phoneOpen;
    }
    S.particles.update(dt);
    S.renderer.render(S.scene, S.camera);
    requestAnimationFrame(frame);
  }

  // ================================================================ boot
  function boot() {
    try {
      initRenderer();
      S.buildWorld(S.scene);
      initStations();
      buildHands();
      initInput();
      S.applyDayNight(17.6 * 60, S.renderer);
      enterMenu();
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) input.touch = true;
      document.body.classList.add('ready');
      requestAnimationFrame((t) => { last = t; frame(t); });
    } catch (e) {
      console.error(e);
      $('bootError').hidden = false;
      $('bootError').textContent = "Scruff couldn't start 3D graphics in this browser (" + e.message + '). Try a desktop browser with WebGL enabled.';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

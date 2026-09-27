/* Scruff web preview - characters, customers, police, deals (ports of CharacterModel, CustomerNPC, PoliceNPC, DealSystem). */
'use strict';
(() => {
  const V3 = THREE.Vector3;
  const P = S.catalog;
  const NAMES = ['Kyle', 'Tasha', 'Dmitri', 'Rosa', 'Benny', 'Marcus', 'Jolene', 'Tyrese', 'Wendy', 'Ricky', 'Priya', 'Chad', 'Lou', 'Imani', 'Gus', 'Deb', 'Hector', 'Mei', 'Otis', 'Sal', 'Tamika', 'Vince', 'Bree', 'Nando'];

  // ---------------------------------------------------------------- character model
  S.randomLook = (rng, police = false) => {
    const pk = (a) => a[Math.floor(rng() * a.length)];
    const look = {
      skin: pk(S.SKIN), shirt: pk(S.CLOTHES), pants: pk(S.PANTS), hair: pk(S.HAIR), accent: pk(S.CLOTHES),
      shoes: rng() < 0.5 ? [0.15, 0.15, 0.16] : [0.9, 0.9, 0.88], hairStyle: Math.floor(rng() * 6), glasses: rng() < 0.25, hoodie: rng() < 0.35,
      height: 0.86 + rng() * 0.1, bulk: 0.9 + rng() * 0.25, police,
    };
    if (police) Object.assign(look, { shirt: S.C.policeShirt, pants: S.C.policeBlue, accent: S.C.policeBlue, shoes: [0.1, 0.1, 0.11], hairStyle: 2, hoodie: false, height: 0.93 + rng() * 0.05, bulk: 1.05 + rng() * 0.15 });
    return look;
  };

  class CharacterModel {
    constructor(a) {
      this.root = new THREE.Group();
      this.height = 1.74 * a.height;
      const body = new THREE.Group(); body.scale.set(a.bulk * a.height, a.height, a.height); this.root.add(body);
      const sleeve = a.hoodie || a.police ? a.shirt : a.skin;
      const part = (parent, pos, build) => { const mb = new S.MeshBuilder(); build(mb); const m = mb.mesh(); m.position.set(...pos); parent.add(m); return m; };
      const leg = (b) => { b.box([0, -0.36, 0], [0.13, 0.72, 0.15], a.pants); b.box([0, -0.77, 0.035], [0.14, 0.08, 0.24], a.shoes, S.mix(a.shoes, [1, 1, 1], 0.1)); };
      const arm = (b) => { b.box([0, -0.14, 0], [0.1, 0.3, 0.12], a.shirt); b.box([0, -0.41, 0], [0.09, 0.26, 0.1], sleeve); b.box([0, -0.585, 0.01], [0.09, 0.09, 0.1], a.skin); };
      this.lLeg = part(body, [-0.09, 0.82, 0], leg);
      this.rLeg = part(body, [0.09, 0.82, 0], leg);
      this.torso = part(body, [0, 0.82, 0], (b) => {
        b.box([0, 0.05, 0], [0.32, 0.14, 0.19], a.pants);
        b.box([0, 0.35, 0], [0.36, 0.46, 0.21], a.shirt, S.mix(a.shirt, [1, 1, 1], 0.08));
        if (a.hoodie) { b.box([0, 0.52, -0.1], [0.28, 0.14, 0.08], S.mix(a.shirt, [0, 0, 0], 0.15)); b.box([0, 0.25, 0.106], [0.2, 0.1, 0.01], S.mix(a.shirt, [0, 0, 0], 0.12)); }
        if (a.police) { b.box([-0.09, 0.45, 0.107], [0.05, 0.06, 0.01], S.C.badge); b.box([0, 0.12, 0], [0.37, 0.05, 0.22], [0.12, 0.12, 0.13]); }
      });
      this.head = part(this.torso, [0, 0.6, 0], (b) => {
        const dk = [0.08, 0.08, 0.1];
        b.box([0, 0.02, 0], [0.1, 0.06, 0.1], a.skin); b.box([0, 0.18, 0], [0.25, 0.27, 0.25], a.skin);
        b.box([-0.055, 0.2, 0.126], [0.035, 0.045, 0.01], dk); b.box([0.055, 0.2, 0.126], [0.035, 0.045, 0.01], dk);
        b.box([-0.055, 0.235, 0.127], [0.045, 0.01, 0.01], S.mix(a.hair, [0, 0, 0], 0.2)); b.box([0.055, 0.235, 0.127], [0.045, 0.01, 0.01], S.mix(a.hair, [0, 0, 0], 0.2));
        b.box([0, 0.15, 0.135], [0.03, 0.05, 0.03], S.mix(a.skin, [0, 0, 0], 0.12));
        if (a.glasses) { b.box([-0.055, 0.2, 0.133], [0.07, 0.06, 0.006], dk); b.box([0.055, 0.2, 0.133], [0.07, 0.06, 0.006], dk); }
        switch (a.hairStyle) {
          case 1: b.box([0, 0.325, -0.005], [0.27, 0.05, 0.27], a.hair); b.box([0, 0.23, -0.12], [0.27, 0.16, 0.04], a.hair); break;
          case 2: b.box([0, 0.335, -0.005], [0.27, 0.07, 0.27], a.accent); b.box([0, 0.31, 0.17], [0.24, 0.02, 0.12], S.mix(a.accent, [0, 0, 0], 0.2)); if (a.police) b.box([0, 0.34, 0.137], [0.05, 0.04, 0.01], S.C.badge); break;
          case 3: b.frustum([0, 0.28, 0], 0.145, 0.08, 0.12, 8, a.accent); break;
          case 4: b.sphere([0, 0.3, -0.02], 0.18, a.hair, 8, 5); break;
          case 5: b.box([0, 0.325, -0.005], [0.27, 0.05, 0.27], a.hair); b.box([0, 0.16, -0.12], [0.28, 0.34, 0.05], a.hair); b.box([-0.135, 0.2, -0.03], [0.03, 0.22, 0.18], a.hair); b.box([0.135, 0.2, -0.03], [0.03, 0.22, 0.18], a.hair); break;
        }
      });
      this.mouth = part(this.head, [0, 0.095, 0.127], (b) => b.box([0, 0, 0], [0.08, 0.016, 0.008], [0.45, 0.18, 0.18]));
      this.lArm = part(this.torso, [-0.235, 0.54, 0], arm);
      this.rArm = part(this.torso, [0.235, 0.54, 0], arm);
      this.rHand = new THREE.Group(); this.rHand.position.set(0, -0.6, 0.05); this.rArm.add(this.rHand);
      this.lHand = new THREE.Group(); this.lHand.position.set(0, -0.6, 0.05); this.lArm.add(this.lHand);
      this.phase = 0; this.speed = 0; this.talk = 0; this.offer = 0; this.offerTarget = 0; this.wave = 0; this.flinch = 0; this.hy = 0; this.hp = 0; this.time = Math.random() * 10; this.look = null;
    }
    animate(speed, dt) {
      this.time += dt;
      this.speed = S.lerp(this.speed, speed, S.damp(8, dt));
      const walk = S.clamp01(this.speed / 1.2), run = S.clamp01((this.speed - 2) / 2);
      this.phase += this.speed / 1.15 * Math.PI * dt * (1 + run * 0.3);
      const s = Math.sin(this.phase), DEG = Math.PI / 180;
      const legSwing = s * (28 + 14 * run) * walk * DEG;
      this.lLeg.rotation.x = legSwing; this.rLeg.rotation.x = -legSwing;
      const breath = Math.sin(this.time * 2.1) * (1 - walk), armSwing = s * (22 + 28 * run) * walk * DEG, sway = Math.sin(this.time * 1.3) * 2 * (1 - walk) * DEG;
      this.offer = S.lerp(this.offer, this.offerTarget, S.damp(8, dt));
      this.lArm.rotation.set(-armSwing + sway, 0, (-4 - breath) * DEG);
      this.rArm.rotation.set(S.lerp(armSwing - sway, -72 * DEG, this.offer), S.lerp(0, -12 * DEG, this.offer), (4 + breath) * DEG);
      if (this.wave > 0) { this.wave -= dt; const w = S.clamp01(this.wave * 3) * S.clamp01((1.4 - this.wave) * 5); this.lArm.rotation.z = S.lerp(this.lArm.rotation.z, (-150 + Math.sin(this.time * 14) * 18) * DEG, w); }
      this.flinch = Math.max(0, this.flinch - dt * 3);
      this.torso.position.y = 0.82 + Math.abs(s) * 0.035 * walk + breath * 0.004;
      this.torso.rotation.set((6 * run - this.flinch * 14) * DEG, 0, s * 2 * walk * DEG);
      let ty = Math.sin(this.time * 0.4) * 20 * (1 - walk), tp = 0;
      if (this.look) {
        const local = this.torso.worldToLocal(this.look.clone());
        local.sub(this.head.position); local.y -= 0.2;
        ty = S.clamp(Math.atan2(local.x, local.z) / DEG, -70, 70);
        tp = S.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)) / DEG, -30, 35);
      }
      this.hy = S.lerp(this.hy, ty, S.damp(6, dt)); this.hp = S.lerp(this.hp, tp, S.damp(6, dt));
      this.head.rotation.set(this.hp * DEG, this.hy * DEG, 0);
      if (this.talk > 0) { this.talk -= dt; this.mouth.scale.y = 1 + Math.abs(Math.sin(this.time * 17)) * 1.8; } else this.mouth.scale.y = 1;
    }
  }

  // ---------------------------------------------------------------- NPC base
  class NPC {
    constructor(name, look, pitch) {
      this.name = name; this.pitch = pitch;
      this.model = new CharacterModel(look);
      this.group = this.model.root; this.pos = this.group.position;
      this.path = []; this.walkSpeed = 1.25; this.runSpeed = 3.8; this.running = false;
      this.faceUntil = 0; this.facePoint = null; this.moveSpeed = 0;
      this.bubble = S.ui.bubble(); this.icon = '';
      this.hits = 0; this.lastHit = -10;
      S.scene.add(this.group);
    }
    get chest() { return new V3(this.pos.x + Math.sin(this.group.rotation.y) * 0.22, this.pos.y + this.model.height * 0.62, this.pos.z + Math.cos(this.group.rotation.y) * 0.22); }
    get headPos() { return new V3(this.pos.x, this.pos.y + this.model.height - 0.1, this.pos.z); }
    get distToPlayer() { return S.dist2(this.pos.x, this.pos.z, S.player.pos.x, S.player.pos.z); }
    moveTo(x, z, run = false) { this.path = S.findPath(this.pos.x, this.pos.z, x, z); this.running = run; }
    stop() { this.path = []; }
    get arrived() { return this.path.length === 0; }
    face(p, sec = 1.5) { this.facePoint = p.clone(); this.faceUntil = S.now + sec; }
    say(text, dur = 2.5) { this.bubble.say(text, dur, this.pitch); this.model.talk = Math.min(dur, 0.4 + text.length / 38); }
    playerLooking(maxDeg = 30) {
      const to = this.headPos.sub(S.camera.position).normalize();
      const fwd = new V3(0, 0, -1).applyQuaternion(S.camera.quaternion);
      return fwd.angleTo(to) < maxDeg * Math.PI / 180;
    }
    walk(dt) {
      let moved = 0;
      if (this.path.length) {
        const [tx, tz] = this.path[0];
        const dx = tx - this.pos.x, dz = tz - this.pos.z, d = Math.hypot(dx, dz), sp = this.running ? this.runSpeed : this.walkSpeed, step = sp * dt;
        if (d <= step) { this.pos.x = tx; this.pos.z = tz; this.path.shift(); moved = d; }
        else { this.pos.x += dx / d * step; this.pos.z += dz / d * step; moved = step; }
        if (d > 0.01) this.turnTo(Math.atan2(dx, dz), dt, this.running ? 10 : 7);
      }
      const gy = S.cw.groundY(this.pos.x, this.pos.z, this.pos.y + 0.2, 0.45);
      if (gy > -Infinity) this.pos.y = S.lerp(this.pos.y, gy, S.damp(20, dt));
      this.moveSpeed = dt > 0 ? moved / dt : 0;
    }
    turnTo(yaw, dt, k) {
      let d = yaw - this.group.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      this.group.rotation.y += d * S.damp(k, dt);
    }
    tick(dt) {
      if (this.facePoint && S.now < this.faceUntil && (!this.path.length || this.moveSpeed < 0.1))
        this.turnTo(Math.atan2(this.facePoint.x - this.pos.x, this.facePoint.z - this.pos.z), dt, 7);
      this.model.animate(this.moveSpeed, dt);
      this.bubble.update(this.headPos.add(new V3(0, 0.3, 0)), this.icon, this.group.visible);
    }
    hitBy(item, speed) {
      this.hits = S.now - this.lastHit < 8 ? this.hits + 1 : 1; this.lastHit = S.now;
      this.model.flinch = 1; S.audio.play('thud', 0.6, 0.8, this.chest);
      this.say(this.hits > 1 ? 'Knock it off!' : 'Ow!', 1.5); this.face(S.player.head, 2);
    }
    remove() { S.scene.remove(this.group); this.bubble.remove(); }
  }

  // ---------------------------------------------------------------- customers
  S.makeProfile = (rng, name, homeIndex) => {
    const effects = Object.keys(P.effects).filter((e) => e !== 'paranoid'), fav = [];
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) fav.push(effects.splice(Math.floor(rng() * effects.length), 1)[0]);
    return {
      id: Math.floor(rng() * 1e9).toString(36), name, seed: Math.floor(rng() * 1e9), pitch: 0.8 + rng() * 0.6, home: homeIndex,
      fam: rng() < 0.7 ? 'green' : 'crystal', favs: fav, standards: Math.floor(rng() * 3), wealth: 0.8 + rng() * 0.7,
      addiction: rng() * 0.2, rel: 0, contact: false, lastBuy: -99999, sampleCd: -99999, nextDeal: 60 + Math.floor(rng() * 180), deals: 0, bought: 0,
    };
  };
  const craveInterval = (c) => S.lerp(26 * 60, 5 * 60, S.clamp01(c.addiction));
  S.isCraving = (c, now) => now - c.lastBuy >= craveInterval(c);
  S.maxUnitPrice = (c, p, pos) => {
    let mult = c.wealth * (1 + 0.3 * c.rel) * (1 + 0.35 * c.addiction);
    if (P.family(p) !== c.fam) mult *= 0.85;
    for (const e of p.effects || []) if (c.favs.includes(e)) mult *= 1.12;
    mult *= S.game.turfPriceAt(pos);
    return Math.max(1, Math.round(P.value(p) * mult * 1.1));
  };
  const rel = (c, d) => { c.rel = S.clamp(c.rel + d, -1, 1); };
  S.adjustRel = rel;

  class Customer extends NPC {
    constructor(profile) {
      const rng = S.rng(profile.seed);
      super(profile.name, S.randomLook(rng), profile.pitch);
      this.p = profile; this.state = 'idle'; this.timer = S.rand(4, 15); this.greetCd = 0; this.trading = false;
      this.cash = null; this.cashAt = 0; this.hoverItem = null; this.fleeUntil = 0; this.think = Math.random() * 0.25;
      this.walkSpeed = 1.1 + rng() * 0.35;
    }
    get home() { const h = S.refs.pois.filter((p) => p.type === 'home'); return h[this.p.home % h.length]; }
    get shouldBeHome() {
      if (S.deals.active(this.p.id)) return false;
      const h = S.game.state.minute / 60; return h >= 22.5 || h < 7;
    }
    update(dt) {
      this.think -= dt;
      if (this.think <= 0) { this.think = 0.25; this.brain(); }
      this.walk(dt);
      this.greetCd -= dt;
      const dist = this.distToPlayer;
      this.model.look = dist < 4 ? S.player.head.clone() : null;
      if (this.cash && (S.now - this.cashAt > 15 || dist > 7)) this.collectCash();
      const deal = S.deals.active(this.p.id);
      this.icon = this.cash ? '$' : deal ? '!' : this.p.contact && dist < 12 && S.isCraving(this.p, S.game.absMin) ? 'want' : '';
      this.tick(dt);
    }
    brain() {
      if (this.trading) return;
      if (this.state === 'flee') { if (S.now > this.fleeUntil) { this.state = 'wander'; this.wander(); } return; }
      const deal = S.deals.active(this.p.id);
      if (deal) {
        const spot = S.deals.spot(deal.spot);
        const d = S.dist2(this.pos.x, this.pos.z, spot.x, spot.z);
        if (d > 1.5) { if (this.state !== 'toMeet' || this.arrived) this.moveTo(spot.x, spot.z, d > 25); this.state = 'toMeet'; }
        else { this.stop(); this.state = 'wait'; this.face(this.distToPlayer < 5 ? S.player.head : new V3(spot.x, 0, spot.z - 1), 1); }
        this.greet(deal); return;
      }
      if (this.shouldBeHome) {
        const home = this.home;
        if (this.state !== 'goingHome') { this.state = 'goingHome'; this.moveTo(home.x, home.z); }
        else if (this.arrived) { this.state = 'home'; this.group.visible = false; }
        return;
      }
      if (this.distToPlayer < 2.4 && this.playerLooking(35)) {
        if (this.state === 'wander') this.stop();
        this.state = 'idle'; this.timer = Math.max(this.timer, 3); this.face(S.player.head, 1); this.greet(null); return;
      }
      this.timer -= 0.25;
      if (this.state === 'wander' && this.arrived) { this.state = 'idle'; this.timer = S.rand(6, 20); }
      else if (this.state === 'idle' && this.timer <= 0) this.wander();
      else if (this.state !== 'wander' && this.state !== 'idle') this.wander();
    }
    wander() {
      const spots = S.refs.pois.filter((p) => p.type === 'hangout'), s = S.pick(spots);
      this.state = 'wander';
      const a = Math.random() * Math.PI * 2, r = Math.random() * s.radius;
      this.moveTo(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r);
    }
    wakeUp() { const h = this.home; this.pos.set(h.x, h.y, h.z); this.group.visible = true; this.state = 'idle'; this.timer = S.rand(1, 5); }
    greet(deal) {
      if (this.greetCd > 0 || this.distToPlayer > 3) return;
      this.greetCd = 25;
      if (deal) this.say(`You got my ${deal.units}x ${deal.fam}?`);
      else if (!this.p.contact) this.say(S.pick(['Can I help you?', '...Hey.', 'Nice day, huh?', 'You need something?']));
      else if (S.isCraving(this.p, S.game.absMin)) this.say(S.pick(['Yo! You holding?', 'Hey, got anything for me?', 'Perfect timing, I need some.']));
      else { this.say(S.pick(['Hey!', "What's up?", 'Good to see you.', 'Still good from last time.'])); this.model.wave = 1.4; }
    }
    hitBy(item, speed) {
      rel(this.p, -0.05);
      super.hitBy(item, speed);
      if (this.hits >= 3) {
        this.say("I'm outta here!", 2); this.state = 'flee'; this.fleeUntil = S.now + 6;
        const away = this.pos.clone().sub(S.player.pos).setY(0).normalize().multiplyScalar(12);
        this.moveTo(this.pos.x + away.x, this.pos.z + away.z, true);
      }
    }
    // ---- trading
    preview(item) {
      const p = item.product;
      if (!this.p.contact) return 'For me? ...A free sample?';
      const deal = S.deals.active(this.p.id);
      if (deal) {
        if (P.family(p) !== deal.fam) return "That's not what I ordered.";
        if (P.tier(p.quality) < deal.minTier) return 'I asked for better than that.';
        return `That's it! $${deal.unitPrice * p.units}, like we said.`;
      }
      if (!S.isCraving(this.p, S.game.absMin)) return "I'm good for now. Text me later.";
      if (P.tier(p.quality) < this.p.standards) return `${P.TIERS[P.tier(p.quality)]}? Nah.`;
      const ask = P.ask(p), max = S.maxUnitPrice(this.p, p, this.pos);
      if (ask > max) return `$${ask * p.units}? Too rich. I'd do $${max * p.units}.`;
      return `$${ask * p.units}? Deal.`;
    }
    receive(item) {
      if (this.trading || this.state === 'flee' || !item.packaged) return false;
      const p = item.product, now = S.game.absMin;
      this.face(S.player.head, 3);
      if (!this.p.contact) return this.sample(item);
      const deal = S.deals.active(this.p.id);
      if (deal) {
        if (P.family(p) !== deal.fam) { this.say("That's not what I ordered."); return false; }
        if (P.tier(p.quality) < deal.minTier) { this.say('I asked for better than that.'); return false; }
        deal.delivered += p.units;
        this.accept(item, deal.unitPrice * p.units, deal.minTier);
        if (deal.delivered >= deal.units) { S.deals.complete(deal); S.deals.message(this.p.name, 'pleasure doing business', deal.id); }
        else this.say(`Need ${deal.units - deal.delivered} more.`);
        return true;
      }
      if (!S.isCraving(this.p, now)) { this.say("I'm good for now. Text me later."); return false; }
      if (P.tier(p.quality) < this.p.standards) { this.say(`Ew, ${P.TIERS[P.tier(p.quality)]}? No way.`); rel(this.p, -0.02); return false; }
      const maxUnits = 1 + Math.round(this.p.wealth * 2 + this.p.addiction * 2);
      if (p.units > maxUnits) { this.say(`That's too much. Max ${maxUnits} for me.`); return false; }
      const ask = P.ask(p), max = S.maxUnitPrice(this.p, p, this.pos);
      if (ask > max) { this.say(`$${ask * p.units}?! I'd do $${max * p.units}, tops.`); rel(this.p, -0.01); return false; }
      this.accept(item, ask * p.units, this.p.standards);
      return true;
    }
    sample(item) {
      const now = S.game.absMin;
      if (now < this.p.sampleCd) { this.say('You again? Give it a rest.'); return false; }
      const p = item.product;
      let score = p.quality + (P.family(p) === this.p.fam ? 0.1 : -0.1) + S.rand(-0.12, 0.12);
      for (const e of p.effects || []) if (this.p.favs.includes(e)) score += 0.15;
      this.pocket(item);
      if (score >= 0.32 + 0.1 * this.p.standards) {
        Object.assign(this.p, { contact: true, rel: Math.max(this.p.rel, 0.1), addiction: Math.min(1, this.p.addiction + 0.1), lastBuy: now, nextDeal: now + S.rand(90, 240) });
        this.say("Oh, that's good. Here's my number.", 3); this.model.wave = 1.4;
        S.deals.message(this.p.name, "hit me up whenever. i'm usually around.", 0);
        S.ui.toast('New customer!', `${this.p.name} is now a contact.`, 'good');
        S.game.addXp(25); S.audio.play('success', 0.5, 1, this.chest);
      } else { this.p.sampleCd = now + 1440; this.say("Hmm... nah, that's not it.", 3); }
      S.police.report(this.pos, 0.5);
      return true;
    }
    accept(item, pay, expectedTier) {
      const p = item.product, tierDiff = P.tier(p.quality) - expectedTier;
      let sat = 0.04 + tierDiff * 0.03;
      for (const e of p.effects || []) if (this.p.favs.includes(e)) sat += 0.03;
      rel(this.p, sat);
      const st = P.strains[p.strain];
      this.p.addiction = Math.min(1, this.p.addiction + (st ? st.addict : 0.2) * 0.08 * p.units);
      this.p.lastBuy = S.game.absMin; this.p.bought += p.units; S.game.state.unitsSold += p.units;
      this.say(tierDiff >= 2 ? 'Whoa. This is the good stuff.' : tierDiff >= 1 ? 'Nice, thanks!' : tierDiff === 0 ? 'Cool. Here.' : "Guess this'll do...", 2.5);
      this.pocket(item);
      setTimeout(() => this.pay(pay), 450);
      S.game.recordSale(this.pos, pay);
      S.police.report(this.pos, 0.75);
      S.game.addXp(Math.max(3, Math.floor(pay / 3)));
      S.game.event('sold');
    }
    pocket(item) {
      this.trading = true;
      item.state = 'npc'; S.scene.remove(item.group);
      this.model.lHand.add(item.group); item.group.position.set(0, 0, 0); item.group.rotation.set(0, 0, 0);
      setTimeout(() => { item.destroy(); this.trading = false; }, 1000);
    }
    pay(amount) {
      if (this.cash) this.collectCash();
      this.model.offerTarget = 1;
      const stacks = amount >= 200 ? 3 : amount >= 60 ? 2 : 1;
      const m = S.meshFrom('cash_' + stacks, S.models.cash(stacks));
      m.rotation.y = Math.PI / 2; m.position.set(0, -0.01, 0.03);
      this.model.rHand.add(m);
      this.cash = { mesh: m, amount }; this.cashAt = S.now;
      S.audio.play('rustle', 0.4, 1, this.chest);
    }
    cashWorldPos() { const v = new V3(); if (this.cash) this.cash.mesh.getWorldPosition(v); return v; }
    collectCash() {
      if (!this.cash) return;
      const pos = this.cashWorldPos();
      this.model.rHand.remove(this.cash.mesh);
      S.game.addCash(this.cash.amount, pos);
      this.cash = null; this.model.offerTarget = 0;
    }
  }
  S.Customer = Customer;

  // ---------------------------------------------------------------- police
  class Cop extends NPC {
    constructor(seed, patrolStart) {
      const rng = S.rng(seed);
      super('Officer ' + NAMES[Math.floor(rng() * NAMES.length)], S.randomLook(rng, true), 0.75 + rng() * 0.2);
      this.walkSpeed = 1.2; this.runSpeed = 4.3; this.suspicion = 0; this.state = 'patrol'; this.patrol = patrolStart; this.timer = 0;
      this.lastKnown = new V3(); this.lastSeen = -100; this.sees = false; this.shoutCd = 0; this.whistleCd = 0; this.think = Math.random() * 0.2;
      this.vel = new V3();
    }
    get chasing() { return this.state === 'chase'; }
    get playerSafe() { return S.game.mode !== 'playing' || S.game.inSafeZone(S.player.head); }
    update(dt) {
      this.shoutCd -= dt; this.whistleCd -= dt;
      this.perceive(dt);
      this.think -= dt;
      if (this.think <= 0) { this.think = 0.2; this.brain(); }
      if (this.state === 'chase' && this.sees) this.chaseMove(dt);
      else this.walk(dt);
      this.model.look = this.sees && this.distToPlayer < 12 ? S.player.head.clone() : null;
      this.icon = this.suspicion > 0.99 || this.chasing ? '!' : this.suspicion > 0.15 ? '?' : '';
      this.tick(dt);
    }
    chaseMove(dt) {
      // straight at the player with wall sliding (they can't climb, you can)
      const to = S.player.pos.clone().sub(this.pos); to.y = 0;
      const d = to.length();
      if (d > 0.05) to.multiplyScalar(this.runSpeed / d);
      this.vel.x = to.x; this.vel.z = to.z; this.vel.y -= 20 * dt;
      const before = this.pos.clone();
      S.moveBody(S.cw, this.pos, this.vel, dt, 0.26, 1.6, 0.45);
      const moved = this.pos.clone().sub(before).setY(0).length();
      this.moveSpeed = moved / dt;
      if (d > 0.1) this.turnTo(Math.atan2(to.x, to.z), dt, 10);
      if (moved < this.runSpeed * dt * 0.3) { this.stuck = (this.stuck || 0) + dt; if (this.stuck > 0.6) { this.stuck = 0; this.moveTo(S.player.pos.x, S.player.pos.z, true); this.state = 'chasePath'; this.pathTimer = 1.5; } }
      else this.stuck = 0;
    }
    perceive(dt) {
      this.sees = false;
      if (this.playerSafe) { this.suspicion = Math.max(0, this.suspicion - dt * 0.3); return; }
      const eye = this.pos.clone(); eye.y += this.model.height - 0.1;
      const to = S.player.head.clone().sub(eye), dist = to.length();
      if (dist < 16) {
        const fwd = new V3(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
        const flat = to.clone().setY(0).normalize();
        if (fwd.angleTo(flat) < 70 * Math.PI / 180 || dist < 3) {
          const hit = S.cw.raycast(eye, to.clone().normalize(), dist);
          if (!hit) this.sees = true;
        }
      }
      if (this.sees) {
        this.lastKnown.copy(S.player.pos); this.lastSeen = S.now;
        if (S.player.holdingProduct()) this.suspicion = Math.min(1, this.suspicion + 0.55 * (1 - S.clamp01(dist / 16) * 0.7) * (S.game.isNight ? 1.3 : 1) * dt);
        else if (S.game.isCurfew && dist < 8) this.suspicion = Math.min(1, this.suspicion + 0.08 * dt);
      }
      if (this.state !== 'chase' && this.state !== 'chasePath') this.suspicion = Math.max(0, this.suspicion - dt * (this.sees ? 0.02 : 0.08));
    }
    witness(pos, severity) {
      const eye = this.pos.clone(); eye.y += this.model.height - 0.1;
      const target = pos.clone(); target.y += 1.2;
      const to = target.clone().sub(eye), dist = to.length();
      if (dist > 16 || S.cw.raycast(eye, to.clone().normalize(), dist)) return;
      const fwd = new V3(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
      if (fwd.angleTo(to.clone().setY(0).normalize()) > 70 * Math.PI / 180 && dist > 4) return;
      if (this.playerSafe) return;
      this.suspicion = Math.min(1, this.suspicion + severity * (1 - dist / 16 * 0.5));
      this.lastKnown.copy(S.player.pos);
      if (this.state === 'patrol' || this.state === 'pause') this.say("Hey! What's going on there?", 2);
    }
    brain() {
      if (S.game.mode !== 'playing') { if (this.chasing) this.endChase(); return; }
      if (this.state !== 'chase' && this.state !== 'chasePath' && this.suspicion >= 1 && !this.playerSafe) { this.startChase(); return; }
      switch (this.state) {
        case 'patrol':
          if (this.suspicion > 0.35 && this.sees) {
            this.state = 'suspicious'; this.timer = 4;
            if (this.shoutCd <= 0) { this.say(S.player.holdingProduct() ? "Hey you. What's that in your hand?" : 'Hold on a sec...', 2.5); this.shoutCd = 8; }
          } else if (this.arrived) { this.state = 'pause'; this.timer = S.rand(2, 5); }
          break;
        case 'pause': this.timer -= 0.2; if (this.timer <= 0) this.nextPatrol(); break;
        case 'suspicious':
          this.timer -= 0.2; this.face(this.lastKnown, 1);
          if (this.sees && this.distToPlayer > 3) this.moveTo(this.lastKnown.x, this.lastKnown.z); else this.stop();
          if (this.suspicion < 0.2 || (this.timer <= 0 && this.suspicion < 0.5)) { if (this.shoutCd <= 0) this.say('...Carry on.', 1.5); this.nextPatrol(); }
          break;
        case 'chase':
        case 'chasePath':
          this.updateChase(); break;
        case 'search':
          this.timer -= 0.2;
          if (this.sees && this.suspicion > 0.6) { this.startChase(); break; }
          if (this.arrived) this.moveTo(this.lastKnown.x + S.rand(-4, 4), this.lastKnown.z + S.rand(-4, 4));
          if (this.timer <= 0) { this.say("Lost 'em.", 1.5); this.suspicion = 0.3; this.nextPatrol(); }
          break;
      }
    }
    startChase() {
      this.state = 'chase'; this.suspicion = 1; this.say('STOP RIGHT THERE!', 2);
      if (this.whistleCd <= 0) { S.audio.play('whistle', 0.9, 1, this.headPos); this.whistleCd = 6; }
      S.ui.toast('COPS!', "You've been spotted. Lose them or get home!", 'bad');
      for (const c of S.police.cops) if (c !== this && c.group.visible && c.pos.distanceTo(this.pos) < 30) c.joinChase();
    }
    joinChase() { if (this.chasing) return; this.suspicion = 1; this.state = 'chase'; this.lastKnown.copy(S.player.pos); this.say('On my way!', 1.5); }
    updateChase() {
      if (this.playerSafe) { this.say("Where'd they go?!", 2); this.endChase(); return; }
      if (this.sees) {
        if (this.state === 'chasePath') { this.pathTimer -= 0.2; if (this.pathTimer <= 0) this.state = 'chase'; else this.moveTo(S.player.pos.x, S.player.pos.z, true); }
        const heightDiff = S.player.pos.y - this.pos.y;
        if (this.distToPlayer < 1.3 && heightDiff < 1.4) { this.stop(); S.game.bust(this); this.endChase(); return; }
        if (this.distToPlayer < 3 && heightDiff >= 1.4 && this.shoutCd <= 0) { this.say('Get down from there!', 2); this.shoutCd = 5; }
      } else {
        this.state = 'chasePath';
        if (this.arrived) this.moveTo(this.lastKnown.x, this.lastKnown.z, true);
        if (S.now - this.lastSeen > 6) { this.state = 'search'; this.timer = 8; this.say("Where'd they go...", 2); }
      }
    }
    endChase() { this.suspicion = 0; this.nextPatrol(); }
    nextPatrol() {
      const pts = S.police.patrolPoints;
      this.state = 'patrol';
      this.patrol = (this.patrol + 1) % pts.length;
      const p = pts[this.patrol];
      this.moveTo(p[0] + S.rand(-1, 1), p[1] + S.rand(-1, 1));
    }
    hitBy(item, speed) { super.hitBy(item, speed); this.suspicion = Math.min(1, this.suspicion + (item.hasProduct ? 1 : 0.5)); }
  }

  S.police = {
    cops: [],
    patrolPoints: [[-40, 20.5], [-12, 20.5], [8.5, 20.5], [22, 12], [40, 10], [56, 20.5], [42, 30.5], [22, 38], [0, 30.5], [-30, 30.5]],
    report(pos, severity) { for (const c of this.cops) if (c.group.visible) c.witness(pos, severity); },
    reset() { for (const c of this.cops) { c.suspicion = 0; c.nextPatrol(); } },
    get anyChasing() { return this.cops.some((c) => c.group.visible && (c.state === 'chase' || c.state === 'chasePath')); },
  };

  // ---------------------------------------------------------------- NPC manager
  S.npcs = {
    customers: [],
    generate(state, count) {
      const rng = S.rng(state.seed), taken = new Set(), homes = S.refs.pois.filter((p) => p.type === 'home').length;
      for (let i = 0; i < count; i++) {
        let name; do { name = NAMES[Math.floor(rng() * NAMES.length)]; } while (taken.has(name) && taken.size < NAMES.length);
        taken.add(name);
        const p = S.makeProfile(rng, name, i % homes);
        if (i < 2) Object.assign(p, { contact: true, rel: 0.15, addiction: 0.25, fam: 'green', standards: 0, lastBuy: -99999, nextDeal: (state.day - 1) * 1440 + state.minute + 300 + Math.floor(rng() * 120) });
        state.customers.push(p);
      }
    },
    spawnAll() {
      this.despawnAll();
      const st = S.game.state, hangouts = S.refs.pois.filter((p) => p.type === 'hangout');
      for (const prof of st.customers) {
        const c = new Customer(prof);
        const h = S.pick(hangouts);
        c.pos.set(h.x + S.rand(-1, 1), h.y, h.z + S.rand(-1, 1));
        this.customers.push(c);
      }
      const station = S.refs.pois.find((p) => p.type === 'police');
      for (let i = 0; i < 3; i++) {
        const cop = new Cop(st.seed + 1000 + i, i * 3);
        cop.pos.set(station.x + S.rand(-1, 1), station.y, station.z + S.rand(-0.5, 0.5));
        cop.nextPatrol();
        S.police.cops.push(cop);
      }
      this.schedule(true);
    },
    despawnAll() {
      for (const c of this.customers) c.remove();
      for (const c of S.police.cops) c.remove();
      this.customers = []; S.police.cops = [];
    },
    find(id) { return this.customers.find((c) => c.p.id === id); },
    profile(id) { return S.game.state ? S.game.state.customers.find((c) => c.id === id) : null; },
    locationOf(id) {
      const c = this.find(id);
      if (!c || !c.group.visible) return 'at home';
      let best = null, bd = Infinity;
      for (const p of S.refs.pois) { if (p.type === 'police') continue; const d = S.dist2(p.x, p.z, c.pos.x, c.pos.z); if (d < bd) { bd = d; best = p; } }
      return best ? 'near ' + best.name : 'out and about';
    },
    schedule(instant) {
      for (const c of this.customers) {
        const home = c.shouldBeHome;
        if (c.group.visible && home && instant) { c.group.visible = false; c.state = 'home'; }
        else if (!c.group.visible && !home) c.wakeUp();
      }
      const night = S.game.isNight;
      S.police.cops.forEach((cop, i) => {
        const active = i < (night ? 3 : 2) || cop.chasing;
        if (cop.group.visible !== active) { cop.group.visible = active; if (active) cop.nextPatrol(); }
      });
    },
    update(dt) {
      this.scheduleTimer = (this.scheduleTimer || 0) - dt;
      if (this.scheduleTimer <= 0) { this.scheduleTimer = 2; this.schedule(false); }
      for (const c of this.customers) if (c.group.visible) c.update(dt); else c.bubble.update(null, '', false);
      for (const c of S.police.cops) if (c.group.visible) c.update(dt); else c.bubble.update(null, '', false);
    },
    all() { return [...this.customers, ...S.police.cops].filter((n) => n.group.visible); },
  };

  // ---------------------------------------------------------------- deals & messages (port of DealSystem)
  S.deals = {
    beacons: new Map(),
    get list() { return S.game.state.deals; },
    spots() { return S.refs.pois.filter((p) => p.type === 'meet'); },
    spot(i) { const s = this.spots(); return s[Math.abs(i) % s.length]; },
    active(cid) { return S.game.state ? this.list.find((d) => d.cid === cid && d.state === 'accepted') : null; },
    open() { return S.game.state ? this.list.filter((d) => d.state === 'offered' || d.state === 'accepted') : []; },
    find(id) { return this.list.find((d) => d.id === id); },
    message(from, text, dealId) {
      const st = S.game.state; if (!st) return;
      st.messages.push({ from, text, day: st.day, minute: st.minute, deal: dealId });
      while (st.messages.length > 40) st.messages.shift();
      S.ui.phoneDirty();
    },
    tick() {
      const st = S.game.state, now = S.game.absMin;
      let changed = false;
      for (const d of this.list) {
        if (d.state === 'offered' && now > d.respondBy) { d.state = 'expired'; const c = S.npcs.profile(d.cid); if (c) this.message(c.name, 'nvm, found someone else', d.id); changed = true; }
        else if (d.state === 'accepted' && now > d.meetEnd) { this.fail(d); changed = true; }
      }
      this.checkTimer = (this.checkTimer || 0) - 1;
      if (this.checkTimer <= 0) { this.checkTimer = 15; changed = this.generate(now) || changed; }
      while (this.list.length > 25) { const i = this.list.findIndex((d) => d.state !== 'offered' && d.state !== 'accepted'); if (i < 0) break; this.list.splice(i, 1); }
      if (changed) { this.syncBeacons(); S.ui.phoneDirty(); }
    },
    generate(now) {
      let open = this.open().length; if (open >= 3) return false;
      const h = S.game.state.minute / 60, dayF = h >= 8 && h < 21 ? 1 : h >= 21 && h < 23.5 ? 0.35 : 0;
      if (dayF <= 0) return false;
      let made = false;
      for (const c of S.game.state.customers) {
        if (!c.contact || now < c.nextDeal || this.list.some((d) => d.cid === c.id && (d.state === 'offered' || d.state === 'accepted'))) continue;
        c.nextDeal = now + S.rand(60, 150);
        if (!S.isCraving(c, now)) continue;
        if (Math.random() > (0.25 + 0.6 * c.addiction) * dayF * (0.7 + 0.3 * (c.rel + 1) / 2)) continue;
        this.offer(c, now); made = true;
        if (++open >= 3) break;
      }
      return made;
    },
    offer(c, now) {
      const st = S.game.state;
      const fam = c.fam === 'crystal' && !st.unlocks.includes('chem') ? 'green' : c.fam;
      const units = 1 + S.clamp(Math.floor((c.wealth - 0.7) * 3 * Math.random() + c.addiction * 2), 0, 3);
      const tier = S.clamp(c.standards, 0, 3), cheap = P.cheapest(fam);
      const sample = { strain: cheap.id, quality: S.clamp01(tier * 0.2 + 0.1), effects: [] };
      const typical = cheap.base * P.qualityMult(S.clamp01(Math.max(2, tier) * 0.2 + 0.1)) * S.game.markup(fam) * S.rand(0.95, 1.12);
      const unitPrice = Math.max(1, Math.round(Math.min(typical, S.maxUnitPrice(c, sample, new V3()) * 1.05)));
      const spots = this.spots();
      const d = { id: st.nextDeal++, cid: c.id, fam, units, minTier: tier, unitPrice, spot: Math.floor(Math.random() * spots.length), state: 'offered', respondBy: now + 90, meetEnd: 0, delivered: 0 };
      st.deals.push(d);
      const spot = this.spot(d.spot);
      const text = `${S.pick(['yo', 'hey', 'u around?', 'sup', 'psst'])} can u bring ${units}x ${fam}${tier >= 2 ? ` (${P.TIERS[tier]}+)` : ''}? I'll pay $${units * unitPrice}. meet @ ${spot.name}`;
      this.message(c.name, text, d.id);
      S.ui.toast('Message from ' + c.name, text, 'good', 5);
      return d;
    },
    accept(id) {
      const d = this.find(id); if (!d || d.state !== 'offered') return;
      d.state = 'accepted'; d.meetEnd = S.game.absMin + 180;
      const spot = this.spot(d.spot), c = S.npcs.profile(d.cid);
      this.message('You', `bet. ${spot.name} in a bit`, d.id);
      S.ui.toast('Deal accepted', `Meet ${c.name} at ${spot.name} before ${S.fmtTime(d.meetEnd % 1440)}. Follow the yellow beacon.`, 'good', 5);
      S.game.event('dealAccepted');
      this.syncBeacons(); S.ui.phoneDirty();
    },
    decline(id) {
      const d = this.find(id); if (!d || d.state !== 'offered') return;
      d.state = 'declined'; const c = S.npcs.profile(d.cid); if (c) rel(c, -0.02);
      this.message('You', "can't rn, sorry", d.id); S.ui.phoneDirty();
    },
    complete(d) {
      d.state = 'completed';
      const c = S.npcs.profile(d.cid);
      if (c) {
        c.deals++; rel(c, 0.08);
        if (c.rel >= 0.45 && Math.random() < 0.3) {
          const other = S.game.state.customers.find((o) => !o.contact);
          if (other) {
            Object.assign(other, { contact: true, rel: 0.05, nextDeal: S.game.absMin + S.rand(30, 120) });
            this.message(c.name, `my buddy ${other.name} wants in. gave them ur number`, 0);
            this.message(other.name, `${c.name} says ur legit. hit me up`, 0);
            S.ui.toast('New customer!', `${c.name} referred ${other.name}.`, 'good');
          }
        }
      }
      S.game.addXp(10); this.syncBeacons(); S.ui.phoneDirty();
    },
    fail(d) {
      d.state = 'failed';
      const c = S.npcs.profile(d.cid);
      if (c) { rel(c, -0.15); this.message(c.name, 'waited forever. not cool.', d.id); S.ui.toast('Deal missed', `${c.name} is annoyed you didn't show.`, 'bad'); }
    },
    syncBeacons() {
      const keep = new Set();
      if (S.game.state) for (const d of this.list) {
        if (d.state !== 'accepted') continue;
        keep.add(d.id);
        if (this.beacons.has(d.id)) continue;
        const spot = this.spot(d.spot), c = S.npcs.profile(d.cid);
        const mb = new S.MeshBuilder(); mb.raw = true;
        mb.frustum([0, 0, 0], 0.35, 0.12, 40, 8, [1, 0.78, 0.3, 0.22], false, false);
        mb.frustum([0, 0.02, 0], 0.8, 0.8, 0.03, 16, [1, 0.78, 0.3, 0.35], true, false);
        const m = mb.mesh(S.mat.glass); m.position.set(spot.x, spot.y, spot.z); m.renderOrder = 3; S.scene.add(m);
        this.beacons.set(d.id, { mesh: m, label: S.ui.worldLabel(`${c ? c.name : 'Deal'}<br>${d.units}x ${d.fam} - $${d.units * d.unitPrice}`, 'beacon'), pos: new V3(spot.x, spot.y, spot.z) });
      }
      for (const [id, b] of this.beacons) if (!keep.has(id)) { S.scene.remove(b.mesh); b.label.remove(); this.beacons.delete(id); }
    },
    updateBeacons() {
      for (const b of this.beacons.values()) {
        const dist = S.camera.position.distanceTo(b.pos);
        b.mesh.visible = dist > 3;
        const p = b.pos.clone(); p.y += S.lerp(2.2, 6, S.invLerp(5, 60, dist));
        b.label.place(p, dist > 1.5);
      }
    },
    clear() { for (const b of this.beacons.values()) { S.scene.remove(b.mesh); b.label.remove(); } this.beacons.clear(); },
  };
})();

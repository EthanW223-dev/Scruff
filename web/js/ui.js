/* Scruff web preview - HUD, toasts, speech bubbles, phone, shop and station panels (HTML overlays). */
'use strict';
(() => {
  const P = S.catalog;
  const $ = (id) => document.getElementById(id);
  const V3 = THREE.Vector3;
  const RANKS = ['Street Rat', 'Corner Kid', 'Hustler', 'Dealer', 'Supplier', 'Plug', 'Kingpin'];
  const RANK_XP = [0, 120, 400, 900, 1800, 3200, 5500];
  S.RANKS = RANKS; S.RANK_XP = RANK_XP;
  S.rankFor = (xp) => { let r = 0; RANK_XP.forEach((v, i) => { if (xp >= v) r = i; }); return r; };

  const labels = () => $('labels');
  const project = (pos) => {
    const v = pos.clone().project(S.camera);
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
    const r = S.renderer.domElement.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height };
  };

  const ui = (S.ui = {
    // ---------------------------------------------------------------- speech bubbles above NPCs
    bubble() {
      const el = document.createElement('div'); el.className = 'bubble';
      const text = document.createElement('div'); text.className = 'say'; el.appendChild(text);
      const icon = document.createElement('div'); icon.className = 'icon'; el.appendChild(icon);
      labels().appendChild(el);
      let full = '', shown = 0, until = 0, charT = 0, pitch = 1;
      return {
        say(t, dur, p) { full = t; shown = 0; until = S.now + dur + t.length / 38; pitch = p; text.textContent = ''; },
        update(pos, iconKind, visible) {
          const talking = S.now < until;
          if (talking && shown < full.length) {
            charT -= S.dt;
            while (charT <= 0 && shown < full.length) {
              shown++; charT += 1 / 38;
              if (shown % 3 === 0 && full[shown - 1] !== ' ' && pos && S.camera.position.distanceTo(pos) < 14) S.audio.play('blip', 0.28, pitch * S.rand(0.88, 1.15), pos);
            }
            text.textContent = full.slice(0, shown);
          }
          const sp = visible && pos && S.camera.position.distanceTo(pos) < 22 ? project(pos) : null;
          if (!sp) { el.style.display = 'none'; return; }
          el.style.display = '';
          el.style.transform = `translate(${sp.x}px, ${sp.y}px)`;
          text.hidden = !talking;
          const ic = iconKind === 'want' ? '$' : iconKind;
          icon.hidden = talking || !ic;
          icon.textContent = ic || '';
          icon.className = 'icon ' + (iconKind === '!' ? 'danger' : iconKind === '?' ? 'warn' : iconKind === 'want' ? 'soft' : 'money');
        },
        remove() { el.remove(); },
      };
    },
    worldLabel(html, cls) {
      const el = document.createElement('div'); el.className = 'wlabel ' + (cls || ''); el.innerHTML = html; labels().appendChild(el);
      return {
        place(pos, visible) { const sp = visible ? project(pos) : null; if (!sp) { el.style.display = 'none'; return; } el.style.display = ''; el.style.transform = `translate(${sp.x}px, ${sp.y}px)`; },
        set(h) { el.innerHTML = h; },
        remove() { el.remove(); },
      };
    },
    floatText(pos, text, cls = 'money') {
      const l = ui.worldLabel(text, 'float ' + cls);
      const start = S.now, p0 = pos.clone();
      const tick = () => {
        const t = (S.now - start) / 1.4;
        if (t >= 1) { l.remove(); return; }
        l.place(p0.clone().add(new V3(0, t * 0.35, 0)), true);
        requestAnimationFrame(tick);
      };
      tick();
    },

    // ---------------------------------------------------------------- toasts
    toast(title, body, kind = 'info', secs = 3.5) {
      const el = document.createElement('div'); el.className = 'toast ' + kind;
      el.innerHTML = `<b>${S.esc(title)}</b>${body ? `<span>${S.esc(body)}</span>` : ''}`;
      const host = $('toasts'); host.prepend(el);
      while (host.children.length > 3) host.lastChild.remove();
      S.audio.play('notify', 0.35);
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, secs * 1000);
    },

    // ---------------------------------------------------------------- HUD
    hud() {
      const g = S.game, st = g.state;
      if (!st) return;
      $('hudTime').textContent = `Day ${st.day} ${S.dayName(st.day)} - ${S.fmtTime(st.minute)}`;
      $('hudCash').textContent = S.money(st.cash);
      const r = S.rankFor(st.xp), next = RANK_XP[r + 1];
      $('hudRank').textContent = RANKS[r];
      $('hudXp').style.width = (next ? S.invLerp(RANK_XP[r], next, st.xp) * 100 : 100) + '%';
      const goal = S.tutorial.current();
      $('goal').hidden = !goal;
      if (goal) $('goalText').textContent = touchText(goal);
      const offers = S.deals.open().filter((d) => d.state === 'offered').length;
      $('phoneBadge').hidden = !offers; $('phoneBadge').textContent = offers;
      const heat = S.police.anyChasing;
      $('heat').hidden = !heat;
    },
    setLook(html, hint) {
      const look = $('look'), h = $('hint');
      if (hint && S.input.touch) hint = touchHint(hint);
      look.hidden = !html; if (html && look.innerHTML !== html) look.innerHTML = html;
      h.hidden = !hint; if (hint && h.innerHTML !== hint) h.innerHTML = hint;
    },

    // ---------------------------------------------------------------- fade
    fade(caption, mid) {
      return new Promise((res) => {
        const f = $('fade'); $('fadeText').textContent = caption || '';
        f.classList.add('on');
        setTimeout(() => {
          try { mid && mid(); } catch (e) { console.error(e); }
          setTimeout(() => { f.classList.remove('on'); setTimeout(res, 450); }, 700);
        }, 380);
      });
    },

    // ---------------------------------------------------------------- phone
    phoneOpen: false, app: 'home', page: 0, dirty: true, confirmQuit: false,
    togglePhone(force) {
      const open = force !== undefined ? force : !ui.phoneOpen;
      if (open && S.game.mode !== 'playing') return;
      if (open) ui.closePanel();
      ui.phoneOpen = open; $('phone').hidden = !open; $('phone').classList.toggle('open', open);
      ui.confirmQuit = false;
      S.audio.play(open ? 'pop' : 'drop', 0.35, 1.2);
      if (open) { S.input.releasePointer(); ui.renderPhone(); }
      else S.input.lockPointer();
    },
    phoneDirty() { ui.dirty = true; },
    renderPhone() {
      if (!ui.phoneOpen || !S.game.state) return;
      ui.dirty = false;
      const st = S.game.state;
      $('phoneClock').textContent = S.fmtTime(st.minute);
      $('phoneCash').textContent = S.money(st.cash);
      document.querySelectorAll('#phoneNav button').forEach((b) => b.classList.toggle('on', b.dataset.app === ui.app));
      const body = $('phoneBody');
      const html = ({ home: appHome, msgs: appMsgs, crew: appCrew, price: appPrice, menu: appMenu })[ui.app]();
      body.innerHTML = html;
    },

    // ---------------------------------------------------------------- panels (shop, mixer, chem)
    panel: null,
    openPanel(kind, arg) {
      if (ui.phoneOpen) ui.togglePhone(false);
      ui.panel = { kind, arg, page: 0 };
      $('panel').hidden = false;
      S.input.releasePointer();
      ui.renderPanel();
    },
    closePanel() {
      if (!ui.panel) return;
      ui.panel = null; $('panel').hidden = true;
      if (S.game.mode === 'playing') S.input.lockPointer();
    },
    renderPanel() {
      const p = ui.panel; if (!p) return;
      const box = $('panelBody');
      if (p.kind === 'shop') box.innerHTML = panelShop(p.arg);
      else if (p.kind === 'mixer') box.innerHTML = panelMixer();
      else if (p.kind === 'chem') box.innerHTML = panelChem();
      else if (p.kind === 'confirmNew') box.innerHTML = `<h2>Start over?</h2><p>Your current save will be erased.</p><div class="row"><button class="btn danger" data-act="newgame-yes">Yes, new game</button><button class="btn" data-act="close">Back</button></div>`;
      else if (p.kind === 'howto') box.innerHTML = HOWTO;
    },
  });

  // ---------------------------------------------------------------- phone apps (ports of PhoneUI.cs)
  function appHome() {
    const st = S.game.state, r = S.rankFor(st.xp), next = RANK_XP[r + 1];
    const open = S.deals.open(), offers = open.filter((d) => d.state === 'offered').length;
    const zone = S.game.zoneAt(S.player.pos);
    const goal = S.tutorial.current();
    return `
      <p class="dim">Day ${st.day} (${S.dayName(st.day)}) - ${S.fmtTime(st.minute)}</p>
      <p class="big money">${S.money(st.cash)}</p>
      <div class="kv"><b class="warn">${RANKS[r]}</b><span class="dim">${st.xp} XP</span></div>
      <div class="bar"><i style="width:${next ? S.invLerp(RANK_XP[r], next, st.xp) * 100 : 100}%"></i></div>
      ${next ? `<p class="dim small">${next - st.xp} XP to ${RANKS[r + 1]}</p>` : ''}
      <p>${st.rentDebt > 0 ? `<b class="bad">You owe $${st.rentDebt} rent!</b>` : `Rent $${S.game.RENT} due ${S.dayName(st.nextRent)} (day ${st.nextRent})`}</p>
      <p class="${offers ? 'good' : ''}">Deals: ${offers} new, ${open.length - offers} active</p>
      ${zone ? `<p>${zone.name}: ${Math.round(S.game.influence(zone.id) * 100)}% ${S.game.influence(zone.id) >= 0.5 ? '<b class="warn">(your turf)</b>' : ''}</p>` : ''}
      ${goal ? `<div class="card goal"><b class="warn small">GOAL</b><p>${S.esc(touchText(goal))}</p></div>` : ''}`;
  }
  function appMsgs() {
    const now = S.game.absMin;
    const deals = S.deals.open().sort((a, b) => (a.state === 'offered' ? 0 : 1) - (b.state === 'offered' ? 0 : 1));
    let h = '';
    for (const d of deals) {
      const c = S.npcs.profile(d.cid), spot = S.deals.spot(d.spot);
      h += `<div class="card ${d.state}">
        <div class="kv"><b>${S.esc(c ? c.name : '???')}</b><b class="money">$${d.units * d.unitPrice}</b></div>
        <p>${d.units}x ${d.fam === 'green' ? 'Green' : 'Crystal'}${d.minTier >= 2 ? ` ${P.TIERS[d.minTier]}+` : ''} <span class="dim">@ ${S.esc(spot.name)}</span></p>
        ${d.state === 'offered'
          ? `<p class="warn small">Reply within ${S.fmtDur(d.respondBy - now)}</p><div class="row"><button class="btn good" data-act="accept" data-id="${d.id}">Accept</button><button class="btn danger" data-act="decline" data-id="${d.id}">Decline</button></div>`
          : `<p class="warn small">Meet by ${S.fmtTime(d.meetEnd % 1440)} (${S.fmtDur(d.meetEnd - now)})${d.delivered ? ` - ${d.delivered}/${d.units} delivered` : ''}</p>`}
      </div>`;
    }
    if (!deals.length) h += '<p class="dim">No deal requests right now. Keep your customers happy and they\'ll text.</p>';
    h += '<h4>Recent</h4>';
    const msgs = S.game.state.messages.slice(-14).reverse();
    h += msgs.map((m) => `<p class="msg"><b class="${m.from === 'You' ? 'you' : 'them'}">${S.esc(m.from)}:</b> ${S.esc(m.text)}</p>`).join('');
    return h;
  }
  function appCrew() {
    const known = S.game.state.customers.filter((c) => c.contact).sort((a, b) => b.rel - a.rel);
    if (!known.length) return '<p class="dim">No customers yet. Hand a stranger a bagged sample to win them over.</p>';
    const now = S.game.absMin;
    return known.map((c) => {
      const stars = Math.round((c.rel + 1) / 2 * 5);
      const likes = [c.fam === 'green' ? 'Green' : 'Crystal', ...c.favs.map((e) => `<b style="color:${S.css(P.effects[e].color)}">${P.effects[e].name}</b>`)].join(', ');
      return `<div class="card">
        <div class="kv"><b>${S.esc(c.name)}${S.isCraving(c, now) ? ' <span class="good small">wants some</span>' : ''}</b><span class="hearts">${'&#9829;'.repeat(stars)}<span class="dim">${'&#9829;'.repeat(5 - stars)}</span></span></div>
        <p class="small">Likes ${likes}</p>
        <p class="small dim">${P.TIERS[c.standards]}+ only - hooked ${Math.round(c.addiction * 100)}% - ${S.esc(S.npcs.locationOf(c.id))}</p>
      </div>`;
    }).join('');
  }
  function appPrice() {
    let h = '<p class="dim small">Asking price = street value x markup. Push it too far and people walk.</p>';
    for (const fam of ['green', 'crystal']) {
      if (fam === 'crystal' && !S.game.state.unlocks.includes('chem')) continue;
      const m = S.game.markup(fam), s = P.cheapest(fam), sample = { strain: s.id, quality: 0.5, effects: [] };
      h += `<div class="card">
        <div class="kv"><b class="good">${fam === 'green' ? 'GREEN' : 'CRYSTAL'}</b><b class="${m > 1.3 ? 'warn' : ''} big2">${Math.round(m * 100)}%</b></div>
        <p class="small">${s.name} (Standard): <b class="money">$${P.ask(sample)}</b>/unit</p>
        <div class="row"><button class="btn" data-act="markup" data-fam="${fam}" data-d="-0.1">-10%</button><button class="btn" data-act="markup" data-fam="${fam}" data-d="0.1">+10%</button></div>
      </div>`;
    }
    return h + '<p class="dim small">What someone pays depends on quality, effects they like, their wallet, how much they like you, how hooked they are, and whose turf it is.</p>';
  }
  function appMenu() {
    const st = S.settings;
    return `
      <button class="btn good wide" data-act="save">Save game</button>
      <div class="kv setting"><span>Mouse / touch look</span><span class="row"><button class="btn sm" data-act="sens" data-d="-0.1">-</button><b>${st.sensitivity.toFixed(1)}</b><button class="btn sm" data-act="sens" data-d="0.1">+</button></span></div>
      <div class="kv setting"><span>Volume</span><span class="row"><button class="btn sm" data-act="vol" data-d="-0.1">-</button><b>${Math.round(st.volume * 100)}%</b><button class="btn sm" data-act="vol" data-d="0.1">+</button></span></div>
      <div class="kv setting"><span>Time speed</span><span class="row">${[1, 2, 4].map((t) => `<button class="btn sm ${st.timeScale === t ? 'good' : ''}" data-act="timescale" data-t="${t}">${t}x</button>`).join('')}</span></div>
      <button class="btn wide" data-act="howto">How to play</button>
      <button class="btn danger wide" data-act="quit">${ui.confirmQuit ? 'Sure? (saves first)' : 'Quit to title'}</button>`;
  }

  // ---------------------------------------------------------------- panels
  function panelShop(catalog) {
    const st = S.game.state, rank = S.rankFor(st.xp);
    const defs = S.shopOrder.map((id) => S.itemDefs[id]).filter((d) => d.catalog === catalog);
    const title = catalog === 'supplies' ? 'Supplies' : 'Corner Mart mixers';
    const where = catalog === 'supplies' ? 'Deliveries land on the green mat by your door.' : 'Purchases appear on the counter next to the screen.';
    return `<h2>${title}</h2><p class="dim">${where} Cash: <b class="money">${S.money(st.cash)}</b></p>
      <div class="shop">${defs.map((d) => {
        const locked = d.rank > rank, owned = d.owned && d.owned(), afford = st.cash >= d.price;
        const label = owned ? 'Owned' : locked ? 'Locked' : `$${d.price}`;
        return `<div class="shoprow ${locked ? 'locked' : ''}">
          <div><b>${S.esc(d.name)}</b><p class="small dim">${locked ? `<span class="warn">Needs rank: ${RANKS[d.rank]}</span>` : S.esc(d.desc)}</p></div>
          <button class="btn ${owned || locked ? '' : afford ? 'good' : 'danger'}" data-act="buy" data-id="${d.id}" ${owned || locked ? 'disabled' : ''}>${label}</button></div>`;
      }).join('')}</div>`;
  }
  function panelMixer() {
    const m = S.stations.mixer;
    const units = m.slots.map((s) => s.item).filter(Boolean), add = m.cup.item;
    let preview = '<p class="dim">Put loose product (buds or crystal) on the tray: hold it and click the station. Add a mixer from the Corner Mart to the cup.</p>';
    if (units.length && add) {
      const first = units[0].product, res = P.mix(first, add.def.effect), before = P.ask(first), after = P.ask(res);
      preview = `<p>${S.esc(P.name(first))} x${units.length}</p><p class="dim">becomes</p><p class="warn big2">${S.esc(P.name(res))}</p><p>${P.effectsTag(res)}</p>
        <p>$${before} &rarr; <b class="money">$${after}</b> each (${after >= before ? '<b class="good">+$' + (after - before) + '</b>' : '<b class="bad">-$' + (before - after) + '</b>'})</p>`;
    } else if (units.length) preview = `<p>${S.esc(P.name(units[0].product))} x${units.length}</p><p>${P.effectsTag(units[0].product)}</p><p class="dim">Add a mixer to the cup.</p>`;
    return `<h2>Mixing station</h2>${preview}
      <div class="row"><button class="btn good" data-act="mix" ${units.length && add && !m.mixing ? '' : 'disabled'}>${m.mixing ? 'Mixing...' : 'Mix'}</button><button class="btn" data-act="close">Close</button></div>`;
  }
  function panelChem() {
    const c = S.stations.chem;
    const zone = c.heat > 0.92 ? '<b class="bad">TOO HOT - burning!</b>' : c.heat >= 0.55 && c.heat <= 0.78 ? '<b class="good">Perfect heat</b>' : c.heat > 0.78 ? '<b class="warn">A bit hot</b>' : '<b style="color:#8cf">Too cold - slow</b>';
    const band = c.total > 0 ? Math.round(c.band / c.total * 100) : 0;
    return `<h2>Chem station</h2>
      <p>${c.syrup.item ? '<b class="good">Blue Syrup</b>' : '<b class="bad">Blue Syrup</b>'} + ${c.salt.item ? '<b class="good">Fizz Salt</b>' : '<b class="bad">Fizz Salt</b>'} <span class="dim">(hold one and click the station to place it)</span></p>
      <label class="small dim" for="heatDial">Heat knob</label>
      <input type="range" id="heatDial" min="0" max="100" value="${Math.round(c.dial * 100)}">
      <div class="gauge"><i class="band"></i><i class="burn"></i><i class="needle" id="heatNeedle" style="left:${c.heat * 100}%"></i></div>
      <p id="chemStatus">${c.cooking ? `${zone} - in the zone ${band}%` : 'Keep the needle in the green band while it cooks. The flame drifts.'}</p>
      <div class="bar"><i id="chemProgress" style="width:${c.progress * 100}%"></i></div>
      <div class="row"><button class="btn good" data-act="cook" ${!c.cooking && c.syrup.item && c.salt.item ? '' : 'disabled'}>${c.cooking ? 'Cooking...' : 'Start'}</button><button class="btn" data-act="close">Close</button></div>`;
  }

  // keyboard wording -> touch wording (goal text and look hints)
  function touchText(t) {
    if (!S.input.touch) return t;
    return t.replace(/hold R\b/g, 'hold Pour').replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap').replace(/ \(Tab\)/g, '');
  }
  function touchHint(h) {
    return h.replace(/<kbd>Q<\/kbd> drop - /g, '').replace(/<kbd>Click<\/kbd>/g, '<kbd>Use</kbd>').replace(/<kbd>R<\/kbd>/g, '<kbd>Pour</kbd>').replace(/<kbd>F<\/kbd>/g, '<kbd>Throw</kbd>');
  }

  const HOWTO = `<h2>How to play</h2>
    <p><b>Move</b> WASD, <b>run</b> Shift, <b>jump</b> Space. <b>Hold Space against a wall to climb</b> - you're a monke. Buildings, dumpsters and the fire escape are all climbable.</p>
    <p><b>Use / grab / place</b> left click or E. Holding something and clicking a surface puts it there. <b>Pour</b> hold R (tilt a bag, can or seed packet over a pot). <b>Drop</b> Q, <b>throw</b> F. <b>Phone</b> Tab. Click the game to capture the mouse (Esc frees it).</p>
    <ol>
      <li><b>Grow.</b> Grab the soil bag, look at the empty pot and hold R. Do the same with the seed packet, then the watering can.</li>
      <li><b>Wait.</b> It grows in real time (sleep after 6 PM to skip). Hover the pot for water and time left.</li>
      <li><b>Harvest.</b> Click the ready plant to pick buds. Holding a baggie? Buds go straight in.</li>
      <li><b>Package.</b> Click the baggie box on the packing table for a bag, then click the bag with a bud (or click the box while holding a bud).</li>
      <li><b>Sell.</b> Accept a deal in Messages, follow the yellow beacon, click the customer while holding the bag. Grab the cash from their hand. Strangers get free samples.</li>
      <li><b>Cops</b> notice product in your hand. Run, climb or get home.</li>
    </ol>
    <p class="dim">Rent is $150 every 7 days. Buy supplies on the computer by your door, mixers at the Corner Mart.</p>
    <div class="row"><button class="btn" data-act="close">Got it</button></div>`;
})();

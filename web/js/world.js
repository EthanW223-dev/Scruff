/* Scruff web preview - the neighbourhood (same layout as the Unity WorldBuilder), colliders, POIs, NPC walk graph. */
'use strict';
(() => {
  const C = S.C;
  const V3 = THREE.Vector3;
  const DEG = Math.PI / 180;

  /** Local station coordinates -> world, for a station at pos with yaw (deg). */
  S.local = (pos, yaw, x, y, z) => {
    const c = Math.cos(yaw * DEG), s = Math.sin(yaw * DEG);
    return new V3(pos[0] + x * c + z * s, pos[1] + y, pos[2] - x * s + z * c);
  };
  /** World AABB of a local box (centre + size) on a station. */
  S.localBox = (pos, yaw, c, size) => {
    const pts = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) pts.push(S.local(pos, yaw, c[0] + sx * size[0] / 2, 0, c[2] + sz * size[2] / 2));
    const min = [Math.min(...pts.map((p) => p.x)), pos[1] + c[1] - size[1] / 2, Math.min(...pts.map((p) => p.z))];
    const max = [Math.max(...pts.map((p) => p.x)), pos[1] + c[1] + size[1] / 2, Math.max(...pts.map((p) => p.z))];
    return { min, max };
  };

  S.makeSign = (text, w, h, bg, fg, font = '700 64px "Bungee", "Arial Black", sans-serif') => {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = Math.max(64, Math.round(512 * h / w));
    const g = cv.getContext('2d');
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height); }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 64; g.font = font.replace('64px', size + 'px');
    while (g.measureText(text).width > cv.width * 0.9 && size > 12) { size -= 4; g.font = font.replace('64px', size + 'px'); }
    g.fillText(text, cv.width / 2, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: !bg }));
    return m;
  };

  S.buildWorld = (scene) => {
    const cw = new S.CollisionWorld();
    S.cw = cw;
    const R = (S.refs = { pois: [], stations: {}, blockers: [] });
    let mb = new S.MeshBuilder();
    const flush = () => {
      if (mb.count) { const m = mb.mesh(); m.matrixAutoUpdate = false; m.updateMatrix(); scene.add(m); }
      mb = new S.MeshBuilder();
    };
    const check = () => { if (mb.count > 60000) flush(); };
    const solid = (min, max, sound) => cw.add(min, max, sound);
    const box = (min, max, side, top = side, isSolid = true, sound) => { check(); mb.boxMM(min, max, side, top); if (isSolid) solid(min, max, sound); };
    const win = (c, s) => {
      check();
      mb.night = 0.9; mb.box(c, s, C.window); mb.night = 0;
      mb.box([c[0], c[1] + s[1] / 2 + 0.03, c[2]], [s[0] + 0.12, 0.06, s[2] + 0.04], C.plaster);
    };
    const poi = (type, name, x, y, z, radius = 1.5) => R.pois.push({ type, name, x, y, z, radius });
    const sign = (text, x, y, z, w, h, faceYaw, bg, fg) => {
      const m = S.makeSign(text, w, h, bg, fg);
      m.position.set(x, y, z); m.rotation.y = faceYaw * DEG; scene.add(m); return m;
    };

    // ---------------------------------------------------------------- ground & roads
    box([-62, -0.5, -32], [72, 0, 62], C.grassDark, C.grass, true, 'grass');
    box([-62, 0, 22], [72, 0.02, 29], C.asphalt, C.asphalt, false);
    box([24, 0, -32], [31, 0.021, 62], C.asphalt, C.asphalt, false);
    for (let x = -60; x < 70; x += 4) if (x < 22 || x > 33) box([x, 0.02, 25.4], [x + 2, 0.025, 25.6], C.line, C.line, false);
    for (let z = -30; z < 60; z += 4) if (z < 20 || z > 31) box([27.4, 0.021, z], [27.6, 0.026, z + 2], C.line, C.line, false);
    for (let i = 0; i < 6; i++) {
      const x = 24.4 + i * 1.1;
      box([x, 0.02, 19.2], [x + 0.6, 0.026, 21.9], C.white, C.white, false);
      box([x, 0.02, 29.1], [x + 0.6, 0.026, 31.8], C.white, C.white, false);
    }
    const sh = 0.12;
    for (const [a, b] of [
      [[-62, 0, 19], [24, sh, 22]], [[31, 0, 19], [72, sh, 22]], [[-62, 0, 29], [24, sh, 32]], [[31, 0, 29], [72, sh, 32]],
      [[21, 0, -32], [24, sh, 19]], [[21, 0, 32], [24, sh, 62]], [[31, 0, -32], [34, sh, 19]], [[31, 0, 32], [34, sh, 62]],
    ]) box(a, b, C.curb, C.sidewalk, true);

    // ---------------------------------------------------------------- the apartment
    {
      const x0 = -5, x1 = 5, z0 = 8, z1 = 16, H = 2.8, t = 0.2, p = 0.012;
      box([x0 + t, 0, z0 + t], [x1 - t, 0.05, z1 - t], C.woodDark, C.floor, true, 'wood');
      box([-2.2, 0.05, 11.2], [1.2, 0.06, 14.2], [0.5, 0.28, 0.25], [0.55, 0.3, 0.26], false);
      box([1.7, 0.05, 8.25], [4.75, 0.058, 11.2], [0.5, 0.52, 0.55], [0.56, 0.58, 0.62], false); // grow tarp
      box([x0, 0, z0], [x1, H, z0 + t], C.brick);
      box([x0, 0, z0 + t], [x0 + t, H, z1 - t], C.brick);
      box([x1 - t, 0, z0 + t], [x1, H, z1 - t], C.brick);
      box([x0, 0, z1 - t], [-0.65, H, z1], C.brick);
      box([0.65, 0, z1 - t], [x1, H, z1], C.brick);
      box([-0.65, 2.25, z1 - t], [0.65, H, z1], C.brick);
      box([x0 + t, 0.05, z0 + t], [x1 - t, H, z0 + t + p], C.wall, C.wall, false);
      box([x0 + t, 0.05, z0 + t], [x0 + t + p, H, z1 - t], C.wall, C.wall, false);
      box([x1 - t - p, 0.05, z0 + t], [x1 - t, H, z1 - t], C.wall, C.wall, false);
      box([x0 + t, 0.05, z1 - t - p], [-0.65, H, z1 - t], C.wall, C.wall, false);
      box([0.65, 0.05, z1 - t - p], [x1 - t, H, z1 - t], C.wall, C.wall, false);
      win([-3, 1.45, z1 + 0.01], [1.1, 0.85, 0.05]); win([3, 1.45, z1 + 0.01], [1.1, 0.85, 0.05]);
      win([-3, 1.45, z1 - t - 0.02], [1.1, 0.85, 0.03]); win([3, 1.45, z1 - t - 0.02], [1.1, 0.85, 0.03]);
      box([x0, H, z0], [x1, H + 0.2, z1], C.plaster);
      mb.emission = 1;
      mb.box([0, H - 0.02, 12], [1.2, 0.04, 0.6], [1, 0.95, 0.85]);
      mb.box([3.2, 2.1, 9.7], [1.4, 0.06, 0.8], [0.85, 0.55, 1]);
      mb.emission = 0;
      mb.box([3.2, 2.16, 9.7], [1.5, 0.08, 0.9], C.metalDark);
      box([x0, H + 0.2, z0], [x1, 6.4, z1], C.brick);
      box([x0 - 0.1, 6.4, z0 - 0.1], [x1 + 0.1, 6.55, z1 + 0.1], C.concreteDark, C.roof);
      box([x0 - 0.1, 6.55, z0 - 0.1], [x1 + 0.1, 6.9, z0 + 0.1], C.concreteDark);
      box([x0 - 0.1, 6.55, z1 - 0.1], [x1 + 0.1, 6.9, z1 + 0.1], C.concreteDark);
      for (let i = 0; i < 4; i++) { const wx = -3.6 + i * 2.4; win([wx, 4.6, z1 + 0.01], [1, 1.1, 0.05]); win([wx, 4.6, z0 - 0.01], [1, 1.1, 0.05]); }
      // fire-escape ladder: climb to the roof
      for (let i = 0; i < 12; i++) box([x1 + 0.05, 0.4 + i * 0.5, 10.4], [x1 + 0.14, 0.46 + i * 0.5, 11.2], C.metalDark, C.metalDark, true, 'metal');
      box([x1 + 0.05, 0, 10.33], [x1 + 0.14, 6.4, 10.4], C.metalDark, C.metalDark, true, 'metal');
      box([x1 + 0.05, 0, 11.2], [x1 + 0.14, 6.4, 11.27], C.metalDark, C.metalDark, true, 'metal');
      box([-1.2, 0, z1], [1.2, 0.1, 19], C.curb, C.concrete);
      sign('APT 1', 0, 2.55, z1 + 0.03, 0.8, 0.3, 0, '#26272b', '#efefeb');
      R.safeZone = { min: [-4.8, -0.5, 8.2], max: [4.8, 3, 15.8] };
      R.homeSpawn = new V3(0, 0.05, 12.4);
      R.homeYaw = 0;
      S.U.uIndoorMin0.value.set(-4.9, -0.1, 8.1); S.U.uIndoorMax0.value.set(4.9, 3.0, 15.9);

      // delivery mat
      box([-2.3, 0.05, 14.6], [-1.1, 0.07, 15.6], [0.3, 0.5, 0.35], [0.35, 0.6, 0.4], false);
      const dm = S.makeSign('DELIVERIES', 1.1, 0.22, null, '#e8f5e9');
      dm.position.set(-1.7, 0.075, 15.1); dm.rotation.x = -Math.PI / 2; scene.add(dm);
      R.homeDelivery = new V3(-1.7, 0.12, 15.1);
      R.starter = { pot: new V3(2.7, 0.06, 9.3), soil: new V3(1.9, 0.06, 11.0), seeds: new V3(2.4, 0.06, 11.4), can: new V3(1.2, 0.06, 9.0) };
      for (let i = 0; i < 4; i++) mb.cyl([2.7 + (i % 2) * 1.1, 0.058, 9.3 + Math.floor(i / 2)], 0.16, 0.004, 12, [0.66, 0.66, 0.7]);
    }

    // ---------------------------------------------------------------- stations (geometry + pick volumes; logic lives in game.js)
    const table = (st, c, size, h, top, legs, sound = 'wood') => {
      const [w, d] = size, tk = 0.045;
      mb.box([c[0], h - tk / 2, c[2]], [w, tk, d], S.mix(top, [0, 0, 0], 0.15), top);
      const lx = w / 2 - 0.04, lz = d / 2 - 0.04;
      for (let i = 0; i < 4; i++) mb.box([c[0] + (i % 2 ? lx : -lx), (h - tk) / 2, c[2] + (i < 2 ? -lz : lz)], [0.045, h - tk, 0.045], legs);
      mb.box([c[0], h * 0.25, c[2]], [w - 0.1, 0.03, d - 0.1], legs);
      const bb = S.localBox(st.pos, st.yaw, [c[0], h / 2, c[2]], [w, h, d]);
      solid(bb.min, bb.max, sound);
    };
    const station = (name, pos, yaw) => { const st = { name, pos, yaw }; R.stations[name] = st; return st; };
    const L = (st, x, y, z) => S.local(st.pos, st.yaw, x, y, z);
    const pickBox = (st, c, size) => S.localBox(st.pos, st.yaw, c, size);
    const withStation = (st, fn) => { check(); mb.pushTRS(st.pos, st.yaw); fn(); mb.pop(); };

    // bed
    {
      const st = station('bed', [-3.95, 0.05, 9.45], 0);
      withStation(st, () => {
        mb.box([0, 0.12, 0], [1, 0.24, 2], C.woodDark);
        mb.box([0, 0.3, 0], [0.94, 0.14, 1.94], [0.85, 0.85, 0.82], [0.9, 0.9, 0.88]);
        mb.box([0, 0.38, 0.25], [0.97, 0.04, 1.4], [0.35, 0.42, 0.6], [0.4, 0.48, 0.68]);
        mb.box([0, 0.41, -0.72], [0.6, 0.1, 0.3], [0.95, 0.95, 0.93]);
        mb.box([0, 0.45, -0.99], [1, 0.9, 0.05], C.woodDark);
      });
      const b = pickBox(st, [0, 0.2, 0], [1, 0.4, 2]); solid(b.min, b.max, 'grass');
      const hb = pickBox(st, [0, 0.45, -0.99], [1, 0.9, 0.05]); solid(hb.min, hb.max, 'wood');
      st.pick = pickBox(st, [0, 0.3, 0], [1, 0.6, 2]);
    }
    // sink
    {
      const st = station('sink', [0, 0.05, 8.47], 0);
      const h = 0.68;
      withStation(st, () => {
        mb.box([0, h / 2, 0], [0.7, h, 0.5], [0.62, 0.66, 0.7], [0.85, 0.85, 0.83]);
        mb.box([0, h + 0.001, 0.02], [0.42, 0.002, 0.3], [0.35, 0.38, 0.42]);
        mb.cyl([0, h, -0.18], 0.018, 0.22, 8, C.metal);
        mb.box([0, h + 0.22, -0.11], [0.03, 0.03, 0.16], C.metal);
        mb.box([-0.17, h * 0.45, 0.252], [0.3, h * 0.7, 0.006], [0.55, 0.6, 0.65]);
        mb.box([0.17, h * 0.45, 0.252], [0.3, h * 0.7, 0.006], [0.55, 0.6, 0.65]);
      });
      const b = pickBox(st, [0, h / 2, 0], [0.7, h, 0.5]); solid(b.min, b.max);
      st.pick = pickBox(st, [0, h / 2 + 0.1, 0], [0.7, h + 0.3, 0.5]);
      st.tap = L(st, 0, h + 0.18, -0.035);
    }
    // packing table
    {
      const st = station('packing', [-4.48, 0.05, 12.4], 90);
      const h = 0.62;
      withStation(st, () => {
        table(st, [0, 0, 0], [1.1, 0.6], h, C.wood, C.woodDark);
        mb.box([0.05, h + 0.003, 0.05], [0.45, 0.006, 0.32], [0.2, 0.45, 0.35], [0.25, 0.55, 0.42]);
        mb.box([-0.38, h + 0.06, -0.1], [0.2, 0.12, 0.14], [0.85, 0.8, 0.7], [0.3, 0.28, 0.25]);
        for (let i = 0; i < 4; i++) mb.box([-0.44 + i * 0.04, h + 0.13, -0.1], [0.035, 0.05, 0.1], [0.86, 0.9, 0.94]);
        mb.box([0.4, h + 0.05, -0.12], [0.22, 0.1, 0.2], C.woodDark, [0.2, 0.15, 0.1]);
        for (let i = 0; i < 4; i++) mb.cyl([0.35 + (i % 2) * 0.1, h + 0.07, -0.17 + Math.floor(i / 2) * 0.1], 0.035, 0.08, 8, [0.7, 0.82, 0.9], [0.18, 0.2, 0.22]);
      });
      st.baggies = pickBox(st, [-0.38, h + 0.1, -0.1], [0.24, 0.18, 0.18]);
      st.jars = pickBox(st, [0.4, h + 0.1, -0.12], [0.26, 0.16, 0.24]);
      st.surface = h + 0.05;
      const sg = S.makeSign('PACKING', 0.5, 0.1, '#17191f', '#74d97f');
      const sp = L(st, 0, h + 0.45, -0.29); sg.position.copy(sp); sg.rotation.y = st.yaw * DEG; scene.add(sg);
      withStation(st, () => mb.box([0, h + 0.2, -0.3], [0.04, 0.4, 0.02], C.woodDark));
    }
    // trash
    {
      const st = station('trash', [-4.45, 0.05, 14.3], 0);
      withStation(st, () => {
        mb.frustum([0, 0, 0], 0.15, 0.18, 0.5, 10, [0.3, 0.34, 0.36], false);
        mb.flip = true; mb.frustum([0, 0.02, 0], 0.14, 0.17, 0.48, 10, [0.12, 0.12, 0.13], false); mb.flip = false;
      });
      const b = pickBox(st, [0, 0.25, 0], [0.34, 0.5, 0.34]); solid(b.min, b.max, 'metal'); st.pick = b;
      st.mouth = L(st, 0, 0.55, 0);
    }
    // stations with a locked tarp until bought
    const tarp = (st, h, title) => {
      const t = new S.MeshBuilder();
      t.pushTRS(st.pos, st.yaw);
      t.box([0, h + 0.2, -0.02], [1.0, 0.42, 0.6], [0.25, 0.35, 0.55], [0.28, 0.4, 0.6]);
      const m = t.mesh(); scene.add(m);
      const sg = S.makeSign(title + ' - LOCKED', 0.7, 0.09, '#17191f', '#ffc74d');
      sg.position.copy(L(st, 0, h + 0.3, 0.285)); sg.rotation.y = st.yaw * DEG; scene.add(sg);
      return [m, sg];
    };
    // mixing station
    {
      const st = station('mixer', [4.5, 0.05, 12.2], -90);
      const h = 0.62;
      withStation(st, () => {
        table(st, [0, 0, 0], [0.95, 0.55], h, C.woodLight, C.woodDark);
        mb.box([-0.2, h + 0.008, 0.1], [0.48, 0.016, 0.16], C.metalDark, C.metal);
        mb.cyl([0.3, h, 0.12], 0.06, 0.012, 10, C.metalDark);
        mb.box([0.05, h + 0.13, -0.15], [0.32, 0.26, 0.2], [0.75, 0.35, 0.3], [0.8, 0.4, 0.35]);
        mb.box([0.32, h + 0.17, -0.17], [0.28, 0.34, 0.06], C.metalDark, C.metalDark, 0, -12);
        mb.emission = 1; mb.box([0.32, h + 0.17, -0.137], [0.24, 0.28, 0.01], [0.09, 0.1, 0.12], [0.09, 0.1, 0.12], 0, -12); mb.emission = 0;
      });
      const mbody = pickBox(st, [0.05, h + 0.13, -0.15], [0.32, 0.26, 0.2]); solid(mbody.min, mbody.max, 'metal');
      st.slots = [0, 1, 2, 3].map((i) => L(st, -0.38 + i * 0.12, h + 0.017, 0.1));
      st.cup = L(st, 0.3, h + 0.012, 0.12);
      st.pick = pickBox(st, [0, h / 2 + 0.2, 0], [0.95, h + 0.5, 0.55]);
      st.bowl = L(st, 0.05, h + 0.3, -0.15);
      const sg = S.makeSign('MIXER', 0.2, 0.05, null, '#74d97f');
      sg.position.copy(L(st, 0.32, h + 0.31, -0.13)); sg.rotation.set(-12 * DEG, st.yaw * DEG, 0, 'YXZ'); scene.add(sg);
      st.locked = tarp(st, h, 'MIXING STATION');
    }
    // chem station
    {
      const st = station('chem', [4.5, 0.05, 14.5], -90);
      const h = 0.62;
      withStation(st, () => {
        table(st, [0, 0, 0], [0.95, 0.55], h, C.metal, C.metalDark, 'metal');
        mb.box([-0.05, h + 0.06, -0.08], [0.42, 0.12, 0.34], [0.9, 0.9, 0.88], [0.2, 0.2, 0.22]);
        mb.frustum([-0.05, h + 0.125, -0.1], 0.1, 0.11, 0.13, 10, C.metal, false);
        mb.box([-0.38, h + 0.005, 0.14], [0.12, 0.01, 0.12], C.metalDark, [0.3, 0.45, 0.8]);
        mb.box([-0.38, h + 0.005, -0.08], [0.12, 0.01, 0.12], C.metalDark, [0.95, 0.6, 0.3]);
        mb.box([0.3, h + 0.01, 0.13], [0.22, 0.02, 0.16], C.metalDark, C.metal);
        mb.box([0.3, h + 0.17, -0.17], [0.3, 0.34, 0.06], C.metalDark, C.metalDark, 0, -12);
        mb.cyl([-0.05, h + 0.06, 0.1], 0.032, 0.025, 10, [0.15, 0.15, 0.17], [0.15, 0.15, 0.17], 90);
      });
      const sb = pickBox(st, [-0.05, h + 0.06, -0.08], [0.42, 0.12, 0.34]); solid(sb.min, sb.max, 'metal');
      st.syrup = L(st, -0.38, h + 0.01, 0.14);
      st.salt = L(st, -0.38, h + 0.01, -0.08);
      st.output = L(st, 0.3, h + 0.03, 0.13);
      st.potTop = L(st, -0.05, h + 0.26, -0.1);
      st.pick = pickBox(st, [0, h / 2 + 0.2, 0], [0.95, h + 0.5, 0.55]);
      const fl = new S.MeshBuilder(); fl.emission = 1; fl.pushTRS(st.pos, st.yaw); fl.cyl([-0.05, h + 0.121, -0.1], 0.085, 0.004, 10, [1, 0.45, 0.15]);
      st.flame = fl.mesh(); st.flame.visible = false; scene.add(st.flame);
      const sg = S.makeSign('CHEM', 0.2, 0.05, null, '#8cc8ff');
      sg.position.copy(L(st, 0.3, h + 0.31, -0.13)); sg.rotation.set(-12 * DEG, st.yaw * DEG, 0, 'YXZ'); scene.add(sg);
      st.locked = tarp(st, h, 'CHEM STATION');
    }
    // computer desk (supplies shop)
    {
      const st = station('computer', [-3.3, 0.05, 15.5], 180);
      withStation(st, () => {
        table(st, [0, 0, 0], [0.9, 0.55], 0.6, C.woodDark, C.metalDark);
        mb.box([0, 0.63, -0.12], [0.2, 0.03, 0.15], C.metalDark);
        mb.box([0, 0.72, -0.16], [0.05, 0.18, 0.04], C.metalDark);
        mb.box([0, 0.95, -0.15], [0.72, 0.5, 0.06], [0.16, 0.17, 0.2], [0.16, 0.17, 0.2], 0, -8);
        mb.emission = 1; mb.box([0, 0.95, -0.115], [0.66, 0.44, 0.01], [0.2, 0.45, 0.3], [0.2, 0.45, 0.3], 0, -8); mb.emission = 0;
        mb.box([0.05, 0.615, 0.12], [0.36, 0.02, 0.13], [0.25, 0.26, 0.3]);
      });
      st.pick = pickBox(st, [0, 0.8, -0.1], [0.8, 0.6, 0.4]);
      const sg = S.makeSign('SUPPLIES', 0.5, 0.1, null, '#74d97f');
      sg.position.copy(L(st, 0, 1.05, -0.108)); sg.rotation.set(-8 * DEG, st.yaw * DEG, 0, 'YXZ'); scene.add(sg);
    }

    // door (click to swing)
    {
      const g = new THREE.Group();
      g.position.set(-0.6, 0.05, 15.9);
      const d = new S.MeshBuilder();
      d.box([0.6, 1.08, 0], [1.18, 2.16, 0.05], C.door);
      d.box([0.6, 1.5, 0], [0.8, 0.6, 0.06], S.mix(C.door, [0, 0, 0], 0.15));
      d.box([0.6, 0.55, 0], [0.8, 0.6, 0.06], S.mix(C.door, [0, 0, 0], 0.15));
      d.box([1.05, 0.95, 0.06], [0.12, 0.035, 0.035], C.badge); d.box([1.05, 0.95, -0.06], [0.12, 0.035, 0.035], C.badge);
      g.add(d.mesh()); scene.add(g);
      const col = cw.add([-0.6, 0.05, 15.87], [0.6, 2.2, 15.93], 'wood');
      R.door = { group: g, collider: col, angle: 95, target: 95, pick: { min: [-0.7, 0.05, 15.2], max: [0.7, 2.2, 16.6] } };
    }
    flush();

    // ---------------------------------------------------------------- corner store
    {
      const x0 = 12, x1 = 20, z0 = 10, z1 = 17, H = 3, t = 0.2, wall = C.sidingYellow;
      box([x0 + t, 0, z0 + t], [x1 - t, 0.05, z1 - t], C.concreteDark, [0.75, 0.75, 0.72]);
      box([x0, 0, z0], [x1, H, z0 + t], wall); box([x0, 0, z0 + t], [x0 + t, H, z1 - t], wall); box([x1 - t, 0, z0 + t], [x1, H, z1 - t], wall);
      box([x0, 0, z1 - t], [15, H, z1], wall); box([17, 0, z1 - t], [x1, H, z1], wall); box([15, 2.3, z1 - t], [17, H, z1], wall);
      box([x0 - 0.2, H, z0 - 0.2], [x1 + 0.2, H + 0.25, z1 + 0.2], C.concreteDark, C.roof);
      box([x0, 2.4, z1], [x1, 2.5, z1 + 1.2], [0.8, 0.25, 0.2], [0.9, 0.3, 0.25]);
      win([13.5, 1.3, z1 + 0.01], [2.2, 1.4, 0.05]); win([18.5, 1.3, z1 + 0.01], [2.2, 1.4, 0.05]);
      sign('CORNER MART', 16, 2.75, z1 + 1.25, 3.2, 0.45, 0, '#bf332e', '#fff2cc');
      const rng = S.rng(99);
      for (let i = 0; i < 2; i++) {
        const sx = 13 + i * 2.6;
        box([sx, 0.05, 11], [sx + 1.8, 1.3, 11.5], C.metalDark, C.metal, true, 'metal');
        for (let k = 0; k < 10; k++) {
          mb.box([sx + 0.15 + k * 0.16, 1.38, 11.25], [0.12, 0.16, 0.12], S.CLOTHES[Math.floor(rng() * S.CLOTHES.length)]);
          mb.box([sx + 0.15 + k * 0.16, 0.72, 11.25], [0.12, 0.14, 0.12], S.CLOTHES[(k * 3) % S.CLOTHES.length]);
        }
      }
      box([12.3, 0.05, 13.8], [14.2, 0.95, 14.5], C.woodDark, C.wood, true, 'wood');
      S.U.uIndoorMin1.value.set(12.1, -0.1, 10.1); S.U.uIndoorMax1.value.set(19.9, 3.0, 16.9);
      // kiosk
      const st = station('kiosk', [19.3, 0.05, 13.6], -90);
      withStation(st, () => {
        mb.box([0, 0.5, -0.05], [0.2, 1.0, 0.15], [0.3, 0.5, 0.75]);
        mb.box([0, 1.05, -0.08], [0.72, 0.55, 0.08], [0.2, 0.22, 0.26], [0.2, 0.22, 0.26], 0, -10);
        mb.emission = 1; mb.box([0, 1.05, -0.035], [0.66, 0.48, 0.01], [0.55, 0.3, 0.65], [0.55, 0.3, 0.65], 0, -10); mb.emission = 0;
        mb.box([0, 0.02, -0.05], [0.4, 0.04, 0.3], [0.2, 0.22, 0.26]);
      });
      const kb = pickBox(st, [0, 0.5, -0.05], [0.2, 1.0, 0.15]); solid(kb.min, kb.max, 'metal');
      st.pick = pickBox(st, [0, 0.9, -0.05], [0.75, 0.8, 0.3]);
      const sg = S.makeSign('MIXERS', 0.5, 0.12, null, '#fff2cc');
      sg.position.copy(L(st, 0, 1.12, -0.028)); sg.rotation.set(-10 * DEG, st.yaw * DEG, 0, 'YXZ'); scene.add(sg);
      R.storeDelivery = new V3(17.9, 0.12, 13.6);
      poi('hangout', 'Corner Mart', 16, 0.12, 18.4); poi('meet', 'Corner Mart', 18.5, 0.12, 18.6, 1); poi('hangout', 'Mart Aisle', 16, 0.05, 12.4, 1);
    }

    // ---------------------------------------------------------------- police station
    {
      const x0 = -27, x1 = -14, z0 = 5, z1 = 17;
      box([x0, 0, z0], [x1, 4.2, z1], [0.72, 0.74, 0.78], C.roof);
      box([x0 - 0.05, 3.3, z0 - 0.05], [x1 + 0.05, 3.7, z1 + 0.05], C.policeBlue, C.policeBlue, false);
      box([-21.4, 0, z1], [-19.6, 2.3, z1 + 0.05], [0.2, 0.25, 0.35], [0.2, 0.25, 0.35], false);
      for (let i = 0; i < 4; i++) win([-25.5 + i * 3.6 + (i >= 2 ? 1.2 : 0), 1.6, z1 + 0.01], [1.4, 1, 0.05]);
      sign('POLICE', -20.5, 3.5, z1 + 0.1, 2.4, 0.5, 0, null, '#ffffff');
      box([-22, 0, z1], [-19, 0.1, 19], C.curb, C.concrete);
      car([-24.5, 0, 24.0], 90, [0.95, 0.95, 0.95], true);
      poi('police', 'Police Station', -20.5, 0.12, 18.6, 1.2);
    }

    // ---------------------------------------------------------------- houses
    const houseXs = [-52, -38, -24, -10, 6, 42, 56];
    const sidings = [C.siding, C.sidingYellow, C.sidingGreen, C.plaster, [0.75, 0.55, 0.5], C.siding, C.sidingGreen];
    houseXs.forEach((cx, i) => {
      const w = 8, d = 7, z0 = 36, wall = sidings[i % sidings.length];
      box([cx - w / 2, 0, z0], [cx + w / 2, 3.2, z0 + d], wall, C.roof);
      const roof = S.mix(C.roof, [0.45, 0.2, 0.15], (i % 3) * 0.35);
      const a = [cx - w / 2 - 0.3, 3.2, z0 - 0.3], b = [cx + w / 2 + 0.3, 3.2, z0 - 0.3], c = [cx + w / 2 + 0.3, 3.2, z0 + d + 0.3], dd = [cx - w / 2 - 0.3, 3.2, z0 + d + 0.3];
      const r0 = [cx - w / 2 - 0.3, 5.2, z0 + d / 2], r1 = [cx + w / 2 + 0.3, 5.2, z0 + d / 2];
      mb.quad(a, r0, r1, b, roof); mb.quad(c, r1, r0, dd, roof); mb.tri(dd, r0, a, wall); mb.tri(b, r1, c, wall);
      // stepped roof colliders so the roof is climbable
      for (let k = 0; k < 3; k++) { const inset = (k + 1) * (d / 2 + 0.3) / 4; solid([cx - w / 2, 3.2 + k * 0.6, z0 - 0.3 + inset], [cx + w / 2, 3.8 + k * 0.6, z0 + d + 0.3 - inset], 'wood'); }
      box([cx - 0.55, 0, z0 - 0.04], [cx + 0.55, 2.1, z0], C.door, C.door, false);
      win([cx - 2.5, 1.6, z0 - 0.02], [1.2, 1, 0.05]); win([cx + 2.5, 1.6, z0 - 0.02], [1.2, 1, 0.05]);
      box([cx - 1.2, 0, z0 - 1.2], [cx + 1.2, 0.15, z0], C.woodDark, C.wood, true, 'wood');
      box([cx - 0.6, 0, 32], [cx + 0.6, 0.13, z0 - 1.2], C.curb, C.concrete);
      for (let fx = cx - w / 2; fx < cx - 1; fx += 0.4) box([fx, 0, 33], [fx + 0.08, 0.8, 33.08], C.white, C.white, false);
      for (let fx = cx + 1; fx < cx + w / 2; fx += 0.4) box([fx, 0, 33], [fx + 0.08, 0.8, 33.08], C.white, C.white, false);
      box([cx - w / 2, 0.55, 32.98], [cx - 1, 0.65, 33.1], C.white);
      box([cx + 1, 0.55, 32.98], [cx + w / 2, 0.65, 33.1], C.white);
      poi('home', `House ${i + 1}`, cx, 0.1, 34.3, 0.3);
      if (i % 2 === 0) poi('hangout', `Yard ${i + 1}`, cx + 2.5, 0, 34.5, 1.2);
      tree([cx + 3.2, 0, 44.5], 1.1);
    });

    // ---------------------------------------------------------------- park
    box([35, 0, -20], [62, 0.012, 21], C.grass, S.mix(C.grass, C.grassDark, 0.2), false);
    box([34, 0, 9], [62, 0.03, 11], C.curb, [0.75, 0.7, 0.6], false);
    box([46, 0, -20], [48, 0.031, 21], C.curb, [0.75, 0.7, 0.6], false);
    {
      const f = [47, 0, 10];
      mb.cyl(f, 2.2, 0.55, 16, C.concrete, C.concreteDark);
      mb.emission = 0.25; mb.cyl([47, 0.4, 10], 1.95, 0.16, 16, [0.35, 0.6, 0.85]); mb.emission = 0;
      mb.cyl(f, 0.3, 1.6, 8, C.concrete); mb.cyl([47, 1.6, 10], 0.8, 0.15, 10, C.concrete);
      solid([45, 0, 8], [49, 0.55, 12]); solid([46.7, 0, 9.7], [47.3, 1.75, 10.3]);
      poi('meet', 'Fountain', 47, 0.03, 7, 1); poi('hangout', 'Fountain', 50, 0.03, 10, 1.5);
    }
    bench([40, 0, 8.3], 0); bench([54, 0, 8.3], 0); bench([44.5, 0, 16], 90); bench([49.5, 0, 4], -90);
    poi('meet', 'Park Bench', 40, 0.03, 7.2, 0.8); poi('hangout', 'Park Bench', 54, 0.03, 7.2, 1); poi('hangout', 'Park Lawn', 55, 0, 16, 3);
    box([37, 0, -12], [45, 0.04, -2], [0.25, 0.3, 0.35], [0.3, 0.45, 0.55], false);
    box([40.9, 0.04, -12], [41.1, 0.045, -2], C.white, C.white, false);
    hoop([41, 0, -11.6], 0); hoop([41, 0, -2.4], 180);
    poi('meet', 'Basketball Court', 44, 0.04, -1, 1); poi('hangout', 'Basketball Court', 41, 0.04, -7, 2.5);
    {
      const g = [55, 0, -8], bar = [0.9, 0.45, 0.2];
      for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 3; iz++) box([g[0] + ix * 1.2, 0, g[2] + iz * 1.2], [g[0] + ix * 1.2 + 0.08, 2.2, g[2] + iz * 1.2 + 0.08], bar, bar, true, 'metal');
      for (let iz = 0; iz < 3; iz++) box([g[0], 2.2, g[2] + iz * 1.2], [g[0] + 3.68, 2.28, g[2] + iz * 1.2 + 0.08], bar, bar, true, 'metal');
      box([g[0], 1.1, g[2]], [g[0] + 3.68, 1.16, g[2] + 2.48], [0.3, 0.6, 0.85], [0.3, 0.6, 0.85], true, 'wood');
    }
    {
      const rng = S.rng(1234);
      for (let i = 0; i < 26; i++) {
        const p = [36 + rng() * 25, 0, -19 + rng() * 39];
        if (Math.abs(p[2] - 10) < 2.5 || Math.abs(p[0] - 47) < 2.5) continue;
        if (Math.hypot(p[0] - 47, p[2] - 10) < 4) continue;
        if (p[0] < 46 && p[2] < -1 && p[2] > -13) continue;
        if (p[0] > 53 && p[0] < 60 && p[2] > -10 && p[2] < -4) continue;
        if (Math.abs(p[2] - 16) < 1.5 && Math.abs(p[0] - 44.5) < 1.5) continue;
        tree(p, 0.8 + rng() * 0.6);
      }
    }

    // ---------------------------------------------------------------- alley
    for (let x = -12; x < 11; x += 2) { box([x, 0, 0], [x + 0.1, 2, 0.1], C.woodDark, C.woodDark, true, 'wood'); box([x, 0.2, 0.02], [x + 2, 1.9, 0.08], C.wood, C.wood, true, 'wood'); }
    dumpster([-3.5, 0, 4.5], 0); dumpster([7.5, 0, 3.8], 20);
    for (let i = 0; i < 5; i++) { const p = [-9 + (i % 3) * 0.95, Math.floor(i / 3) * 0.9, 2.2]; box(p, [p[0] + 0.9, p[1] + 0.9, p[2] + 0.9], C.wood, C.woodLight, true, 'wood'); }
    poi('meet', 'Back Alley', 2, 0, 4.8, 0.8); poi('hangout', 'Back Alley', -6, 0, 5.8, 1.2);

    // ---------------------------------------------------------------- street props
    for (let x = -56; x < 70; x += 16) { if (x > 20 && x < 34) continue; lamp([x, 0.12, 21.5], 0); lamp([x + 8, 0.12, 29.5], 180); }
    for (let z = -26; z < 60; z += 16) { if (z > 17 && z < 33) continue; lamp([22.5, 0.12, z], 90); lamp([32.5, 0.12, z + 8], -90); }
    car([-36, 0, 22.9], 90, [0.7, 0.2, 0.2]); car([-8, 0, 22.9], 90, [0.25, 0.4, 0.7]); car([40, 0, 22.9], 90, [0.9, 0.8, 0.4]);
    car([-44, 0, 28.1], -90, [0.3, 0.6, 0.4]); car([12, 0, 28.1], -90, [0.85, 0.85, 0.85]); car([29.8, 0, 4], 0, [0.45, 0.3, 0.6]);
    {
      const bs = [-17, 0.12, 31.2];
      box([bs[0] - 1.5, bs[1], bs[2] + 0.35], [bs[0] + 1.5, bs[1] + 2.3, bs[2] + 0.45], [0.3, 0.45, 0.6], [0.3, 0.45, 0.6], true, 'metal');
      box([bs[0] - 1.6, bs[1] + 2.3, bs[2] - 0.4], [bs[0] + 1.6, bs[1] + 2.4, bs[2] + 0.5], [0.25, 0.35, 0.45], [0.25, 0.35, 0.45], true, 'metal');
      box([bs[0] - 1.2, bs[1] + 0.4, bs[2]], [bs[0] + 1.2, bs[1] + 0.47, bs[2] + 0.35], C.wood, C.wood, true, 'wood');
      poi('meet', 'Bus Stop', -17, 0.12, 30.4, 0.8); poi('hangout', 'Bus Stop', -16.5, 0.12, 30.6, 1);
    }
    poi('hangout', 'Main St West', -40, 0.12, 20.5, 2); poi('hangout', 'Main St', -2, 0.12, 20.5, 2);
    poi('hangout', 'Northside Walk', 50, 0.12, 30.5, 2); poi('hangout', 'Oak Ave', 33, 0.12, 0, 1.5);

    // boundary
    const fence = [0.5, 0.52, 0.55];
    box([-62, 0, -32], [-61.8, 3, 62], fence, fence, true, 'metal'); box([71.8, 0, -32], [72, 3, 62], fence, fence, true, 'metal');
    box([-62, 0, -32], [72, 3, -31.8], fence, fence, true, 'metal'); box([-62, 0, 61.8], [72, 3, 62], fence, fence, true, 'metal');
    solid([-63, 3, -33], [-61.8, 60, 63]); solid([71.8, 3, -33], [73, 60, 63]); solid([-63, 3, -33], [73, 60, -31.8]); solid([-63, 3, 61.8], [73, 60, 63]);
    flush();

    // ---------------------------------------------------------------- turf zones
    R.turf = [
      { id: 'maple', name: 'Maple Street', min: [-62, -32], max: [22, 62] },
      { id: 'oakpark', name: 'Oak Park', min: [22, -32], max: [72, 25] },
      { id: 'northside', name: 'Northside', min: [22, 25], max: [72, 62] },
    ];

    buildNavGraph();
    return R;

    // ---------------------------------------------------------------- prop helpers
    function tree(p, s) {
      check();
      mb.frustum(p, 0.2 * s, 0.14 * s, 2.2 * s, 6, C.trunk);
      mb.sphere([p[0], p[1] + 2.9 * s, p[2]], 1.3 * s, C.leaves, 7, 4);
      mb.sphere([p[0] + 0.6 * s, p[1] + 2.4 * s, p[2] + 0.3 * s], 0.9 * s, C.leavesLight, 6, 4);
      mb.sphere([p[0] - 0.5 * s, p[1] + 2.5 * s, p[2] - 0.4 * s], 0.85 * s, C.leaves, 6, 4);
      solid([p[0] - 0.18 * s, 0, p[2] - 0.18 * s], [p[0] + 0.18 * s, 2.2 * s, p[2] + 0.18 * s], 'wood');
      solid([p[0] - 1.1 * s, 2 * s, p[2] - 1.1 * s], [p[0] + 1.1 * s, 3.8 * s, p[2] + 1.1 * s], 'grass');
    }
    function rotSolid(p, yaw, c, size, sound) { const b = S.localBox(p, yaw, c, size); solid(b.min, b.max, sound); }
    function bench(p, yaw) {
      check(); mb.pushTRS(p, yaw);
      mb.box([0, 0.45, 0], [1.6, 0.06, 0.45], C.wood); mb.box([0, 0.75, -0.2], [1.6, 0.35, 0.05], C.wood);
      mb.box([-0.7, 0.22, 0], [0.06, 0.45, 0.4], C.metalDark); mb.box([0.7, 0.22, 0], [0.06, 0.45, 0.4], C.metalDark);
      mb.pop();
      rotSolid(p, yaw, [0, 0.24, 0], [1.6, 0.48, 0.45], 'wood'); rotSolid(p, yaw, [0, 0.75, -0.2], [1.6, 0.35, 0.05], 'wood');
    }
    function hoop(p, yaw) {
      check(); mb.pushTRS(p, yaw);
      mb.box([0, 1.5, 0], [0.12, 3, 0.12], C.metalDark); mb.box([0, 3.2, 0.25], [1.2, 0.8, 0.05], C.white);
      mb.frustum([0, 2.95, 0.5], 0.24, 0.24, 0.03, 10, [0.9, 0.4, 0.2], false, false);
      mb.pop();
      rotSolid(p, yaw, [0, 1.5, 0], [0.12, 3, 0.12], 'metal'); rotSolid(p, yaw, [0, 3.2, 0.25], [1.2, 0.8, 0.05], 'wood');
    }
    function dumpster(p, yaw) {
      check(); mb.pushTRS(p, yaw);
      mb.box([0, 0.65, 0], [1.9, 1.2, 1.1], C.dumpster); mb.box([0, 1.3, -0.05], [1.95, 0.08, 1.2], C.metalDark, C.metalDark, 0, -6);
      mb.pop();
      rotSolid(p, yaw, [0, 0.68, 0], [1.9, 1.36, 1.1], 'metal');
    }
    function lamp(p, yaw) {
      check(); mb.pushTRS(p, yaw);
      mb.cyl([0, 0, 0], 0.08, 4.2, 6, C.metalDark); mb.box([0, 4.15, 0.45], [0.1, 0.08, 0.9], C.metalDark); mb.box([0, 4.05, 0.85], [0.35, 0.12, 0.3], C.metalDark);
      mb.night = 1; mb.box([0, 3.98, 0.85], [0.3, 0.03, 0.25], C.lamp); mb.night = 0;
      mb.pop();
      solid([p[0] - 0.08, 0, p[2] - 0.08], [p[0] + 0.08, 4.2, p[2] + 0.08], 'metal');
    }
    function car(p, yaw, color, police = false) {
      check(); mb.pushTRS(p, yaw);
      const dark = S.mix(color, [0, 0, 0], 0.3);
      mb.box([0, 0.55, 0], [1.8, 0.6, 4.2], color); mb.box([0, 1.1, -0.2], [1.6, 0.55, 2.2], color, dark);
      mb.night = 0.4; mb.box([0, 1.1, -0.2], [1.62, 0.4, 2.0], [0.35, 0.45, 0.55]); mb.night = 0;
      if (police) {
        mb.box([0, 0.55, 0], [1.82, 0.25, 2.4], C.policeBlue);
        mb.emission = 1; mb.box([-0.3, 1.42, -0.2], [0.45, 0.1, 0.2], [1, 0.2, 0.2]); mb.box([0.3, 1.42, -0.2], [0.45, 0.1, 0.2], [0.2, 0.4, 1]); mb.emission = 0;
      }
      for (let i = 0; i < 4; i++) mb.cyl([(i % 2 ? 0.92 : -0.92) - 0.1, 0.33, i < 2 ? -1.3 : 1.3], 0.33, 0.2, 8, [0.1, 0.1, 0.1], [0.1, 0.1, 0.1], 0, -90);
      mb.emission = 0.9;
      mb.box([-0.6, 0.65, 2.11], [0.3, 0.15, 0.02], [1, 0.95, 0.8]); mb.box([0.6, 0.65, 2.11], [0.3, 0.15, 0.02], [1, 0.95, 0.8]);
      mb.box([-0.6, 0.65, -2.11], [0.3, 0.12, 0.02], [0.9, 0.15, 0.1]); mb.box([0.6, 0.65, -2.11], [0.3, 0.12, 0.02], [0.9, 0.15, 0.1]);
      mb.emission = 0;
      mb.pop();
      rotSolid(p, yaw, [0, 0.55, 0], [1.8, 0.9, 4.2], 'metal'); rotSolid(p, yaw, [0, 1.1, -0.2], [1.6, 0.55, 2.2], 'metal');
    }

    // ---------------------------------------------------------------- NPC walk graph (sidewalks, paths, doors)
    function buildNavGraph() {
      const nodes = []; const index = new Map();
      const node = (x, z) => { const k = `${x},${z}`; if (index.has(k)) return index.get(k); const id = nodes.length; nodes.push({ id, x, z, links: [] }); index.set(k, id); return id; };
      const link = (a, b) => { if (a === b) return; nodes[a].links.push(b); nodes[b].links.push(a); };
      const chain = (pts) => { let prev = null; for (const [x, z] of pts) { const n = node(x, z); if (prev !== null) link(prev, n); prev = n; } };
      const L2 = (a, b) => link(node(a[0], a[1]), node(b[0], b[1]));
      chain([-56, -52, -40, -30, -20.5, -12, -7, -2, 0, 8.5, 16, 22].map((x) => [x, 20.5]));
      chain([-56, -52, -38, -30, -24, -17, -10, 0, 6, 16, 22].map((x) => [x, 30.5]));
      chain([33, 40, 47, 50, 56, 68].map((x) => [x, 20.5]));
      chain([33, 42, 50, 56, 68].map((x) => [x, 30.5]));
      L2([22, 20.5], [33, 20.5]); L2([22, 30.5], [33, 30.5]); L2([22, 20.5], [22, 30.5]);
      chain([-26, -10, 0, 12, 20.5].map((z) => [22, z])); chain([30.5, 38, 50].map((z) => [22, z]));
      chain([-26, -10, 0, 10, 20.5].map((z) => [33, z])); chain([30.5, 38, 50].map((z) => [33, z]));
      // park
      chain([[33, 10], [36, 10], [40, 10], [44, 10], [47, 7.5], [50, 10], [54, 10], [60, 10]]);
      chain([[44, 10], [47, 12.5], [50, 10]]);
      chain([[47, 20.5], [47, 16], [47, 12.5]]); chain([[47, 7.5], [47, -2], [47, -12], [47, -19]]);
      L2([47, -2], [44, -1]); L2([44, -1], [41, -7]); L2([40, 10], [40, 7.2]); L2([54, 10], [54, 7.2]); L2([54, 10], [55, 16]); L2([50, 10], [50, 10]);
      // buildings & alley
      L2([0, 20.5], [0, 17.5]);
      chain([[16, 20.5], [16, 18.4], [16, 16.5], [16, 14.5], [16, 12.4]]); L2([16, 18.4], [18.5, 18.6]);
      L2([-20.5, 20.5], [-20.5, 18.6]);
      chain([[-7, 20.5], [-7, 17], [-7, 6.2], [0, 6.2], [8.5, 6.2], [8.5, 17], [8.5, 20.5]]);
      L2([0, 6.2], [2, 4.8]); L2([-7, 6.2], [-6, 5.8]);
      L2([-17, 30.5], [-17, 30.4]); L2([-17, 30.5], [-16.5, 30.6]);
      L2([-2, 20.5], [-40, 20.5]);
      houseXs.forEach((cx, i) => {
        const side = cx < 20 ? 30.5 : 30.5;
        L2([cx, side], [cx, 33.5]); L2([cx, 33.5], [cx, 34.3]);
        if (i % 2 === 0) L2([cx, 33.5], [cx + 2.5, 34.5]);
      });
      L2([33, 0], [33, 0]);
      S.nav = { nodes };
      // attach every POI to its nearest node
      for (const p of R.pois) p.node = S.nearestNode(p.x, p.z);
    }
  };

  S.nearestNode = (x, z) => {
    let best = 0, bd = Infinity;
    for (const n of S.nav.nodes) { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; best = n.id; } }
    return best;
  };

  /** A* over the walk graph; returns a list of [x,z]. */
  S.findPath = (fromX, fromZ, toX, toZ) => {
    const nodes = S.nav.nodes, start = S.nearestNode(fromX, fromZ), goal = S.nearestNode(toX, toZ);
    const g = new Map([[start, 0]]), came = new Map(), open = new Set([start]);
    const h = (i) => Math.hypot(nodes[i].x - nodes[goal].x, nodes[i].z - nodes[goal].z);
    const f = new Map([[start, h(start)]]);
    while (open.size) {
      let cur = null, cf = Infinity;
      for (const i of open) if (f.get(i) < cf) { cf = f.get(i); cur = i; }
      if (cur === goal) break;
      open.delete(cur);
      for (const nb of nodes[cur].links) {
        const t = g.get(cur) + Math.hypot(nodes[cur].x - nodes[nb].x, nodes[cur].z - nodes[nb].z);
        if (t < (g.has(nb) ? g.get(nb) : Infinity)) { came.set(nb, cur); g.set(nb, t); f.set(nb, t + h(nb)); open.add(nb); }
      }
    }
    const path = [];
    let c = goal;
    if (c !== start && !came.has(c)) return [[toX, toZ]];
    while (c !== undefined) { path.unshift([nodes[c].x, nodes[c].z]); c = came.get(c); }
    path.push([toX, toZ]);
    return path;
  };

  // ---------------------------------------------------------------- day / night (same curves as DayNightCycle.cs)
  const DAY_SKY = [0.62, 0.78, 0.92], DUSK_SKY = [0.93, 0.6, 0.45], NIGHT_SKY = [0.04, 0.05, 0.1];
  const DAY_L = [0.78, 0.74, 0.66], DUSK_L = [0.75, 0.45, 0.3], NIGHT_L = [0.14, 0.17, 0.26];
  S.applyDayNight = (minuteOfDay, renderer) => {
    const t = minuteOfDay / 1440, angle = (t - 0.25) * Math.PI * 2, el = Math.sin(angle);
    const day = S.smooth(S.invLerp(-0.12, 0.3, el));
    const dusk = S.clamp01(1 - Math.abs(el) / 0.28) * S.clamp01(day * 2 + 0.3);
    const sky = S.mix(S.mix(NIGHT_SKY, DAY_SKY, day), DUSK_SKY, dusk * 0.7);
    const light = S.mix(S.mix(NIGHT_L, DAY_L, day), DUSK_L, dusk * 0.6);
    let dir = new V3(Math.cos(angle) * 0.8, Math.max(0.15, el), 0.35).normalize();
    if (el < -0.05) dir = new V3(-Math.cos(angle) * 0.6, 0.7, -0.3).normalize();
    const U = S.U;
    U.uLightDir.value.copy(dir); U.uLightColor.value.set(...light);
    U.uAmbSky.value.set(...S.mix([0.12, 0.13, 0.2], [0.52, 0.56, 0.62], day));
    U.uAmbGround.value.set(...S.mix([0.07, 0.07, 0.1], [0.36, 0.33, 0.3], day));
    U.uFogColor.value.set(...sky); U.uFogParams.value.set(S.lerp(18, 45, day), S.lerp(95, 170, day), 0.9);
    U.uNightGlow.value = 1 - day;
    U.uIndoorLight.value.set(...S.mix([0.62, 0.56, 0.46], [0.4, 0.4, 0.4], day));
    renderer.setClearColor(new THREE.Color(sky[0], sky[1], sky[2]));
    S.nightAmount = 1 - day;
  };
})();

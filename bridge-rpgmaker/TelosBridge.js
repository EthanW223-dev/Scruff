//=============================================================================
// TelosBridge.js — Telos live bridge for RPG Maker MV and MZ
//=============================================================================
/*:
 * @target MZ MV
 * @plugindesc Lets Telos (the in-game AI overlay) change this game live: gold, items, party, switches, variables, teleporting.
 * @author Telos
 *
 * @param HubUrl
 * @text Telos hub address
 * @desc Where Telos listens for game bridges.
 * @default ws://127.0.0.1:7777/ws/adapter
 *
 * @help
 * Telos installs this plugin by itself (and takes it out again). While the game runs it
 * connects to Telos on this computer only and does what the player asks Telos for. It
 * changes nothing on its own, and does nothing at all when Telos isn't running.
 *
 * Single-player games only.
 */

(function () {
  "use strict";

  var NAME = "TelosBridge";
  var params = (typeof PluginManager !== "undefined" && PluginManager.parameters(NAME)) || {};
  var HUB = String(params.HubUrl || "ws://127.0.0.1:7777/ws/adapter");
  var RETRY_MS = 2000;
  var socket = null;
  var stopped = false;
  var noEncounters = false;

  // ------------------------------------------------------------------ helpers

  function inGame() {
    return typeof $gameParty !== "undefined" && $gameParty && typeof $gamePlayer !== "undefined" && $gamePlayer && $gameMap && $gameMap.mapId() > 0;
  }

  function needGame() {
    if (!inGame()) throw new Error("No game is loaded yet: start a new game or load a save first.");
  }

  function num(v, what) {
    var n = Number(v);
    if (v === undefined || v === null || v === "" || !isFinite(n)) throw new Error(what + " must be a number.");
    return n;
  }

  function lower(s) {
    return String(s == null ? "" : s).toLowerCase();
  }

  /** A database entry (actor, item, map...) by id or by (part of) its name. */
  function pick(list, ref, what) {
    if (ref === undefined || ref === null || ref === "") throw new Error("Say which " + what + " (id or name).");
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      var byId = list[Number(ref)];
      if (byId) return byId;
      throw new Error("No " + what + " with id " + ref + ".");
    }
    var want = lower(ref).trim();
    var exact = null;
    var partial = [];
    for (var i = 1; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.name) continue;
      if (lower(e.name) === want) exact = exact || e;
      else if (lower(e.name).indexOf(want) >= 0) partial.push(e);
    }
    if (exact) return exact;
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error("Several " + what + "s match \"" + ref + "\": " + partial.slice(0, 8).map(function (e) { return e.name + " (" + e.id + ")"; }).join(", ") + ".");
    }
    throw new Error("No " + what + " called \"" + ref + "\".");
  }

  /** Switch/variable ids by number or by the name the developer gave them. */
  function nameIndex(names, ref, what) {
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      var id = Number(ref);
      if (id > 0 && id < names.length) return id;
      throw new Error("No " + what + " " + ref + " (there are " + (names.length - 1) + ").");
    }
    var want = lower(ref).trim();
    var hits = [];
    for (var i = 1; i < names.length; i++) {
      if (lower(names[i]) === want) return i;
      if (names[i] && lower(names[i]).indexOf(want) >= 0) hits.push(i);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error("Several " + what + "s match \"" + ref + "\": " + hits.slice(0, 8).map(function (i) { return names[i] + " (" + i + ")"; }).join(", ") + ".");
    throw new Error("No " + what + " called \"" + ref + "\".");
  }

  function itemList(kind) {
    var k = lower(kind || "item");
    if (k === "weapon" || k === "weapons") return { list: $dataWeapons, what: "weapon" };
    if (k === "armor" || k === "armors" || k === "armour") return { list: $dataArmors, what: "armor" };
    return { list: $dataItems, what: "item" };
  }

  function actorRef(ref) {
    needGame();
    if (ref === undefined || ref === null || ref === "") {
      var lead = $gameParty.leader();
      if (!lead) throw new Error("The party is empty.");
      return lead;
    }
    var data = pick($dataActors, ref, "actor");
    return $gameActors.actor(data.id);
  }

  function describeActor(a) {
    return { id: a.actorId(), name: a.name(), level: a.level, hp: a.hp, mhp: a.mhp, mp: a.mp, mmp: a.mmp, tp: a.tp, exp: a.currentExp() };
  }

  function mapName(id) {
    var info = typeof $dataMapInfos !== "undefined" && $dataMapInfos && $dataMapInfos[id];
    return (info && info.name) || ("Map " + id);
  }

  var PARAMS = { mhp: 0, maxhp: 0, mmp: 1, maxmp: 1, atk: 2, attack: 2, def: 3, defense: 3, mat: 4, magic: 4, mdf: 5, agi: 6, agility: 6, speed: 6, luk: 7, luck: 7 };

  // ------------------------------------------------------------------ tools

  function S(props, required) {
    return { type: "object", properties: props, required: required || [] };
  }

  var TOOLS = [
    {
      name: "status",
      description: "Start here: gold, the party (HP, MP, level of each member), where the player is, steps, play time.",
      input_schema: S({}),
      run: function () {
        needGame();
        return {
          game: $dataSystem.gameTitle,
          gold: $gameParty.gold(),
          currency: $dataSystem.currencyUnit,
          party: $gameParty.members().map(describeActor),
          map: { id: $gameMap.mapId(), name: $gameMap.displayName() || mapName($gameMap.mapId()), x: $gamePlayer.x, y: $gamePlayer.y },
          steps: $gameParty.steps(),
          playtime: $gameSystem.playtimeText(),
          in_battle: $gameParty.inBattle(),
          encounters: !noEncounters,
        };
      },
    },
    {
      name: "read",
      description: "One number, for watching (game links): gold, steps, or an actor's hp/mp/tp/level/exp, a variable's value, or how many of an item the party has.",
      input_schema: S({
        what: { type: "string", description: "gold, steps, hp, mp, tp, level, exp, variable, item, weapon or armor" },
        actor: { description: "For hp/mp/tp/level/exp: actor id or name (default the party leader)" },
        id: { description: "For variable/item/weapon/armor: its id or name" },
      }, ["what"]),
      run: function (a) {
        needGame();
        var w = lower(a.what);
        if (w === "gold" || w === "money") return { value: $gameParty.gold() };
        if (w === "steps") return { value: $gameParty.steps() };
        if (w === "variable") return { value: $gameVariables.value(nameIndex($dataSystem.variables, a.id, "variable")) };
        if (w === "item" || w === "weapon" || w === "armor") {
          var l = itemList(w);
          return { value: $gameParty.numItems(pick(l.list, a.id, l.what)) };
        }
        var actor = actorRef(a.actor);
        if (w === "exp") return { value: actor.currentExp() };
        if (w === "hp" || w === "mp" || w === "tp" || w === "level") return { value: actor[w] };
        throw new Error("Can't read \"" + a.what + "\": use gold, steps, hp, mp, tp, level, exp, variable, item, weapon or armor.");
      },
    },
    {
      name: "gold",
      description: "Set or add to the party's gold (money). Returns before and after.",
      input_schema: S({ set: { type: "number" }, add: { type: "number", description: "Negative takes gold away" } }),
      run: function (a) {
        needGame();
        var before = $gameParty.gold();
        if (a.set !== undefined) $gameParty.gainGold(num(a.set, "set") - before);
        else if (a.add !== undefined) $gameParty.gainGold(num(a.add, "add"));
        return { before: before, after: $gameParty.gold(), max: $gameParty.maxGold() };
      },
    },
    {
      name: "items",
      description: "Search the game's items, weapons and armor by name: ids, descriptions, prices and how many the party has.",
      input_schema: S({ query: { type: "string", description: "Part of the name; empty lists what the party carries" }, limit: { type: "integer" } }),
      run: function (a) {
        needGame();
        var q = lower(a.query).trim();
        var limit = Math.min(Number(a.limit) || 30, 100);
        var out = [];
        var kinds = [["item", $dataItems], ["weapon", $dataWeapons], ["armor", $dataArmors]];
        for (var k = 0; k < kinds.length && out.length < limit; k++) {
          var list = kinds[k][1];
          for (var i = 1; i < list.length && out.length < limit; i++) {
            var e = list[i];
            if (!e || !e.name) continue;
            var have = $gameParty.numItems(e);
            if (q ? lower(e.name).indexOf(q) < 0 : have === 0) continue;
            out.push({ kind: kinds[k][0], id: e.id, name: e.name, have: have, price: e.price, description: e.description });
          }
        }
        return out.length ? out : (q ? "Nothing called \"" + a.query + "\"." : "The party carries nothing.");
      },
    },
    {
      name: "give",
      description: "Give the party items, weapons or armor (a negative count takes them away).",
      input_schema: S({
        item: { description: "Item id or name" },
        kind: { type: "string", description: "item (default), weapon or armor" },
        count: { type: "integer", description: "Default 1" },
      }, ["item"]),
      run: function (a) {
        needGame();
        var l = itemList(a.kind);
        var entry = pick(l.list, a.item, l.what);
        var before = $gameParty.numItems(entry);
        $gameParty.gainItem(entry, a.count === undefined ? 1 : num(a.count, "count"), false);
        return { item: entry.name, before: before, after: $gameParty.numItems(entry), max: $gameParty.maxItems(entry) };
      },
    },
    {
      name: "actor",
      description:
        "Change a party member (default the leader): hp, mp, tp, level, exp; raise stats for good with add_param " +
        "(mhp, mmp, atk, def, mat, mdf, agi, luk); recover fully. Give nothing to just read them.",
      input_schema: S({
        actor: { description: "Actor id or name (default the party leader)" },
        hp: { type: "number" }, mp: { type: "number" }, tp: { type: "number" }, level: { type: "integer" }, exp: { type: "integer" },
        add_param: { type: "object", description: "e.g. {\"atk\": 50, \"mhp\": 500}" },
        recover_all: { type: "boolean" },
      }),
      run: function (a) {
        var actor = actorRef(a.actor);
        var before = describeActor(actor);
        if (a.add_param && typeof a.add_param === "object") {
          for (var key in a.add_param) {
            var id = PARAMS[lower(key)];
            if (id === undefined) throw new Error("Unknown stat \"" + key + "\": use mhp, mmp, atk, def, mat, mdf, agi or luk.");
            actor.addParam(id, num(a.add_param[key], key));
          }
        }
        if (a.level !== undefined) actor.changeLevel(Math.max(1, Math.min(num(a.level, "level"), actor.maxLevel())), false);
        if (a.exp !== undefined) actor.changeExp(num(a.exp, "exp"), false);
        if (a.recover_all) actor.recoverAll();
        if (a.hp !== undefined) actor.setHp(num(a.hp, "hp"));
        if (a.mp !== undefined) actor.setMp(num(a.mp, "mp"));
        if (a.tp !== undefined) actor.setTp(num(a.tp, "tp"));
        return { before: before, after: describeActor(actor) };
      },
    },
    {
      name: "heal_party",
      description: "Fully heal the whole party (HP, MP, states).",
      input_schema: S({}),
      run: function () {
        needGame();
        $gameParty.members().forEach(function (m) { m.recoverAll(); });
        return { party: $gameParty.members().map(describeActor) };
      },
    },
    {
      name: "party",
      description: "Add someone to the party or remove them (by actor id or name), or list who could join.",
      input_schema: S({ add: { description: "Actor id or name" }, remove: { description: "Actor id or name" } }),
      run: function (a) {
        needGame();
        if (a.add !== undefined) $gameParty.addActor(pick($dataActors, a.add, "actor").id);
        if (a.remove !== undefined) $gameParty.removeActor(pick($dataActors, a.remove, "actor").id);
        var all = [];
        for (var i = 1; i < $dataActors.length; i++) if ($dataActors[i] && $dataActors[i].name) all.push({ id: i, name: $dataActors[i].name });
        return { party: $gameParty.members().map(function (m) { return m.name(); }), everyone: all };
      },
    },
    {
      name: "switch",
      description: "Read or flip a game switch (story flags, doors, events) by id or by the name the developer gave it. Give a query to search them.",
      input_schema: S({ id: { description: "Switch id or name" }, value: { type: "boolean" }, query: { type: "string", description: "Search switch names" } }),
      run: function (a) {
        needGame();
        if (a.query !== undefined) return search($dataSystem.switches, a.query, function (i) { return $gameSwitches.value(i); });
        var id = nameIndex($dataSystem.switches, a.id, "switch");
        var before = $gameSwitches.value(id);
        if (a.value !== undefined) $gameSwitches.setValue(id, Boolean(a.value));
        return { id: id, name: $dataSystem.switches[id], before: before, after: $gameSwitches.value(id) };
      },
    },
    {
      name: "variable",
      description: "Read, set or add to a game variable by id or name. Give a query to search them.",
      input_schema: S({ id: { description: "Variable id or name" }, set: {}, add: { type: "number" }, query: { type: "string", description: "Search variable names" } }),
      run: function (a) {
        needGame();
        if (a.query !== undefined) return search($dataSystem.variables, a.query, function (i) { return $gameVariables.value(i); });
        var id = nameIndex($dataSystem.variables, a.id, "variable");
        var before = $gameVariables.value(id);
        if (a.set !== undefined) $gameVariables.setValue(id, a.set);
        else if (a.add !== undefined) $gameVariables.setValue(id, Number(before) + num(a.add, "add"));
        return { id: id, name: $dataSystem.variables[id], before: before, after: $gameVariables.value(id) };
      },
    },
    {
      name: "teleport",
      description: "Move the player: to x,y on this map, or to another map (by id or name). Give no map to stay on this one.",
      input_schema: S({ map: { description: "Map id or name" }, x: { type: "integer" }, y: { type: "integer" }, direction: { type: "integer", description: "2 down, 4 left, 6 right, 8 up" } }, ["x", "y"]),
      run: function (a) {
        needGame();
        var mapId = $gameMap.mapId();
        if (a.map !== undefined && a.map !== "") {
          if (typeof a.map === "number" || /^\d+$/.test(String(a.map))) mapId = Number(a.map);
          else mapId = pick($dataMapInfos, a.map, "map").id;
        }
        $gamePlayer.reserveTransfer(mapId, num(a.x, "x"), num(a.y, "y"), a.direction || 0, 0);
        return { to: { map: mapId, name: mapName(mapId), x: a.x, y: a.y } };
      },
    },
    {
      name: "player",
      description: "Walking speed (1 slowest .. 4 normal .. 6 fastest), walking through walls, and random encounters on or off.",
      input_schema: S({ speed: { type: "number" }, through_walls: { type: "boolean" }, encounters: { type: "boolean" } }),
      run: function (a) {
        needGame();
        if (a.speed !== undefined) $gamePlayer.setMoveSpeed(Math.max(1, Math.min(num(a.speed, "speed"), 6)));
        if (a.through_walls !== undefined) $gamePlayer.setThrough(Boolean(a.through_walls));
        if (a.encounters !== undefined) noEncounters = !a.encounters;
        return { speed: $gamePlayer.moveSpeed(), through_walls: $gamePlayer.isThrough(), encounters: !noEncounters };
      },
    },
    {
      name: "common_event",
      description: "Run one of the game's common events (by id or name), the way the game itself would.",
      input_schema: S({ id: { description: "Common event id or name" } }, ["id"]),
      run: function (a) {
        needGame();
        var ev = pick($dataCommonEvents, a.id, "common event");
        $gameTemp.reserveCommonEvent(ev.id);
        return { running: ev.name || ("Common event " + ev.id) };
      },
    },
  ];

  function search(names, query, value) {
    var q = lower(query).trim();
    var out = [];
    for (var i = 1; i < names.length && out.length < 40; i++) {
      if (names[i] && lower(names[i]).indexOf(q) >= 0) out.push({ id: i, name: names[i], value: value(i) });
    }
    return out.length ? out : "Nothing matches \"" + query + "\".";
  }

  // ------------------------------------------------------------------ game events

  function send(msg) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
  }

  function event(text) {
    send({ type: "event", text: text });
  }

  function alias(proto, method, after) {
    if (!proto || typeof proto[method] !== "function") return;
    var original = proto[method];
    proto[method] = function () {
      var result = original.apply(this, arguments);
      try { after.call(this, result); } catch (e) { /* never break the game */ }
      return result;
    };
  }

  if (typeof Game_Player !== "undefined") {
    var canEncounter = Game_Player.prototype.canEncounter;
    Game_Player.prototype.canEncounter = function () {
      return !noEncounters && canEncounter.apply(this, arguments);
    };
    alias(Game_Player.prototype, "performTransfer", function () {
      event("Map changed: " + ($gameMap.displayName() || mapName($gameMap.mapId())));
    });
  }
  if (typeof BattleManager !== "undefined") {
    alias(BattleManager, "processVictory", function () { event("Battle won"); });
    alias(BattleManager, "processDefeat", function () { event("Battle lost"); });
    alias(BattleManager, "startBattle", function () { event("Battle started"); });
  }
  if (typeof Game_Party !== "undefined") {
    alias(Game_Party.prototype, "gainGold", function () {
      if (this === $gameParty) event("Gold is now " + this.gold());
    });
  }

  // ------------------------------------------------------------------ connection

  function hello() {
    var title = (typeof $dataSystem !== "undefined" && $dataSystem && $dataSystem.gameTitle) || (typeof document !== "undefined" && document.title) || "RPG Maker game";
    return {
      type: "hello",
      name: "RPG Maker bridge: " + title,
      game: "rpgmaker",
      description:
        "Live access inside " + title + ": gold, items/weapons/armor, the party's HP/MP/levels/stats, switches and " +
        "variables (by name), teleporting, walking speed, walking through walls, random encounters, common events.",
      tools: TOOLS.map(function (t) { return { name: t.name, description: t.description, input_schema: t.input_schema }; }),
    };
  }

  function onCall(msg) {
    var reply = { type: "result", id: msg.id };
    var tool = null;
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === msg.tool) tool = TOOLS[i];
    try {
      if (!tool) throw new Error("No tool " + msg.tool);
      reply.content = tool.run(msg.input || {});
      reply.ok = true;
    } catch (e) {
      reply.ok = false;
      reply.error = (e && e.message) || String(e);
    }
    send(reply);
  }

  function connect() {
    if (stopped || typeof WebSocket === "undefined") return;
    var ws;
    try {
      ws = new WebSocket(HUB);
    } catch (e) {
      setTimeout(connect, RETRY_MS);
      return;
    }
    socket = ws;
    ws.onopen = function () {
      // The database loads right after start: wait for its title so Telos knows which game this is.
      var tries = 0;
      (function greet() {
        if (socket !== ws) return;
        if ((typeof $dataSystem === "undefined" || !$dataSystem) && tries++ < 50) return setTimeout(greet, 100);
        ws.send(JSON.stringify(hello()));
      })();
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg && msg.type === "call") onCall(msg);
    };
    ws.onclose = function () {
      if (socket === ws) socket = null;
      setTimeout(connect, RETRY_MS);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  connect();

  // For Telos's tests; harmless in the game.
  if (typeof window !== "undefined") {
    window.TelosBridge = {
      tools: TOOLS,
      hub: HUB,
      stop: function () {
        stopped = true;
        if (socket) socket.close();
      },
    };
  }
})();

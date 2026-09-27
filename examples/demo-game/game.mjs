#!/usr/bin/env node
// Scruff's Dungeon: a tiny terminal game to practise live-modding on.
//
//   npm run demo-game             play it (keys shown on screen)
//   npm run demo-game -- --headless   no UI; reads commands from stdin (used by the tests)
//
// Gold and health live in raw memory exactly like a real game's would, so Scruff's memory
// scanner can find and change them. If the Scruff hub is running, the game also connects as a
// game adapter and gives Claude a few extra powers (spawn gold, change the weather, ...).

import WebSocket from "ws";

process.title = "Scruff's Dungeon"; // what shows up in Scruff's game picker
const HUB = process.env.SCRUFF_ADAPTER_URL ?? "ws://127.0.0.1:7777/ws/adapter";
const headless = process.argv.includes("--headless");

// Off-heap buffer (> 64 bytes, so V8 never moves it): the "game memory".
const memory = new ArrayBuffer(4096);
const gold = new Int32Array(memory, 256, 1);
const health = new Float32Array(memory, 512, 1);
const maxHealth = new Float32Array(memory, 516, 1);
const potions = new Int32Array(memory, 1024, 1);

gold[0] = 350;
health[0] = 100;
maxHealth[0] = 100;
potions[0] = 2;

const state = { name: "Hero", weather: "sunny", enemy: null, log: [] };
const ENEMIES = { goblin: { hp: 20, hit: 8, loot: 30 }, skeleton: { hp: 35, hit: 12, loot: 55 }, dragon: { hp: 120, hit: 30, loot: 400 } };
const WEATHER = ["sunny", "rain", "storm", "snow"];

function say(line) {
  state.log.push(line);
  if (state.log.length > 6) state.log.shift();
  if (headless) console.error(line);
  adapter.event(line);
}

function spawn(kind) {
  const base = ENEMIES[kind];
  state.enemy = { kind, hp: base.hp };
  say(`A ${kind} appears!`);
}

function fight() {
  if (!state.enemy) spawn(Math.random() < 0.7 ? "goblin" : "skeleton");
  const enemy = state.enemy;
  const stats = ENEMIES[enemy.kind];
  enemy.hp -= 10 + Math.floor(Math.random() * 8);
  const stormBonus = state.weather === "storm" ? 1.5 : 1;
  const damage = stats.hit * (0.6 + Math.random() * 0.8) * stormBonus;
  health[0] = Math.max(0, health[0] - damage);
  say(`You hit the ${enemy.kind}. It hits back for ${damage.toFixed(1)}.`);
  if (enemy.hp <= 0) {
    gold[0] += stats.loot;
    say(`The ${enemy.kind} is defeated! +${stats.loot} gold.`);
    state.enemy = null;
  }
  if (health[0] <= 0) {
    say("You died! Respawning with half your gold.");
    gold[0] = Math.floor(gold[0] / 2);
    health[0] = maxHealth[0];
    state.enemy = null;
  }
}

function buyPotion() {
  if (gold[0] < 25) return say("Not enough gold (potions cost 25).");
  gold[0] -= 25;
  potions[0] += 1;
  say("Bought a potion for 25 gold.");
}

function drinkPotion() {
  if (potions[0] <= 0) return say("No potions left.");
  potions[0] -= 1;
  health[0] = Math.min(maxHealth[0], health[0] + 35);
  say("Glug. +35 health.");
}

function snapshot() {
  return { name: state.name, gold: gold[0], health: health[0], maxHealth: maxHealth[0], potions: potions[0], weather: state.weather, enemy: state.enemy };
}

// --- Scruff game adapter (optional) -----------------------------------------------------------

const adapter = {
  ws: null,
  connected: false,
  connect() {
    const ws = new WebSocket(HUB);
    ws.on("open", () => {
      this.connected = true;
      this.ws = ws;
      ws.send(JSON.stringify({
        type: "hello",
        name: "Scruff's Dungeon",
        game: "demo",
        description: "Terminal demo RPG. Gold is an int32 and health is a float in memory.",
        tools: [
          { name: "get_state", description: "Current player stats, weather and enemy.", input_schema: { type: "object", properties: {} } },
          { name: "spawn_gold", description: "Drop gold into the player's purse.", input_schema: { type: "object", properties: { amount: { type: "integer", minimum: 1 } }, required: ["amount"] } },
          { name: "spawn_enemy", description: "Summon an enemy to fight.", input_schema: { type: "object", properties: { kind: { type: "string", enum: Object.keys(ENEMIES) } }, required: ["kind"] } },
          { name: "set_weather", description: "Change the weather. Storms make enemies hit 50% harder.", input_schema: { type: "object", properties: { weather: { type: "string", enum: WEATHER } }, required: ["weather"] } },
          { name: "rename_player", description: "Change the hero's name.", input_schema: { type: "object", properties: { name: { type: "string", maxLength: 24 } }, required: ["name"] } },
        ],
      }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== "call") return;
      const reply = (content, ok = true) => ws.send(JSON.stringify({ type: "result", id: msg.id, ok, ...(ok ? { content } : { error: content }) }));
      const input = msg.input ?? {};
      switch (msg.tool) {
        case "get_state":
          return reply(snapshot());
        case "spawn_gold":
          gold[0] += Math.max(1, Math.floor(input.amount));
          say(`${input.amount} gold rains from the sky!`);
          return reply(`Gold is now ${gold[0]}.`);
        case "spawn_enemy":
          if (!ENEMIES[input.kind]) return reply(`Unknown enemy ${input.kind}.`, false);
          spawn(input.kind);
          return reply(`Spawned a ${input.kind}.`);
        case "set_weather":
          if (!WEATHER.includes(input.weather)) return reply(`Unknown weather ${input.weather}.`, false);
          state.weather = input.weather;
          say(`The weather turns to ${input.weather}.`);
          return reply(`Weather is now ${input.weather}.`);
        case "rename_player":
          state.name = String(input.name).slice(0, 24);
          return reply(`The hero is now called ${state.name}.`);
        default:
          return reply(`Unknown tool ${msg.tool}.`, false);
      }
    });
    ws.on("close", () => {
      this.connected = false;
      this.ws = null;
      setTimeout(() => this.connect(), 3000).unref();
    });
    ws.on("error", () => {}); // hub not running yet; "close" retries
  },
  event(text) {
    if (this.connected) this.ws.send(JSON.stringify({ type: "event", text }));
  },
};
if (!process.argv.includes("--offline")) adapter.connect();

// --- Headless mode (tests) --------------------------------------------------------------------

if (headless) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  console.log(JSON.stringify({ ready: true, pid: process.pid, ...snapshot() }));
  rl.on("line", (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd === "spend") gold[0] -= Number(arg);
    else if (cmd === "earn") gold[0] += Number(arg);
    else if (cmd === "damage") health[0] -= Number(arg);
    else if (cmd === "fight") fight();
    else if (cmd === "quit") process.exit(0);
    console.log(JSON.stringify(snapshot()));
  });
  rl.on("close", () => process.exit(0));
} else {
  // --- Interactive mode ----------------------------------------------------------------------
  const bar = (v, max, width = 24) => {
    const filled = Math.round((Math.max(0, v) / max) * width);
    return "█".repeat(Math.min(width, filled)) + "░".repeat(Math.max(0, width - filled));
  };
  const render = () => {
    const s = snapshot();
    const out = [
      "\x1b[2J\x1b[H\x1b[1m  SCRUFF'S DUNGEON\x1b[0m   (pid " + process.pid + ")",
      "",
      `  ${s.name}`,
      `  Health  ${bar(s.health, s.maxHealth)}  ${Math.floor(s.health)} / ${Math.floor(s.maxHealth)}`,
      `  Gold    ${s.gold}`,
      `  Potions ${s.potions}`,
      `  Weather ${s.weather}${s.enemy ? `     Enemy: ${s.enemy.kind} (${Math.max(0, s.enemy.hp)} hp)` : ""}`,
      "",
      ...state.log.map((l) => "  " + l),
      "",
      "  [f] fight   [b] buy potion (25g)   [d] drink potion   [q] quit",
      `  Scruff: ${adapter.connected ? "\x1b[32mconnected as a game adapter\x1b[0m" : "not connected (start it with `npm start`)"}`,
    ];
    process.stdout.write(out.join("\n") + "\n");
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (key) => {
    const k = String(key);
    if (k === "q" || k === "\u0003") process.exit(0);
    if (k === "f") fight();
    if (k === "b") buyPotion();
    if (k === "d") drinkPotion();
    render();
  });
  setInterval(render, 250);
  render();
}

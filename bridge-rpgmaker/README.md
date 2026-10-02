# Telos RPG Maker bridge

`TelosBridge.js` is an ordinary RPG Maker MV/MZ plugin. RPG Maker games are HTML5 (NW.js) and
load every plugin listed in `js/plugins.js`, so no mod loader is needed: Telos copies the file to
`js/plugins/` (`www/js/plugins/` for MV) and adds one entry to that list. In the game the plugin
connects to Telos over a local WebSocket (`ws://127.0.0.1:7777/ws/adapter`, set in the entry's
`HubUrl` parameter) and shows up as the `rpgmaker` game adapter once a game is started or loaded.

| Tool | What it does |
| --- | --- |
| `status` | Gold, the party (HP, MP, level), where the player is, steps, play time |
| `read` | One number for game links: gold, steps, an actor's hp/mp/tp/level/exp, a variable, how many of an item |
| `gold` | Set or add gold |
| `items` / `give` | Search items, weapons and armor by name; give or take them |
| `actor` | A party member's HP, MP, TP, level, exp; raise stats for good; full recovery |
| `heal_party` / `party` | Heal everyone; add or remove party members |
| `switch` / `variable` | Story flags and variables, by id or by the developer's names |
| `teleport` | To x, y on this map or another (by id or name) |
| `player` | Walking speed, walking through walls, random encounters on or off |
| `common_event` | Run one of the game's common events |

It also tells Telos when gold changes, the map changes and battles start or end, which game
links can react to.

**Remove** takes out the file and the plugin entry only. Plugins the player added or changed
since then stay as they are. Games packed into a single exe have no `js/plugins.js`, so they
can't take plugins. Telos says so, and memory editing still works.

Not yet tried inside a real RPG Maker game: it's tested in Node against stand-ins for the RPG
Maker objects it uses (`test/rpgmaker-bridge.test.ts`).

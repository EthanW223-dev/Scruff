# Game adapters

Memory editing works on almost any single-player game, but it can only change numbers that
already exist. A **game adapter** is a small plugin that runs inside (or next to) one specific
game and gives the AI real powers there: spawn items, change physics, run console commands,
read the game's state directly.

Adapters connect to the Scruff hub over a WebSocket. Any language that can open a WebSocket
and send JSON can be an adapter.

## Protocol

Connect to `ws://127.0.0.1:7777/ws/adapter` (connections from other machines need
`?token=…` from the hub's `--lan` output).

### 1. Say hello

```json
{
  "type": "hello",
  "name": "Skyrim Console",
  "game": "skyrim",
  "description": "Runs Skyrim console commands through SKSE.",
  "tools": [
    {
      "name": "add_item",
      "description": "Give the player an item by form id.",
      "input_schema": {
        "type": "object",
        "properties": {
          "form_id": { "type": "string" },
          "count": { "type": "integer", "minimum": 1 }
        },
        "required": ["form_id"]
      }
    }
  ]
}
```

- `game` becomes the tool prefix the AI sees (`skyrim__add_item`).
- Tool names: letters, digits, `_` and `-`, up to 36 characters.
- `input_schema` is JSON Schema. The AI reads it to know what to send.

The hub answers `{"type": "welcome", "id": 1, "prefix": "skyrim"}`.

### 2. Handle calls

```json
{ "type": "call", "id": "7", "tool": "add_item", "input": { "form_id": "f", "count": 500 } }
```

Reply with the same `id`:

```json
{ "type": "result", "id": "7", "ok": true, "content": "Added 500 gold." }
{ "type": "result", "id": "7", "ok": false, "error": "No such item." }
```

`content` can be a string or any JSON value. Answer within 30 seconds. If the user presses
Stop, the hub sends `{"type": "cancel", "id": "7"}`; you can ignore it.

### 3. Optional: report game events

```json
{ "type": "event", "text": "Player died to a dragon." }
```

Events show up in the dashboard and are passed to the AI with the player's next message, so it
can react ("you keep dying to that dragon, want me to make you tougher?").

### 4. Optional: change your tools

Send `{"type": "tools", "tools": [...]}` at any time (for example after a level loads).

## How the AI sees adapters

The tool list sent to Claude never changes during a conversation (that keeps the prompt cache
warm and avoids invalidating earlier reasoning). Instead, every adapter tool is reached through
one built-in tool, `use_game_adapter`, and the list of connected adapters with their schemas is
included in a status note whenever it changes. You don't need to do anything special for this.

## Minimal adapter (Node.js)

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:7777/ws/adapter");
ws.on("open", () =>
  ws.send(JSON.stringify({
    type: "hello",
    name: "My Game",
    game: "mygame",
    tools: [{ name: "set_gravity", description: "Set gravity in m/s²", input_schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }],
  })),
);
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type !== "call") return;
  if (msg.tool === "set_gravity") {
    game.physics.gravity = msg.input.value; // your game's API
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, content: `Gravity is ${msg.input.value}` }));
  }
});
```

[`examples/demo-game/game.mjs`](../examples/demo-game/game.mjs) is a complete working adapter.

## Where adapters fit for real games

Adapters have to be written per game or per engine. Good places to hook in:

| Game or engine | How to get code running in it | Ideas for tools |
| --- | --- | --- |
| Unity games (Mono) | **Built in:** Scruff's Unity bridge ([bridge/](../bridge/README.md)), installed from the Game files panel | Find objects, read/set any field, call methods, recolor, resize, spawn, gravity, levels |
| Unity games (IL2CPP) | A BepInEx 6 plugin (Il2CppInterop) with a WebSocket client | The same, once someone ports the bridge |
| Unreal Engine 4/5 games | A [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) Lua mod | Read/write UObject properties, call UFunctions, summon actors |
| Skyrim, Fallout (Creation Engine) | SKSE/F4SE plugin, or type into the built-in console | `player.additem`, `tgm`, `setav` |
| Minecraft (Java) | A Fabric or Forge mod, or RCON on a local server | Give items, set time/weather, spawn mobs |
| Source games (Half-Life 2, Portal) | Send console commands (`sv_cheats 1`) | `impulse 101`, `god`, `noclip` |
| Games with Lua mod APIs (Factorio, Garry's Mod in single-player) | The game's own mod API | Anything the mod API allows |

Keep adapters to single-player games and offline modes.

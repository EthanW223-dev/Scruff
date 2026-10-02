# Telos UE4SS bridge (Unreal Engine games)

`TelosBridge/` is a [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) Lua mod. UE4SS is the Unreal
community's mod loader. **The player installs UE4SS** by extracting its release next to the
game's exe in `Binaries/Win64`; Telos never installs it. Once the game has it, Telos adds
`Mods/TelosBridge/` and one line in `Mods/mods.txt`. Removing takes out exactly that, and UE4SS
stays.

UE4SS's Lua has no network access, so the mod and Telos talk through files in
`TelosBridge/relay/`:

| File | Written by | |
| --- | --- | --- |
| `alive.json` | the mod, every second | its tools and recent game events; Telos treats the game as connected while it's fresh |
| `request.json` | Telos | one call at a time: `{key, id, tool, input}` |
| `response.json` | the mod | `{key, id, ok, content \| error}` |

Both sides write to a temporary file and rename it, so neither reads half a file. A request left
over from an earlier session doesn't run again when the game starts. Everything that touches the
game runs on the game thread (`ExecuteInGameThread`).

| Tool | What it does |
| --- | --- |
| `player` | The player's character and controller, and where it is |
| `find` | Objects by part of their name and/or class |
| `inspect` | An object's properties, own and inherited, with types and values |
| `get` / `set` | Any property: numbers, true/false, text, `[x,y,z]` vectors |
| `call` | An object's functions, with arguments |
| `teleport` | Move the player or an object |
| `world` | Game speed (time dilation) and gravity |
| `console` | Unreal console commands (cheat commands only if the game kept them) |

In Telos it shows up as the `unreal` adapter, named `UE4SS bridge: <game>`.

Not yet tried inside a real Unreal game. The mod is tested under Lua 5.4 with a stand-in for
UE4SS's API (`test/fixtures/ue4ss/harness.lua`, `test/ue4ss-bridge.test.ts`). First use on a
game should confirm one harmless change on screen.

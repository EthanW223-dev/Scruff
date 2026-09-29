# Scruff Unity bridge

A [BepInEx 5](https://github.com/BepInEx/BepInEx) plugin that lets Scruff change anything in a
Unity game built with Mono, live: not just numbers, but any object, field, property and method.

Scruff installs it for you: attach to a Unity game, then click **install** next to *Bridge* in the
Game files panel (or ask the AI). That adds BepInEx and `ScruffBridge.dll` to the game folder and
records every file it added in `.scruff-bridge.json`, so **remove** takes out exactly that. Restart
the game once; the bridge connects to Scruff on its own and shows up as the `unity` game adapter.

## What the AI can do with it

| Tool | What it does |
| --- | --- |
| `find` | Objects by name, component type or tag (also inactive ones and prefabs) |
| `inspect` | One object: transform, children, every component with its fields and properties (private too) |
| `get` / `set` | Any field or property by dotted path (`stats.maxHealth`, `items[2].count`), on an object or static (`GameManager` + `Instance.money`). Numbers, text, true/false, enum names, vectors, colors |
| `call` | The game's own methods (`AddItem("soup", 5)`, `Heal(100)`); coroutines are started |
| `types` | The game's classes by name: static values, methods, live instances |
| `transform` | Move, rotate, resize |
| `color` | Recolor sprites, UI, lights, text and 3D materials |
| `copy_look` | Make one object look like another: sprites, meshes, materials, animations |
| `spawn` | Copies of an object or prefab, next to it or next to the player |
| `set_active` / `destroy` | Hide, show or remove objects |
| `world` | Time scale, 3D and 2D gravity |
| `scenes` | List levels and load one |

Changes through the bridge aren't in Scruff's undo list; `set` returns the old value so the AI can
put it back.

## Build

`npm run build:bridge` (needs Mono's C# compiler: `apt install mono-mcs`). It compiles `src/*.cs`
against .NET 3.5, Unity 5.6 and BepInEx 5.4 reference assemblies from NuGet, so the one DLL loads
in any Mono Unity game from Unity 5 on. The built `ScruffBridge.dll` is checked in, so players
don't need a compiler.

- `Json.cs`, `WebSocketClient.cs`: JSON and a small WebSocket client (.NET 3.5 has neither).
- `Reflect.cs`: reads, changes and calls anything by name and path, and converts JSON to the
  game's types. It knows Unity types only by name, so `npm test` runs it under Mono against a real
  Scruff hub (`test/unity-bridge.test.ts`).
- `UnityTools.cs`, `Plugin.cs`: the tools, and the plugin that connects and runs calls on Unity's
  main thread.

## Limits

- Mono Unity games only. IL2CPP games (no `Managed` folder, a `GameAssembly.dll` instead) need
  BepInEx 6 and aren't supported yet.
- Single-player only, like the rest of Scruff.
- Installing sets `Application.runInBackground`, so the game keeps running while you type in the
  overlay.

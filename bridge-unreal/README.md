# Scruff Unreal bridge (scaffold — experimental, untested)

A Scruff game adapter for Unreal Engine 4.25+ / 5.x games, mirroring the Unity bridge's
adapter protocol so the hub treats every engine the same: `find`, `get`, `set`, `call`,
`spawn`, `world` (time dilation, gravity).

## Honest status

This is a scaffold, not a working bridge. It compiles to a DLL; it has NOT been tested
against a real game. Unreal has no stable ABI between versions, so the two things that
must be verified per game before this does anything are:

1. **The `GObjects` pattern** in `src/patterns.h`. The candidates listed there are the
   well-known public signatures, but they drift between engine versions. Verify with a
   debugger (x64dbg/Cheat Engine): the resolved pointer must point at an `FUObjectArray`
   whose first entries are valid `UObject`s (vtable inside the game module).
2. **Property offsets**: property access goes through the engine's own reflection
   (`FindFProperty` + `FProperty::GetValue_InContainer`), which is version-stable, but
   the `FName`/`TUObjectArray` layouts in `src/ue.h` assume UE 4.25+.

## How it works

- `dllmain.cpp`: entry point. Spawns a worker thread (never touches the game thread
  except through queued calls), finds `GObjects`, connects to the hub.
- `ue.cpp`: pattern scanner, `GObjects` walker, `UObject`/`UClass`/`FProperty` helpers.
- `adapter.cpp`: minimal WinHTTP WebSocket client speaking the adapter protocol from
  `docs/ADAPTERS.md`, and the tool implementations.

## Building

Visual Studio 2022, x64, C++17. Link `winhttp.lib`. Inject the resulting
`ScruffUnrealBridge.dll` into the game (any injector; the game must be running).

## Testing checklist (do this before claiming it works)

- [ ] `find` returns the player pawn and named actors in a real UE game
- [ ] `get` reads a float property (e.g. health) and matches the HUD
- [ ] `set` changes it and the game visibly reacts
- [ ] `world` time dilation slows the game
- [ ] No crash on level change (GObjects reallocates; the walker re-resolves)

Until every box is ticked, the hub reports Unreal as "numbers only" (see
`src/hub/mods.ts`): memory editing works, structural mods don't, and Scruff says so.

# Telos Unreal bridge (experimental — compile-validated, untested vs real games)

A Telos game adapter for Unreal Engine 4.25+ / 5.x games, mirroring the Unity bridge's
adapter protocol so the hub treats every engine the same.

## Honest status

It compiles to a DLL with MinGW-w64, and the JSON protocol layer is unit-tested on the
host. It has NOT been tested against a real Unreal game. Unreal has no stable ABI
between versions, so before this does anything in a specific game, verify per game:

1. **The `GObjects` pattern** in `src/ue.cpp`. The candidates are the well-known public
   signatures, but they drift between engine versions. A pattern that resolves but
   fails validation is skipped, never trusted — the bridge then reports structural
   tools as unavailable instead of crashing.
2. **The `GNames` pattern** (same file). UE4's `TNameEntryArray` path is the
   well-documented one; the UE5 `FNamePool` path is best-effort until verified.
   Validation requires entry 0 to read `"None"`.
3. **Property layouts**: reads/writes go through the engine's own reflection
   (`FindFProperty` + `Offset_Internal`), which is version-stable. Only the
   `FBoolProperty` bitmask tail is layout-sensitive, and it degrades to whole-byte
   semantics when the mask reads as zero.

## How it works

- `dllmain.cpp`: entry. Waits 15s for engine boot, starts the worker thread.
- `ue.cpp`: pattern scanner, `GObjects`/`GNames` walkers, `FName` resolution,
  `UObject`/`UClass`/`FProperty` reflection helpers. No SEH anywhere (mingw can't do
  `__try`): every foreign dereference is guarded by `CanRead` (VirtualQuery).
- `adapter.cpp`: WinHTTP WebSocket client speaking the adapter protocol, a small
  dependency-free JSON parser (host-tested), and the tool implementations.

## Tools

- `find` — locate objects by name/class substring → `[{id, name}]`
- `get` — read a float/int/bool/name/string property → the value as JSON
- `set` — write a property → `{before, after}` as JSON
- `world` — read/set `UWorld.TimeDilation` (slow-mo) via reflection

`spawn` is deliberately NOT advertised: spawning needs `UFunction` invocation
(`ProcessEvent`), and there is no stable cross-version way to do that without engine
headers. Data-property writes are direct memory operations (the same thing Telos's
memory-editing path does) and don't need the game thread; when `UFunction` calls
land, they'll need game-thread marshaling.

## Install

Telos stages `TelosBridgeUE/` next to the game: `TelosBridgeUE.dll`, `hub.txt`
(the hub's ws URL, written by the installer so the port is always right), and
`LOAD-THIS-FIRST.txt`. The player starts the game, then injects the DLL with any
injector (the game must be running — Unreal has no universal plugin loader, so this
step stays manual and explicit).

## Building

```
cd bridge-unreal && make        # needs x86_64-w64-mingw32-g++
```

Produces `TelosBridgeUE.dll` (statically linked, no CRT dependency on the game).

## Testing checklist (do this before claiming it works)

- [ ] `find` returns the player pawn and named actors in a real UE game
- [ ] `get` reads a float property (e.g. health) and matches the HUD
- [ ] `set` changes it and the game visibly reacts
- [ ] `world` time dilation slows the game
- [ ] No crash on level change (GObjects/GNames re-validate; ids go stale cleanly)

Until every box is ticked, the hub reports Unreal as installable-but-unverified, and
unknown engines stay on memory editing (see `src/hub/mods.ts`).

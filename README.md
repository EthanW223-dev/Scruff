# Scruff

Talk to an AI while you play, and it mods your game live.

> "I have 350 gold, make it 99,999."
> "Make my health infinite."
> "Undo that, it's too easy now."

Scruff sits on top of your game as a small overlay. Hold a conversation with it by voice
(push-to-talk hotkey) or text, and an AI does the modding: Claude with an API key, your Claude
Pro/Max subscription through Claude Desktop or Claude Code, or any model running on your own PC
(Ollama, LM Studio, ...).

- **Memory editing, for almost any single-player game.** Scruff scans the game's memory for a
  number you can see (gold, health, ammo, XP, even decimals like 4.75 cans of soup), narrows it
  down as the number changes, then sets it or freezes it. Same idea as Cheat Engine, except you
  just ask. **No number on screen** (a health bar, a hunger meter)? Say "give me max health":
  Scruff snapshots the game's memory, you play a little and tell it "it went down", "same" or
  "it went up", and a few answers later it's found and filled. While you play it quietly drops places that change on their own (timers,
  animations), and it checks the game actually shows a change before telling you it worked.
  When the overlay can see your game window, it's hands-free: Scruff reads the number off the
  HUD itself (you don't even have to say how much you have), watches the counter change while
  you play to narrow the search, then tries the remaining candidates one at a time and only
  claims success when the game visibly shows the new value — a write that sticks in a copy of
  the real value gets undone, not announced. Needs a chat model that can read screenshots
  (Claude, or a vision model on your PC); a text-only model falls back to asking you.
- **Change anything in Unity games.** For Unity games (built with Mono, like many indie games)
  Scruff can add its Unity bridge with one click: then the AI can change any object in the game,
  not just numbers: colors, skins and looks, sizes, movement speed, gravity, spawn collectibles or
  enemies, remove walls, load other levels, and call the game's own functions ("AddItem", "Heal").
  See [bridge/README.md](bridge/README.md).
- **It reads the game's files.** When you pick a game, Scruff works out its engine (Unity,
  Unreal, Godot, GameMaker, RPG Maker, Ren'Py, Source), finds its save and settings folders, and
  for Unity games reads the code's own variable names and types ("soup is a float"), so the AI
  knows what to look for and how the game stores it. It can also edit text saves and settings,
  with a backup and undo.
- **An overlay that fits the game.** It follows the game window, stays out of your way (clicks
  pass through to the game), and restyles itself for each game: colors lifted from the game's
  own UI, a font that matches its genre, and a corner the game's HUD leaves free.
- **It can see your game.** The overlay captures the game window so the AI can read the HUD
  itself instead of asking you what the numbers are.
- **Game adapters** give it real powers in specific games (spawn items, change weather, run
  console commands). Any plugin that speaks a tiny WebSocket protocol can plug in:
  see [docs/ADAPTERS.md](docs/ADAPTERS.md).
- **Everything is undoable.** Every change is logged with an undo button.

Single-player only. Scruff refuses to attach when it sees an anti-cheat running or a known online
game: memory editing gets accounts banned, and cheating in multiplayer ruins it for everyone else.

## Quick start (Windows)

You need [Node.js 22+](https://nodejs.org).

```sh
git clone https://github.com/EthanW223-dev/Scruff.git
cd Scruff
npm install
npm start
```

A small Scruff button appears in the top-right corner. Click it (or press **Ctrl+Shift+S**) to
open the panel, pick your AI (below), start your game, click **Pick a game**, and tell Scruff
what you want. If Windows refuses
access to the game, run the terminal as administrator.

## The overlay

- **Ctrl+Shift+S** opens and closes the panel (chat, mods, undo). **Esc** or clicking the game
  hands control back to the game.
- **Ctrl+Shift+Space** is push-to-talk: press, speak, press again. Speech is turned into text
  on your PC with Whisper; the first use downloads an ~80 MB voice model.
- The overlay is just one small button while you play. A dashed frame around it means Scruff is
  working, a red one that it's listening; hover it for details. Replies and the values it's
  holding show up as small notes under it, so you can keep playing.
- To use your own button art, save it over `dashboard/button.svg` (keep it square).
- Run the game in **windowed or borderless fullscreen**. No overlay app can draw over
  *exclusive* fullscreen without hooking into the game, which is exactly what anti-cheat looks
  for. Most games call borderless "Windowed Fullscreen" or "Borderless" in their video settings.
- The overlay follows the game window and hides when you alt-tab away (Windows).
- Ask "make the overlay match the game" or "move Scruff to the bottom left" any time; each game
  keeps its own look.
- Prefer a browser tab or a second screen? `npm run hub` starts Scruff without the overlay, and
  the same interface is at http://localhost:7777 (also from your phone with `npm run hub -- --lan`).

## Change anything (full mod layer)

Memory editing only changes numbers. To change *anything else*, just ask — recolor, resize,
hide or remove things, spawn copies, slow motion, gravity, the game's own functions:

> "Make my character pink and twice as big."
> "Give me the skin that enemy has."
> "Low gravity, and slow motion."
> "Spawn 20 coins next to me."
> "Get rid of that wall." / "Take me to the next level."

Every visual mod is checked on screen before Scruff claims it worked: if the game doesn't
show the change, Scruff undoes it and tries the next candidate instead of pretending.

What works depends on the engine (the status note in chat always says which tier you're on):

- **Unity — full.** Attach, click **install** next to *Bridge* in the Game files panel (or just
  ask for a mod and the AI offers it). Scruff adds the [BepInEx](https://github.com/BepInEx/BepInEx)
  mod loader and its bridge plugin to the game folder. Restart the game once, then everything
  above works through the live bridge.
- **Unreal Engine — numbers now, bridge scaffolded.** Number changes work via memory editing.
  Structural mods need the Unreal bridge in `bridge-unreal/`, which is an honest scaffold:
  it compiles but is untested against real games (per-version pattern verification required —
  see its README). Scruff says so instead of pretending.
- **Everything else (Godot, GameMaker, Source, ...) — numbers only.** Colors, models, spawning
  and removing things need per-game reverse engineering, which Scruff doesn't do.

**remove** in the same place takes out exactly what Scruff added. It works for Unity games built
with Mono (the Game files panel says *Unity (Mono)*); IL2CPP Unity games and other engines get
memory editing and file editing.

## Pick your AI

Open the panel and click the AI chip at the top. Switching starts a new chat, and Scruff
remembers your choice.

**Claude with an API key** (best results). Get a key at
[console.anthropic.com](https://console.anthropic.com/), then `copy .env.example .env`, paste it
in as `ANTHROPIC_API_KEY`, and restart Scruff. Any Claude model works; the default is
`claude-opus-5`.

**Your Claude subscription (Pro/Max), no API key.** Claude's own apps run on your plan, so Scruff
plugs into them as an MCP tool server: you chat in the Claude app, it calls Scruff's tools, and
every change still shows up in the dashboard with undo. The AI menu shows these commands with
your paths filled in.

- *Claude Code:* start Scruff (`npm start`), then run once:
  `claude mcp add --transport http scruff http://localhost:7777/mcp`
- *Claude Desktop:* Settings → Developer → Edit Config, add the `scruff` entry the AI menu gives
  you, and restart Claude Desktop. It starts Scruff by itself whenever it opens.

**A model on your own PC** (free, private, works offline). Install
[Ollama](https://ollama.com) and pull a model that supports tool calling, e.g.
`ollama pull qwen3:8b`, or start [LM Studio](https://lmstudio.ai)'s local server. Scruff finds
them automatically. Tips:

- Use 7B+ models (qwen3:8b or 14b, llama3.1:8b, mistral-small). Tiny ones get muddled: in
  testing, qwen3:1.7b did set the demo game's gold, but along the way it made up a process id
  and once reused a stale address. Scruff now refuses writes to addresses that aren't in the
  current results, and the error tells the model which ones are.
- Without a GPU it's slow: on a 4-core CPU each reply took 2–3 minutes. A GPU makes it seconds.
- Scruff's instructions and tools take about 4k tokens. If replies seem confused, raise Ollama's
  context: set `OLLAMA_CONTEXT_LENGTH=16384` before starting it.
- A local model shares your GPU with the game. If that hurts your frame rate, run Ollama on
  another PC and point `OLLAMA_URL` at it.

**Add Jev for instant quick commands** (works alongside any of the above).
[Jev](https://typesafe.ai) by TypeSafe isn't a chat model: it answers typed questions ("which of
these does the player mean?") in a fraction of a second, with a confidence number. Scruff sends
every message to Jev first. When Jev is sure it's a quick command, Scruff does it right away
without waiting on the chat AI:

- picking your game ("I'm playing 60 Seconds"),
- the whole find-and-change loop: "I have 5 soup cans, give me 99" → change it in-game → "now
  it's 4.75" → set,
- values with no number: "give me max health" → "it went down" → "same" → "it went up" → full,
- setting, locking, unlocking or reading a value Scruff already found, undo and undo all.

Anything else, or anything Jev isn't sure about, goes to the chat AI, which is told what Jev
already did. With a slow local model this turns minutes-long waits into instant replies for the
common stuff. Get a key at [console.typesafe.ai](https://console.typesafe.ai/keys) and paste it
into the AI menu (or set `TYPESAFE_API_KEY` in `.env`). Jev also works with no chat AI at all,
for just those commands. It costs about $0.04 per million input tokens; a message is a few
hundred tokens.

**Anything else with an OpenAI-compatible API** (OpenRouter, OpenAI, Groq, Gemini, DeepSeek,
llama.cpp, vLLM, ...): set `OPENAI_BASE_URL` and `OPENAI_API_KEY` in `.env`.

### Try it on the demo game first

```sh
npm run demo-game
```

in a second terminal starts *Scruff's Dungeon*, a tiny terminal RPG. It keeps its gold and health
in raw memory like a real game, and also connects to Scruff as a game adapter. Ask Scruff to
"give me 5000 gold" or "make it storm", then press `f` to fight and watch the numbers.

## In the browser instead

`npm run hub` runs Scruff without the overlay; open http://localhost:7777 in Chrome or Edge.

- **Push to talk:** click the mic (or Ctrl+Space while the page is focused), speak, click again.
- **Hands-free:** tick *Hands-free* and start requests with "Scruff, …".
- **Read replies aloud:** tick it to hear answers without looking away.
- **Phone or second screen:** `npm run hub -- --lan` prints a link for your phone. On a phone,
  use the keyboard's dictation button to talk.
- **Screen sharing:** click *Share screen* and pick the game window so the AI can see it.

## How it works

```
 overlay (Electron) ─┐
 dashboard (browser) ─┴─ws──► Scruff hub (Node, on your PC) ──► Claude API / Ollama / LM Studio / ...
   chat, voice, mods             │  agent loop + tools, Whisper speech-to-text, per-game themes
   screen capture                ├─ memory engine ──► game process (ReadProcessMemory / /proc/pid/mem)
                                 ├─ adapters ◄──ws── plugins inside specific games
 Claude Desktop / Code ──MCP──►  └─ /mcp: the same tools, for your Claude subscription
```

- `src/games/` reads a game's files: `profile.ts` (engine, install, save and settings folders),
  `dotnet.ts` (variable names and types from a Unity game's `Assembly-CSharp.dll`), `bepinex.ts`
  (installs and removes the Unity bridge).
- `bridge/` is the Unity bridge: a BepInEx plugin in C# ([bridge/README.md](bridge/README.md)).
- `src/memory/` scans and edits another process's memory: `windows.ts` (Win32 via koffi),
  `linux.ts` (`/proc/<pid>/mem`), `scanner.ts` (first scan + refine, ~1.3 GB/s), `session.ts`
  (watch list, freezing, undo log), `safety.ts` (anti-cheat check).
- `src/hub/` is the local server: `agent.ts` runs the conversation and its tools, `models.ts`
  picks the AI (`providers/anthropic.ts` for Claude, `providers/openai.ts` for everything
  OpenAI-compatible), `jev.ts` and `quick.ts` are the Jev client and fast path, `mcp.ts` serves the tools to Claude apps, `game.ts` defines the memory
  tools, `gamefiles.ts` the game-file tools, `adapters.ts` and `screen.ts` connect adapters and the shared screen, `server.ts`
  serves the dashboard.
- `src/mcp-stdio.ts` is what Claude Desktop launches: it starts the hub if needed and relays MCP.
- `overlay/` is the Electron app: a transparent, click-through window that follows the game
  window (`win32.mjs`), global hotkeys, the tray icon, and direct game capture.
- `dashboard/` is the interface (plain HTML/JS, no build step). The overlay loads the same page;
  `overlay.js` adds the in-game HUD, `theme.js` the per-game look, `voice.js` push-to-talk.

## Settings

In `.env` (all optional):

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | | For Claude via the API |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs |
| `LMSTUDIO_URL` | `http://127.0.0.1:1234` | Where LM Studio's server runs |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | | Any OpenAI-compatible service |
| `TYPESAFE_API_KEY` | | Turns on Jev for quick commands (or paste it in the AI menu) |
| `TYPESAFE_MODEL` | `jev-latest` | Pin a Jev version, e.g. `jev-1.13.0` |
| `SCRUFF_PROVIDER`, `SCRUFF_MODEL` | first that works | Starting AI (`claude`, `ollama`, `lmstudio`, `openai`); a pick in the dashboard overrides it |
| `SCRUFF_EFFORT` | `medium` | Claude only: `low` replies fastest; `high` thinks harder about tricky scans |
| `SCRUFF_PORT` | `7777` | |
| `SCRUFF_HOTKEY_PANEL`, `SCRUFF_HOTKEY_TALK` | `CommandOrControl+Shift+S`, `CommandOrControl+Shift+Space` | Overlay hotkeys ([format](https://www.electronjs.org/docs/latest/api/accelerator)) |
| `SCRUFF_WHISPER_MODEL` | `onnx-community/whisper-base.en` | Speech-to-text model; `whisper-small` is more accurate but slower |

## Known gaps

- Addresses only last until the game restarts; you re-scan each session (no pointer scanning yet).
- A search without a number copies the game's writable memory to your temp folder while it runs
  (about as big as the game's RAM use; deleted as soon as it narrows down, or when Scruff exits).
- Games that hide or encrypt their values in memory (usually ones with anti-cheat) can't be
  found this way.
- macOS isn't supported for memory editing.
- Only text saves and settings (JSON, INI, XML, ...) can be edited; most games use binary saves,
  where memory editing is the way in. The game reads a save when it loads it, so save and quit
  to the menu first. Unity IL2CPP games give variable names but not their types.
- With a Claude subscription you chat in the Claude app, so Scruff's own chat box and voice
  input need an API key or a local model.
- The overlay can't draw over exclusive-fullscreen games (see above).
- Following the game window, hiding on alt-tab and handing focus back to the game are Windows
  features; on Linux the overlay simply covers the main screen.
- The Windows memory backend and the overlay's window tracking follow the Win32 API docs but have
  only been run on Linux so far; please report what happens on your games.
- The Unity bridge's core (networking, JSON, reading and changing objects) is tested against Scruff,
  but its Unity-specific tools haven't run inside a real Unity game yet. The bridge supports Mono
  Unity games only (not IL2CPP), and its changes aren't in the undo list.

## Updating

```sh
git pull
npm install
npm start
```

## Development

```sh
npm test          # unit tests + live tests against the demo game process
npm run typecheck
```

The live memory tests need permission to read another process's memory (Windows: normally
fine; Linux: root or `kernel.yama.ptrace_scope=0`). On Linux, install with
`ONNXRUNTIME_NODE_INSTALL=skip npm install` to skip a 400 MB CUDA download Scruff doesn't use.

The interface bundles Inter Tight, JetBrains Mono and VT323 under the SIL Open Font License
(`dashboard/fonts/`).

# Scruff

Talk to an AI while you play, and it mods your game live.

> "I have 350 gold, make it 99,999."
> "Make my health infinite."
> "Undo that, it's too easy now."

Scruff runs on your PC next to the game. You talk to it from a small dashboard (type, push to
talk, or hands-free: *"Scruff, give me more ammo"*), and Claude does the modding:

- **Memory editing, for almost any single-player game.** Scruff scans the game's memory for a
  number you can see (gold, health, ammo, XP), narrows it down as the number changes, then sets
  it or freezes it. Same idea as Cheat Engine, except you just ask.
- **It can see your game.** Share the game window in the dashboard and Claude reads the HUD
  itself instead of asking you what the numbers are.
- **Game adapters** give it real powers in specific games (spawn items, change weather, run
  console commands). Any plugin that speaks a tiny WebSocket protocol can plug in:
  see [docs/ADAPTERS.md](docs/ADAPTERS.md).
- **Everything is undoable.** Every change is logged in the dashboard with an undo button.

Single-player only. Scruff refuses to attach when it sees an anti-cheat running or a known online
game: memory editing gets accounts banned, and cheating in multiplayer ruins it for everyone else.

## Quick start (Windows)

You need [Node.js 22+](https://nodejs.org) and an [Anthropic API key](https://console.anthropic.com/).

```sh
git clone https://github.com/EthanW223-dev/Scruff.git
cd Scruff
npm install
copy .env.example .env      # then paste your API key into .env
npm start
```

Open **http://localhost:7777** in Chrome or Edge, start your game, click **Pick a game**, and
tell Scruff what you want. If Windows refuses access to the game, run the terminal as
administrator.

### Try it on the demo game first

```sh
npm run demo-game
```

in a second terminal starts *Scruff's Dungeon*, a tiny terminal RPG. It keeps its gold and health
in raw memory like a real game, and also connects to Scruff as a game adapter. Ask Scruff to
"give me 5000 gold" or "make it storm", then press `f` to fight and watch the numbers.

## Using it while you play

- **Push to talk:** click the mic (or Ctrl+Space while the dashboard is focused), speak, click again.
- **Hands-free:** tick *Hands-free* and start requests with "Scruff, …". It keeps listening
  while you're in the game.
- **Read replies aloud:** tick it to hear answers without looking away.
- **Second screen or phone:** `npm start -- --lan` prints a link for your phone. On a phone, use
  the keyboard's dictation button to talk (browsers only allow the web mic on localhost/HTTPS).
- **Screen sharing** works best with the game in *borderless windowed* mode; exclusive
  fullscreen often captures as black.

## How it works

```
 dashboard (browser)  ──ws──►  Scruff hub (Node, on your PC)  ──►  Claude API
   chat, voice, mods              │  agent loop + tools
   screen capture                 ├─ memory engine ──► game process (ReadProcessMemory / /proc/pid/mem)
                                  └─ adapters ◄──ws── plugins inside specific games
```

- `src/memory/` scans and edits another process's memory: `windows.ts` (Win32 via koffi),
  `linux.ts` (`/proc/<pid>/mem`), `scanner.ts` (first scan + refine, ~1.3 GB/s), `session.ts`
  (watch list, freezing, undo log), `safety.ts` (anti-cheat check).
- `src/hub/` is the local server: `agent.ts` runs the conversation with Claude and its tools,
  `game.ts` defines the memory tools, `adapters.ts` and `screen.ts` connect adapters and the
  shared screen, `server.ts` serves the dashboard.
- `dashboard/` is the web UI (plain HTML/JS, no build step).

## Settings

In `.env`:

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | | Required |
| `SCRUFF_MODEL` | `claude-opus-5` | Any Claude model id |
| `SCRUFF_EFFORT` | `medium` | `low` replies fastest; `high` thinks harder about tricky scans |
| `SCRUFF_PORT` | `7777` | |

## Known gaps

- Addresses only last until the game restarts; you re-scan each session (no pointer scanning yet).
- No "unknown initial value" scan yet, so the value has to be a number you can see or estimate.
- macOS isn't supported for memory editing.
- The Windows memory backend follows the Win32 API docs but has only been exercised against
  Linux processes so far; please report what happens on your games.

## Development

```sh
npm test          # unit tests + live tests against the demo game process
npm run typecheck
```

The live memory tests need permission to read another process's memory (Windows: normally
fine; Linux: root or `kernel.yama.ptrace_scope=0`).

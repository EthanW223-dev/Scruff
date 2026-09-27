# Scruff

Talk to an AI while you play, and it mods your game live.

> "I have 350 gold, make it 99,999."
> "Make my health infinite."
> "Undo that, it's too easy now."

Scruff runs on your PC next to the game. You talk to it from a small dashboard (type, push to
talk, or hands-free: *"Scruff, give me more ammo"*), and an AI does the modding: Claude with an
API key, your Claude Pro/Max subscription through Claude Desktop or Claude Code, or any model
running on your own PC (Ollama, LM Studio, ...).

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

You need [Node.js 22+](https://nodejs.org).

```sh
git clone https://github.com/EthanW223-dev/Scruff.git
cd Scruff
npm install
npm start
```

Open **http://localhost:7777** in Chrome or Edge, pick your AI (below), start your game, click
**Pick a game**, and tell Scruff what you want. If Windows refuses access to the game, run the
terminal as administrator.

## Pick your AI

Click the AI chip in the top-left of the dashboard. Switching starts a new chat, and Scruff
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

**Anything else with an OpenAI-compatible API** (OpenRouter, OpenAI, Groq, Gemini, DeepSeek,
llama.cpp, vLLM, ...): set `OPENAI_BASE_URL` and `OPENAI_API_KEY` in `.env`.

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
 dashboard (browser) ──ws──►  Scruff hub (Node, on your PC) ──► Claude API / Ollama / LM Studio / ...
   chat, voice, mods             │  agent loop + tools
   screen capture                ├─ memory engine ──► game process (ReadProcessMemory / /proc/pid/mem)
                                 ├─ adapters ◄──ws── plugins inside specific games
 Claude Desktop / Code ──MCP──►  └─ /mcp: the same tools, for your Claude subscription
```

- `src/memory/` scans and edits another process's memory: `windows.ts` (Win32 via koffi),
  `linux.ts` (`/proc/<pid>/mem`), `scanner.ts` (first scan + refine, ~1.3 GB/s), `session.ts`
  (watch list, freezing, undo log), `safety.ts` (anti-cheat check).
- `src/hub/` is the local server: `agent.ts` runs the conversation and its tools, `models.ts`
  picks the AI (`providers/anthropic.ts` for Claude, `providers/openai.ts` for everything
  OpenAI-compatible), `mcp.ts` serves the tools to Claude apps, `game.ts` defines the memory
  tools, `adapters.ts` and `screen.ts` connect adapters and the shared screen, `server.ts`
  serves the dashboard.
- `src/mcp-stdio.ts` is what Claude Desktop launches: it starts the hub if needed and relays MCP.
- `dashboard/` is the web UI (plain HTML/JS, no build step).

## Settings

In `.env` (all optional):

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | | For Claude via the API |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs |
| `LMSTUDIO_URL` | `http://127.0.0.1:1234` | Where LM Studio's server runs |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | | Any OpenAI-compatible service |
| `SCRUFF_PROVIDER`, `SCRUFF_MODEL` | first that works | Starting AI (`claude`, `ollama`, `lmstudio`, `openai`); a pick in the dashboard overrides it |
| `SCRUFF_EFFORT` | `medium` | Claude only: `low` replies fastest; `high` thinks harder about tricky scans |
| `SCRUFF_PORT` | `7777` | |

## Known gaps

- Addresses only last until the game restarts; you re-scan each session (no pointer scanning yet).
- No "unknown initial value" scan yet, so the value has to be a number you can see or estimate.
- macOS isn't supported for memory editing.
- With a Claude subscription you chat in the Claude app, so the dashboard's own chat box and
  voice input need an API key or a local model.
- The Windows memory backend follows the Win32 API docs but has only been exercised against
  Linux processes so far; please report what happens on your games.

## Development

```sh
npm test          # unit tests + live tests against the demo game process
npm run typecheck
```

The live memory tests need permission to read another process's memory (Windows: normally
fine; Linux: root or `kernel.yama.ptrace_scope=0`).

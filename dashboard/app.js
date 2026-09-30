// Telos dashboard: chat with the AI, see and control what it changed in your game.
// The same page runs inside the in-game overlay (Electron), which provides window.scruffOverlay.

import { applyTheme, paletteFrom } from "./theme.js";
import { startRecording } from "./voice.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const token = new URLSearchParams(location.search).get("token");
let ws = null;
let busy = false;
let state = null;
let aiInfo = null;
const overlay = window.scruffOverlay ?? null;
if (overlay) document.body.classList.add("overlay");

// ---------- connection ----------

function connect() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  ws = new WebSocket(url);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setBanner("Lost connection to Telos. Is it still running? Reconnecting…");
    setTimeout(connect, 1500);
  };
  ws.onopen = () => {
    setBanner(null);
    // The overlay can always capture the game window itself.
    if (screenStream || overlay) send({ type: "screen", sharing: true });
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  // The overlay's HUD listens in on everything.
  window.dispatchEvent(new CustomEvent("scruff", { detail: msg }));
  switch (msg.type) {
    case "hello":
      aiInfo = msg.ai;
      // hello carries the freshest AI info (e.g. after set_persona/set_voice); keep the cached copy in sync.
      if (modelsMsg) modelsMsg.current = msg.ai;
      renderAi();
      renderPersonaVoice();
      break;
    case "models":
      renderModels(msg);
      break;
    case "history":
      $("log").querySelectorAll(".msg, .sys").forEach((n) => n.remove());
      currentTurn = null;
      for (const event of msg.events) renderAgentEvent(event, true);
      updateEmpty();
      scrollToEnd(true);
      break;
    case "agent":
      renderAgentEvent(msg.event, false);
      break;
    case "state":
      state = msg;
      renderState();
      renderJev();
      applyTheme(msg.theme);
      onGameChange(msg.game.attached, msg.theme);
      break;
    case "voice_status":
      voiceStatus(msg.text || null);
      break;
    case "games":
      renderPicker(msg.list);
      break;
    case "game_event":
      addSys(`${msg.event.adapter}: ${msg.event.text}`, "event");
      break;
    case "toast":
      if (connectBusy && msg.level === "error") showConnectError(msg.text);
      else toast(msg.text, msg.level);
      break;
    case "capture":
      captureFrame(msg.id);
      break;
  }
}

// ---------- chat rendering ----------

let currentTurn = null; // { root, text, thinking, steps: Map }
let turnText = "";

function updateEmpty() {
  $("empty").hidden = Boolean($("log").querySelector(".msg"));
}

function scrollToEnd(force) {
  const log = $("log");
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
}

function addSys(text, kind = "") {
  $("log").append(el("div", `sys ${kind}`, text));
  scrollToEnd();
}

function ensureTurn() {
  if (!currentTurn) {
    const root = el("div", "msg turn");
    $("log").append(root);
    currentTurn = { root, text: null, thinking: null, steps: new Map() };
  }
  return currentTurn;
}

function renderMarkdown(target, source) {
  // Tiny, safe subset: paragraphs, **bold**, `code`.
  target.replaceChildren();
  for (const para of source.split(/\n{2,}/)) {
    const p = el("p");
    const parts = para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) p.append(el("strong", "", part.slice(2, -2)));
      else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) p.append(el("code", "", part.slice(1, -1)));
      else {
        const lines = part.split("\n");
        lines.forEach((line, i) => {
          if (i) p.append(el("br"));
          p.append(line);
        });
      }
    }
    target.append(p);
  }
}

const fmt = (v) => (typeof v === "number" ? v.toLocaleString() : v);

function toolLabel(name, input = {}) {
  switch (name) {
    case "list_running_games": return "Looking for your game";
    case "attach_to_game": return `Attaching to process ${input.pid}`;
    case "game_status": return "Checking the game";
    case "find_value": {
      const what = input.what ?? "the value";
      if (input.value !== undefined) return `Looking for ${what}: ${fmt(input.value)}`;
      if (input.change) return `Narrowing ${what}: ${{ decreased: "went down", increased: "went up", unchanged: "stayed the same", changed: "changed" }[input.change] ?? input.change}`;
      if (input.min !== undefined) return `Looking for ${what}: ${fmt(input.min)}–${fmt(input.max)}`;
      return `Snapshot of memory to find ${what} (no number)`;
    }
    case "show_scan_results": return "Listing results";
    case "read_values": return "Reading values";
    case "write_value": return `Setting ${input.label ?? "value"} to ${fmt(input.value)}`;
    case "freeze_value": return `Freezing ${input.label ?? "value"} at ${fmt(input.value)}`;
    case "unfreeze_value": return "Unfreezing";
    case "watch_value": return `Watching ${input.label}`;
    case "undo_change": return "Undoing";
    case "revert_all_changes": return "Undoing everything";
    case "look_at_screen": return "Looking at your screen";
    case "style_overlay": return "Styling the overlay to fit this game";
    case "jev": return "Understood with Jev";
    case "use_game_adapter": return `${String(input.tool ?? "").replace("__", " → ")}`;
    default: return name;
  }
}

function renderAgentEvent(event, replay) {
  switch (event.type) {
    case "user": {
      currentTurn = null;
      const row = el("div", "msg user");
      if (!replay) row.classList.add("fresh");
      row.append(el("div", "bubble", event.text));
      $("log").append(row);
      updateEmpty();
      scrollToEnd(true);
      break;
    }
    case "turn_start": {
      turnText = "";
      const turn = ensureTurn();
      if (!replay) turn.root.classList.add("active", "fresh");
      break;
    }
    case "thinking": {
      const turn = ensureTurn();
      if (!turn.thinking) {
        turn.thinking = el("details", "thinking");
        turn.thinking.append(el("summary", "", "Thinking"), el("div", "body"));
        turn.root.append(turn.thinking);
      }
      turn.thinking.querySelector(".body").textContent += event.text;
      break;
    }
    case "text": {
      const turn = ensureTurn();
      settleThinking(turn);
      if (!turn.text) {
        turn.text = el("div", "text");
        turn.text.dataset.raw = "";
        turn.root.append(turn.text);
      }
      turn.text.dataset.raw += event.text;
      turnText += event.text;
      renderMarkdown(turn.text, turn.text.dataset.raw);
      scrollToEnd();
      break;
    }
    case "tool_call": {
      const turn = ensureTurn();
      settleThinking(turn);
      turn.text = null; // text after this tool starts a new paragraph block
      const step = el("details", "step");
      const summary = el("summary");
      const icon = el("span", "status-icon");
      icon.append(el("span", "spinner"));
      summary.append(icon, el("span", "label", toolLabel(event.name, event.input)), el("span", "sub"));
      const pre = el("pre", "", JSON.stringify(event.input, null, 1));
      step.append(summary, pre);
      turn.root.append(step);
      turn.steps.set(event.id, step);
      scrollToEnd();
      break;
    }
    case "tool_progress": {
      const step = currentTurn?.steps.get(event.id);
      if (step) step.querySelector(".sub").textContent = event.text;
      break;
    }
    case "tool_result": {
      const step = currentTurn?.steps.get(event.id);
      if (!step) break;
      step.classList.add(event.ok ? "ok" : "err");
      step.querySelector(".status-icon").textContent = event.ok ? "✓" : "✕";
      step.querySelector(".sub").textContent = event.ok ? shortResult(event.text) : "failed";
      step.querySelector("pre").textContent += `\n\n→ ${event.text}`;
      break;
    }
    case "notice":
      addSys(event.text);
      break;
    case "error":
      addSys(event.text, "error");
      break;
    case "turn_end":
      if (currentTurn) {
        settleThinking(currentTurn);
        currentTurn.root.classList.remove("active");
      }
      if (!replay && $("speak").checked && turnText.trim()) speak(turnText);
      currentTurn = null;
      break;
  }
}

/** Closes the current thinking block; later thinking in the same turn gets a new one. */
function settleThinking(turn) {
  if (!turn.thinking) return;
  turn.thinking.querySelector("summary").textContent = "Thought";
  turn.thinking = null;
}

function shortResult(text) {
  // Long results arrive truncated, so look for the count rather than parsing the JSON.
  const count = /"count":\s*(\d+)/.exec(text);
  if (count) return `${Number(count[1]).toLocaleString()} result${count[1] === "1" ? "" : "s"}`;
  // write_value: how many writes held, and whether the game put any back.
  if (text.startsWith("{") && text.includes('"results"')) {
    try {
      const results = JSON.parse(text).results;
      const held = results.filter((r) => "now" in r && !r.warning).length;
      const back = results.filter((r) => r.warning).length;
      const failed = results.filter((r) => r.error).length;
      return [held && `${held} set`, back && `${back} changed back by the game`, failed && `${failed} failed`].filter(Boolean).join(" · ");
    } catch {}
  }
  if (text.startsWith("[")) {
    try {
      const n = JSON.parse(text).length;
      return `${n} item${n === 1 ? "" : "s"}`;
    } catch {}
  }
  return text.split("\n")[0].slice(0, 80);
}

// ---------- state: game, mods, changes ----------

function renderState() {
  const game = state.game;
  const attached = game.attached;
  busy = state.busy;
  $("send").hidden = busy;
  $("stop").hidden = !busy;

  $("game-chip").querySelector(".dot").className = `dot ${attached ? "on" : ""}`;
  $("game-label").textContent = attached ? attached.title || attached.name : game.supported.ok ? "Pick a game" : "Memory editing unsupported";
  $("screen-chip").querySelector(".dot").className = `dot ${screenStream ? "live" : ""}`;
  $("screen-label").textContent = screenStream ? "Sharing screen" : "Share screen";

  const adapters = state.adapters;
  $("adapter-chip").hidden = adapters.length === 0;
  $("adapter-label").textContent = adapters.length === 1 ? `Adapter: ${adapters[0].name}` : `${adapters.length} adapters`;
  $("adapters-panel").hidden = adapters.length === 0;
  $("adapters").replaceChildren(
    ...adapters.map((a) => {
      const li = el("li");
      li.append(el("div", "", a.name), el("div", "tools", a.tools.join(", ") || "no tools"));
      return li;
    }),
  );

  // Scan status
  const scan = attached?.scan;
  const scanning = game.scanProgress !== null;
  $("scan").hidden = !scanning && !scan?.types?.length;
  $("scan-progress").hidden = !scanning;
  $("scan-progress").firstElementChild.style.width = `${Math.round((game.scanProgress ?? 0) * 100)}%`;
  $("scan-text").textContent = scanning
    ? "Searching memory…"
    : scan?.types?.length
      ? `${scan.what ? `${scan.what}: ` : ""}${scan.count.toLocaleString()} place${scan.count === 1 ? "" : "s"} match${scan.count === 1 ? "es" : ""}${scan.truncated ? " (capped)" : ""}`
      : "";

  renderWatch(attached?.watch ?? []);
  renderChanges(attached?.changes ?? []);
  $("revert-all").hidden = !(attached?.changes ?? []).some((c) => !c.undone);
  $("detach").hidden = !attached;
  $("app-bar-game").textContent = attached ? attached.title || attached.name.replace(/\.exe$/i, "") : "";
  renderGameFiles(attached ? game.profile : null);
}

// The Unity bridge: full live control of Unity (Mono) games, installed with one click.
function bridgeRow(bridge) {
  if (!bridge?.supported) return [];
  const connected = (state?.adapters ?? []).some((a) => a.prefix.startsWith("unity"));
  const dd = el("dd", "bridge");
  const status = connected
    ? bridge.outdated ? "connected · update ready" : "connected"
    : bridge.outdated ? "update ready" : bridge.installed ? "installed, restart the game" : "not installed";
  dd.append(el("span", connected ? "ok" : "", status));
  const action = (label, type, title) => {
    const button = el("button", "link", label);
    button.title = title;
    button.addEventListener("click", () => {
      button.disabled = true;
      send({ type });
    });
    dd.append(" ", button);
  };
  if (!bridge.installed) {
    action("install", "install_bridge", "Add BepInEx and the Telos bridge to the game folder, so the AI can change anything in it (needs a game restart)");
  } else {
    if (bridge.outdated) action("update", "install_bridge", "Quit the game first (it keeps the bridge file open), then update and start it again");
    if (!connected) action("remove", "remove_bridge", "Take the bridge (and BepInEx, if Telos added it) out of the game");
  }
  return [el("dt", "", "Bridge"), dd];
}

// What Telos read from the game's files when it attached.
function renderGameFiles(profile) {
  $("game-panel").hidden = !profile;
  if (!profile) return;
  const code = { dotnet: "readable (names + types)", il2cpp: "names only" }[profile.code] ?? "not readable";
  const rows = [
    ["Engine", profile.engine],
    ["Code", code],
    ["Installed", profile.installDir],
    ["Saves", profile.saveDirs.length ? profile.saveDirs.join("\n") : "not found"],
  ];
  $("game-info").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dd = el("dd", "", v);
      dd.style.whiteSpace = "pre-line";
      return [el("dt", "", k), dd];
    }),
    ...bridgeRow(profile.bridge),
  );
}

function renderWatch(watch) {
  const list = $("watch");
  $("watch-empty").hidden = watch.length > 0;
  $("mods-count").hidden = watch.length === 0;
  $("mods-count").textContent = watch.length;
  const existing = new Map([...list.children].map((li) => [li.dataset.address, li]));
  const keep = new Set();
  for (const w of watch) {
    keep.add(w.address);
    let li = existing.get(w.address);
    if (!li) {
      li = el("li");
      li.dataset.address = w.address;
      const info = el("div");
      info.append(el("div", "name"), el("div", "addr"));
      const input = el("input", "value");
      input.type = "text";
      input.inputMode = "decimal";
      input.setAttribute("aria-label", "Value");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          send({ type: "set_value", address: w.address, value: Number(input.value) });
          input.blur();
        }
        if (e.key === "Escape") input.blur();
      });
      const lock = el("button", "lock");
      lock.type = "button";
      lock.title = "Freeze this value";
      lock.addEventListener("click", () => send({ type: "freeze", address: w.address, frozen: lock.getAttribute("aria-pressed") !== "true" }));
      const remove = el("button", "link remove", "remove");
      remove.addEventListener("click", () => send({ type: "unwatch", address: w.address }));
      li.append(info, input, lock, remove);
      list.append(li);
    }
    li.querySelector(".name").textContent = w.label;
    li.querySelector(".addr").textContent = `${w.address} · ${w.type}`;
    const input = li.querySelector("input");
    if (document.activeElement !== input) input.value = w.value === null ? "?" : formatValue(w.value, w.type);
    const lock = li.querySelector(".lock");
    lock.setAttribute("aria-pressed", String(w.frozen));
    lock.textContent = w.frozen ? "🔒" : "🔓";
  }
  for (const [address, li] of existing) if (!keep.has(address)) li.remove();
}

function formatValue(v, type) {
  if (type === "float" || type === "double") return String(Math.round(v * 1000) / 1000);
  return String(v);
}

function renderChanges(changes) {
  $("changes-empty").hidden = changes.length > 0;
  $("changes").replaceChildren(
    ...changes.slice(0, 40).map((c) => {
      const li = el("li", c.undone ? "undone" : "");
      li.append(
        el("span", "what", `${c.frozen ? "🔒 " : ""}${c.label}`),
        el("span", "vals", c.file ? c.file.summary : `${formatValue(c.before, c.type)} → ${formatValue(c.after, c.type)}`),
      );
      if (!c.undone) {
        const undo = el("button", "link", "undo");
        undo.addEventListener("click", () => send({ type: "undo", id: c.id }));
        li.append(undo);
      }
      return li;
    }),
  );
}

// ---------- AI menu ----------

function renderAi() {
  const jevOn = Boolean(state?.jev?.enabled);
  $("ai-chip").querySelector(".dot").className = `dot ${aiInfo.ready || jevOn ? "on" : ""}`;
  $("ai-label").textContent = (aiInfo.model ? `${aiInfo.providerLabel} · ${aiInfo.model}` : "Pick an AI") + (jevOn ? " + Jev" : "");
  if (!aiInfo.ready && jevOn) {
    setBanner("Jev is handling quick commands. For anything else, set up a chat AI in the AI menu.");
  } else if (!aiInfo.ready) {
    setBanner(`${aiInfo.problem ?? "The AI isn't set up yet"}, or open the AI menu to use a local model or your Claude subscription.`);
  } else if (!$("banner").textContent.startsWith("Lost connection")) {
    setBanner(null);
  }
}

// ---------- AI menu: provider cards + guided connect ----------

const PROVIDER_META = {
  claude: { logo: "logos/anthropic.svg", keyUrl: "https://console.anthropic.com/settings/keys", keyKind: "Anthropic" },
  ollama: { logo: "logos/ollama.svg" },
  lmstudio: { logo: "logos/lmstudio.svg" },
  openai: { logo: "logos/openai.svg", keyUrl: "https://platform.openai.com/api-keys", keyKind: "OpenAI" },
};
const JEV_LOGO = "logos/typesafe.svg";

const PERSONAS = [
  { id: "telos", name: "Telos", detail: "The game-modding sidekick." },
  { id: "grim", name: "Grim", detail: "Ethan's AI — my personality. Works with any model." },
];
const VOICE_OPTIONS = [
  ["en-US-AriaNeural", "Aria — warm, natural"],
  ["en-US-JennyNeural", "Jenny — friendly"],
  ["en-US-GuyNeural", "Guy — deep"],
  ["en-GB-SoniaNeural", "Sonia — British"],
];

let modelsMsg = null;
let connectId = null; // provider id (or "jev") with the connect panel open
let connectBusy = null; // provider id while a key check is in flight; error toasts go inline

// Jev (TypeSafe) fast path: on when a key is set; the key itself never comes back from the hub.
function jevPill() {
  const jev = state?.jev;
  if (!jev) return ["…", ""];
  return (
    {
      working: ["on", "on"],
      checking: ["checking…", ""],
      rejected: ["key rejected", "warn"],
      unreachable: ["unreachable", "warn"],
      off: ["off", ""],
    }[jev.status] ?? [jev.status, ""]
  );
}

function renderJev() {
  if (connectBusy === "jev" && state?.jev?.status !== "checking") connectBusy = null;
  if (!$("ai-dialog").open || !modelsMsg) return;
  if (connectId === "jev") {
    openConnect("jev", true);
    return;
  }
  const pill = $("provider-grid").querySelector('[data-id="jev"] .pill');
  if (pill) {
    const [text, cls] = jevPill();
    pill.className = `pill ${cls}`;
    pill.textContent = text;
  }
  if (aiInfo) renderAi();
}

function openAiMenu() {
  connectId = null;
  connectBusy = null;
  $("connect-panel").hidden = true;
  $("provider-grid").replaceChildren(el("div", "muted small", "Probing providers…"));
  $("ai-dialog").showModal();
  send({ type: "list_models" });
}

// Persona + voice sections of the AI menu. They read the dashboard's current AI info
// (from either the "models" or the "hello" message) and send set_persona / set_voice.
function renderPersonaVoice() {
  const ai = modelsMsg?.current ?? aiInfo ?? {};
  renderPersonas(ai.persona ?? "telos");
  renderVoice(ai.voice ?? VOICE_OPTIONS[0][0], Boolean(ai.voiceEnabled));
}

function renderPersonas(persona) {
  const row = $("persona-row");
  row.replaceChildren(
    ...PERSONAS.map((p, i) => {
      const b = el("button", "provider-card persona-card");
      b.type = "button";
      b.dataset.id = p.id;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(persona === p.id));
      b.style.animationDelay = `${Math.min(i * 55, 330)}ms`;
      b.append(el("span", "provider-name", p.name), el("span", "provider-detail", p.detail));
      b.addEventListener("click", () => send({ type: "set_persona", persona: p.id }));
      // Spotlight hover, same as provider cards.
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty("--mx", `${e.clientX - r.left}px`);
        b.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
      return b;
    }),
  );
}

function renderVoice(voice, enabled) {
  const row = $("voice-row");
  row.replaceChildren();
  const label = el("label", "voice-toggle");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = enabled;
  label.append(cb, el("span", null, "Speak replies with a human voice"));
  const sel = el("select");
  sel.setAttribute("aria-label", "Voice");
  for (const [id, name] of VOICE_OPTIONS) {
    const o = el("option", null, name);
    o.value = id;
    sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === voice) ? voice : VOICE_OPTIONS[0][0];
  cb.addEventListener("change", () => send({ type: "set_voice", voice: sel.value, enabled: cb.checked }));
  sel.addEventListener("change", () => {
    send({ type: "set_voice", voice: sel.value, enabled: cb.checked });
    // Preview the new voice immediately.
    new Audio(`/voice/say?voice=${encodeURIComponent(sel.value)}&text=${encodeURIComponent("Hey Ethan, this is how I sound now.")}`)
      .play()
      .catch(() => {});
  });
  row.append(label, sel);
}

function providerCards() {
  const cards = modelsMsg.providers.map((p) => {
    const meta = PROVIDER_META[p.id] ?? {};
    return {
      id: p.id,
      name: p.label,
      logo: meta.logo,
      pill: p.ready
        ? ["ready", "on"]
        : p.id === "ollama" || p.id === "lmstudio"
          ? ["not running", "warn"]
          : ["needs key", "warn"],
      detail: p.ready ? `${p.detail} · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : p.detail,
      selected: modelsMsg.current.provider === p.id,
    };
  });
  const [jt, jc] = jevPill();
  cards.push({
    id: "jev",
    name: "Jev",
    logo: JEV_LOGO,
    pill: [jt, jc],
    detail: "by TypeSafe · instant quick commands",
    selected: false,
  });
  return cards;
}

function renderModels(msg) {
  modelsMsg = msg;
  connectBusy = null;
  renderPersonaVoice();
  const grid = $("provider-grid");
  grid.replaceChildren(
    ...providerCards().map((c, i) => {
      const b = el("button", "provider-card");
      b.type = "button";
      b.dataset.id = c.id;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(c.selected));
      b.style.animationDelay = `${Math.min(i * 55, 330)}ms`;
      const logo = el("span", "provider-logo");
      const img = el("img");
      img.src = c.logo;
      img.alt = "";
      logo.append(img);
      b.append(
        logo,
        el("span", "provider-name", c.name),
        el("span", `pill ${c.pill[1]}`, c.pill[0]),
        el("span", "provider-detail", c.detail),
      );
      b.addEventListener("click", () => openConnect(c.id));
      // Spotlight hover, 21st.dev spotlight-card pattern.
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty("--mx", `${e.clientX - r.left}px`);
        b.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
      return b;
    }),
  );
  $("cc-cmd").textContent = msg.connect.claudeCode;
  $("desktop-json").textContent = msg.connect.desktopConfig;
  $("desktop-path").textContent = msg.connect.desktopConfigPath;
  if (connectId) openConnect(connectId, true);
  if (aiInfo) renderAi();
}

function connectHead(name, logo, pill) {
  const head = el("div", "connect-head");
  const lg = el("span", "provider-logo");
  const img = el("img");
  img.src = logo;
  img.alt = "";
  lg.append(img);
  head.append(lg, el("h4", null, name), el("span", `pill ${pill[1]}`, pill[0]));
  return head;
}

function showConnectError(text) {
  connectBusy = null;
  const panel = $("connect-panel");
  const errLine = panel.querySelector(".connect-error");
  if (errLine) {
    errLine.hidden = false;
    errLine.textContent = text;
  }
  const btn = panel.querySelector("[data-connect]");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
}

function keyInputRow(placeholder) {
  const row = el("div", "key-row");
  const input = el("input");
  input.type = "password";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  const reveal = el("button", "reveal", "show");
  reveal.type = "button";
  reveal.title = "Show the key";
  reveal.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    reveal.textContent = show ? "hide" : "show";
  });
  row.append(input, reveal);
  return [row, input];
}

function openConnect(id, soft) {
  connectId = id;
  const panel = $("connect-panel");
  for (const cardEl of $("provider-grid").children) cardEl.setAttribute("aria-selected", String(cardEl.dataset.id === id));
  panel.hidden = false;
  panel.replaceChildren();
  if (id === "jev") buildJevPanel(panel);
  else buildProviderPanel(panel, modelsMsg.providers.find((p) => p.id === id));
  if (!soft) panel.querySelector("input, select")?.focus({ preventScroll: true });
}

function buildProviderPanel(panel, p) {
  const meta = PROVIDER_META[p.id] ?? {};
  panel.append(connectHead(p.label, meta.logo, p.ready ? ["ready", "on"] : ["not ready", "warn"]));

  if (p.ready) {
    const row = el("div", "model-row");
    row.append(el("label", null, "Model"));
    const sel = el("select");
    for (const m of p.models) {
      const o = el("option", null, m);
      o.value = m;
      sel.append(o);
    }
    const current = p.id === modelsMsg.current.provider ? modelsMsg.current.model : p.models[0];
    sel.value = [...sel.options].some((o) => o.value === current) ? current : (p.models[0] ?? "");
    row.append(sel);
    const actions = el("div", "connect-actions");
    const use = el("button", "primary", "Use this model");
    use.type = "button";
    use.addEventListener("click", () => {
      if (!sel.value) return toast("Pick a model first.", "error");
      send({ type: "set_model", provider: p.id, model: sel.value });
      $("ai-dialog").close();
    });
    actions.append(use, el("span", "connect-note", "Switching starts a new chat."));
    if (p.keySource === "saved") {
      const forget = el("button", "link", "Forget the saved key");
      forget.type = "button";
      forget.addEventListener("click", () => send({ type: "set_provider_key", provider: p.id, key: null }));
      actions.append(forget);
    }
    panel.append(row, actions);
    return;
  }

  if (p.id === "ollama" || p.id === "lmstudio") {
    const steps = el("ol", "connect-steps");
    const li = el("li");
    li.append(el("span", null, `${p.detail}. `));
    const retry = el("button", "primary", "Check again");
    retry.type = "button";
    retry.addEventListener("click", () => {
      retry.disabled = true;
      retry.innerHTML = `<span class="spin"></span> Checking…`;
      send({ type: "list_models" });
    });
    li.append(retry);
    steps.append(li);
    panel.append(steps);
    return;
  }

  // Cloud provider without a key: guided connect instead of a bare key field.
  const steps = el("ol", "connect-steps");
  const s1 = el("li");
  const a = el("a");
  a.href = meta.keyUrl;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = `Get an API key from ${meta.keyKind}`;
  s1.append(a);
  const s2 = el("li");
  const [keyRow, input] = keyInputRow("Paste the key here");
  s2.append(keyRow);
  steps.append(s1, s2);
  const errLine = el("p", "connect-error");
  errLine.hidden = true;
  const actions = el("div", "connect-actions");
  const connectBtn = el("button", "primary", "Connect");
  connectBtn.type = "button";
  connectBtn.dataset.connect = "1";
  const go = () => {
    const key = input.value.trim();
    if (!key) {
      input.focus();
      return;
    }
    connectBusy = p.id;
    errLine.hidden = true;
    connectBtn.disabled = true;
    connectBtn.innerHTML = `<span class="spin"></span> Checking…`;
    send({ type: "set_provider_key", provider: p.id, key });
  };
  connectBtn.addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    // The dialog is a form: Enter would close it instead of connecting.
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  });
  actions.append(connectBtn, el("span", "connect-note", "Checked instantly · saved on this PC only."));
  panel.append(steps, errLine, actions);
}

function buildJevPanel(panel) {
  const jev = state?.jev;
  const [jt, jc] = jevPill();
  panel.append(connectHead("Jev by TypeSafe", JEV_LOGO, [jt, jc]));
  panel.append(
    el(
      "p",
      "muted small",
      "Jev reads each message in a fraction of a second. Quick commands — undo, setting or locking values it found, picking your game — run instantly instead of waiting on the chat AI.",
    ),
  );
  if (jev?.problem) panel.append(el("p", "connect-error", jev.problem));
  const [keyRow, input] = keyInputRow(jev?.source ? "Paste a new key to replace it" : "Paste your TypeSafe key");
  const save = el("button", "primary", "Save");
  save.type = "button";
  save.dataset.connect = "1";
  const errLine = el("p", "connect-error");
  errLine.hidden = true;
  const go = () => {
    const key = input.value.trim();
    if (!key) {
      input.focus();
      return;
    }
    connectBusy = "jev";
    errLine.hidden = true;
    save.disabled = true;
    save.innerHTML = `<span class="spin"></span> Checking…`;
    send({ type: "set_jev_key", key });
  };
  save.addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  });
  keyRow.append(save);
  const actions = el("div", "connect-actions");
  if (jev?.source === "saved") {
    const off = el("button", "link", "Turn Jev off (forget the key)");
    off.type = "button";
    off.addEventListener("click", () => send({ type: "set_jev_key", key: null }));
    actions.append(off);
  } else if (jev?.source === "env") {
    actions.append(el("span", "connect-note", "Using TYPESAFE_API_KEY from .env — a saved key replaces it."));
  } else {
    const a = el("a", null, "Get a key at console.typesafe.ai");
    a.href = "https://console.typesafe.ai/keys";
    a.target = "_blank";
    a.rel = "noreferrer";
    actions.append(a);
  }
  panel.append(keyRow, errLine, actions);
}

$("ai-chip").addEventListener("click", openAiMenu);

for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", async () => {
    const text = $(b.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      getSelection().selectAllChildren($(b.dataset.copy)); // no clipboard over plain http: select it instead
    }
  });
}

// ---------- game picker ----------

function openPicker() {
  $("picker-list").replaceChildren(el("li", "muted small", "Looking for running programs…"));
  $("picker").showModal();
  $("picker-search").value = "";
  $("picker-search").focus();
  send({ type: "list_games" });
}

let pickerTimer = null;
$("picker-search").addEventListener("input", () => {
  clearTimeout(pickerTimer);
  pickerTimer = setTimeout(() => send({ type: "list_games", search: $("picker-search").value }), 250);
});
$("picker-refresh").addEventListener("click", () => send({ type: "list_games", search: $("picker-search").value }));
$("detach").addEventListener("click", () => {
  send({ type: "detach" });
  $("picker").close();
});

function renderPicker(list) {
  if (!list.length) {
    $("picker-list").replaceChildren(el("li", "muted small", "Nothing found. Is the game running?"));
    return;
  }
  $("picker-list").replaceChildren(
    ...list.map((p) => {
      const li = el("li");
      const b = el("button");
      b.type = "button";
      b.append(el("span", "title", p.title || p.name), el("span", "meta", `${p.command ?? p.name} · pid ${p.pid}`));
      b.addEventListener("click", () => {
        send({ type: "attach", pid: p.pid });
        $("picker").close();
      });
      li.append(b);
      return li;
    }),
  );
}

// ---------- screen sharing ----------

let screenStream = null;

async function toggleScreen() {
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("This browser can't share the screen. Use Chrome or Edge on the PC running the game.", "error");
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
  } catch {
    return; // user cancelled the picker
  }
  const video = $("screen-video");
  video.srcObject = screenStream;
  await video.play().catch(() => {});
  screenStream.getVideoTracks()[0].addEventListener("ended", () => {
    screenStream = null;
    video.srcObject = null;
    send({ type: "screen", sharing: false });
    if (state) renderState();
  });
  send({ type: "screen", sharing: true });
  if (state) renderState();
}

async function captureFrame(id) {
  try {
    if (overlay) {
      const data = await overlay.captureGame();
      if (!data) throw new Error("Couldn't capture the game window.");
      send({ type: "frame", id, data });
      return;
    }
    const video = $("screen-video");
    if (!screenStream || !video.videoWidth) throw new Error("Screen sharing isn't running.");
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
    send({ type: "frame", id, data });
  } catch (err) {
    send({ type: "frame", id, error: err.message });
  }
}

// ---------- following the game ----------

let trackedPid = null;
let paletteFor = null;

/** When the attached game changes: point the overlay at its window and pick colors from it. */
function onGameChange(attached, theme) {
  const pid = attached?.pid ?? null;
  if (pid !== trackedPid) {
    trackedPid = pid;
    overlay?.trackGame(pid);
  }
  if (pid && paletteFor !== pid && theme?.source === "default") {
    paletteFor = pid;
    setTimeout(suggestPalette, 1500); // give the overlay a moment to find the window
  }
}

async function suggestPalette() {
  let data = null;
  try {
    if (overlay) data = await overlay.captureGame();
    else if (screenStream) data = grabVideoFrame();
  } catch {}
  if (!data) return;
  const img = new Image();
  img.onload = () => send({ type: "suggest_theme", theme: paletteFrom(img) });
  img.src = `data:image/jpeg;base64,${data}`;
}

function grabVideoFrame() {
  const video = $("screen-video");
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = Math.round((320 * video.videoHeight) / video.videoWidth);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
}

// ---------- voice ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE = /^\s*(?:hey|okay|ok|yo)?[\s,]*(?:scruff|scruffy|scruffs|telos|scruf|scrub|scrubs|scoff)\b[\s,.!?:]*/i;
let recognizer = null;
let mode = null; // null | "ptt" | "handsfree"
let armedUntil = 0;

function voiceStatus(text) {
  $("voice-status").hidden = !text;
  $("voice-status").textContent = text ?? "";
}

function startRecognition(newMode) {
  discardRecognizer();
  const r = new Recognition();
  recognizer = r;
  mode = newMode;
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = newMode === "handsfree";
  let finalText = "";

  r.onresult = (e) => {
    if (recognizer !== r) return;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) {
        if (mode === "ptt") finalText += result[0].transcript;
        else onHandsFreeUtterance(result[0].transcript);
      } else interim += result[0].transcript;
    }
    if (mode === "ptt") {
      $("input").value = (finalText + interim).trim();
      autosize();
    } else if (interim) {
      voiceStatus(`Heard: ${interim}`);
    }
  };
  r.onerror = (e) => {
    if (recognizer !== r) return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("Microphone blocked. Allow mic access for this page (on a phone, use the keyboard's dictation button instead).", "error");
      $("handsfree").checked = false;
      stopVoice();
    }
  };
  r.onend = () => {
    if (recognizer !== r) return;
    if (mode === "handsfree") {
      try {
        r.start(); // browsers end continuous recognition every so often; keep going
      } catch {}
      return;
    }
    // Push-to-talk finished: send what was heard, then go back to hands-free if it's on.
    recognizer = null;
    mode = null;
    $("mic").classList.remove("listening");
    voiceStatus(null);
    if ($("input").value.trim()) submit();
    if ($("handsfree").checked) startRecognition("handsfree");
  };
  r.start();
  if (newMode === "ptt") {
    window.speechSynthesis?.cancel();
    $("mic").classList.add("listening");
    voiceStatus("Listening… click the mic (or Ctrl+Space) when you're done.");
  } else {
    voiceStatus('Hands-free: say "Telos, …" to ask something.');
  }
}

/** Throws away the current recognizer without triggering its end-of-speech behaviour. */
function discardRecognizer() {
  const r = recognizer;
  recognizer = null;
  if (r) {
    r.onend = null;
    r.abort();
  }
}

function stopVoice() {
  discardRecognizer();
  mode = null;
  $("mic").classList.remove("listening");
  voiceStatus(null);
}

function togglePushToTalk() {
  if (mode === "ptt") recognizer?.stop(); // onend sends the message
  else startRecognition("ptt");
}

function onHandsFreeUtterance(transcript) {
  const text = transcript.trim();
  const m = WAKE.exec(text);
  if (m) {
    const rest = text.slice(m[0].length).trim();
    if (rest) return sendVoice(rest);
    armedUntil = Date.now() + 8000;
    voiceStatus("Yes? I'm listening…");
    window.speechSynthesis?.cancel();
    return;
  }
  if (Date.now() < armedUntil && text) {
    armedUntil = 0;
    sendVoice(text);
  } else {
    voiceStatus('Hands-free: say "Telos, …" to ask something.');
  }
}

function sendVoice(text) {
  voiceStatus(`You: ${text}`);
  window.speechSynthesis?.cancel();
  send({ type: "chat", text });
}

// Local push-to-talk: the overlay (Electron has no speech service) and browsers without one.
let stopRecording = null;

async function toggleLocalVoice() {
  if (stopRecording) {
    const stop = stopRecording;
    stopRecording = null;
    setListening(false);
    voiceStatus("Transcribing…");
    send({ type: "voice", pcm: await stop() });
    return;
  }
  try {
    window.speechSynthesis?.cancel();
    stopRecording = await startRecording(() => toggleLocalVoice());
    setListening(true);
    voiceStatus("Listening… press the mic (or your talk hotkey) again to send.");
  } catch (err) {
    toast(`Couldn't use the microphone: ${err.message}`, "error");
  }
}

function setListening(on) {
  $("mic").classList.toggle("listening", on);
  window.dispatchEvent(new CustomEvent("scruff:voice", { detail: on ? "listening" : "idle" }));
}

const localVoice = Boolean(overlay) || !Recognition;
if (localVoice) {
  $("handsfree").closest("label").hidden = true;
  $("mic").title = "Push to talk (transcribed on this PC)";
  $("mic").addEventListener("click", toggleLocalVoice);
  overlay?.onTalk(toggleLocalVoice);
} else {
  $("mic").addEventListener("click", togglePushToTalk);
  $("handsfree").addEventListener("change", () => {
    if ($("handsfree").checked) {
      if (mode !== "ptt") startRecognition("handsfree");
    } else if (mode === "handsfree") {
      stopVoice();
    }
  });
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const clean = text.replace(/[*`#_]/g, "").replace(/0x[0-9A-F]+/gi, "that address");
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.08;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// ---------- composer ----------

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(160, t.scrollHeight) + "px";
  t.style.overflowY = t.scrollHeight > 160 ? "auto" : "hidden";
}

function submit() {
  const text = $("input").value.trim();
  if (!text) return;
  const btn = $("send");
  btn.classList.remove("launch");
  void btn.offsetWidth; // restart the animation if it's still playing
  btn.classList.add("launch");
  send({ type: "chat", text });
  $("input").value = "";
  autosize();
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
$("input").addEventListener("input", autosize);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.code === "Space") {
    e.preventDefault();
    if (localVoice) toggleLocalVoice();
    else togglePushToTalk();
  }
});
$("stop").addEventListener("click", () => send({ type: "stop" }));
$("new-chat").addEventListener("click", () => send({ type: "reset" }));
$("revert-all").addEventListener("click", () => send({ type: "revert_all" }));
$("game-chip").addEventListener("click", openPicker);
$("screen-chip").addEventListener("click", toggleScreen);
for (const b of document.querySelectorAll(".example")) {
  b.addEventListener("click", () => {
    $("input").value = b.textContent;
    $("input").focus();
    autosize();
  });
}
for (const tab of ["chat", "mods"]) {
  $(`tab-${tab}`).addEventListener("click", () => {
    document.querySelector(".layout").dataset.view = tab;
    $("tab-chat").setAttribute("aria-selected", String(tab === "chat"));
    $("tab-mods").setAttribute("aria-selected", String(tab === "mods"));
  });
}

// ---------- misc ----------

function setBanner(html, isHtml = false) {
  const b = $("banner");
  b.hidden = !html;
  if (isHtml) b.innerHTML = html;
  else b.textContent = html ?? "";
}

function toast(text, level = "info") {
  if (overlay) {
    window.dispatchEvent(new CustomEvent("scruff:toast", { detail: { text, level } }));
    return;
  }
  const t = el("div", `toast ${level}`, text);
  $("toasts").append(t);
  setTimeout(() => t.remove(), level === "error" ? 7000 : 3500);
}

function save() {
  try {
    localStorage.setItem("scruff.prefs", JSON.stringify({ speak: $("speak").checked }));
  } catch {}
}
try {
  const prefs = JSON.parse(localStorage.getItem("scruff.prefs") ?? "{}");
  $("speak").checked = Boolean(prefs.speak);
} catch {}
$("speak").addEventListener("change", save);

if (overlay) {
  overlay.onPanel((open) => {
    document.body.classList.toggle("panel-open", open);
    if (open) setTimeout(() => $("input").focus(), 30);
  });
  $("app-close").addEventListener("click", () => overlay.setPanel(false));
  import("./overlay.js").then((m) => m.startHud({ toolLabel }));
}

connect();

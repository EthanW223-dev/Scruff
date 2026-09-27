// Scruff dashboard: chat with the AI, see and control what it changed in your game.
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
    setBanner("Lost connection to Scruff. Is it still running? Reconnecting…");
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
      renderAi();
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
      toast(msg.text, msg.level);
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
      const target = input.value !== undefined ? fmt(input.value) : input.change ? input.change : `${fmt(input.min)}–${fmt(input.max)}`;
      return `Looking for ${input.what ?? "the value"}: ${target}`;
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
    case "use_game_adapter": return `${String(input.tool ?? "").replace("__", " → ")}`;
    default: return name;
  }
}

function renderAgentEvent(event, replay) {
  switch (event.type) {
    case "user": {
      currentTurn = null;
      const row = el("div", "msg user");
      row.append(el("div", "bubble", event.text));
      $("log").append(row);
      updateEmpty();
      scrollToEnd(true);
      break;
    }
    case "turn_start": {
      turnText = "";
      const turn = ensureTurn();
      if (!replay) turn.root.classList.add("active");
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

// What Scruff read from the game's files when it attached.
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
  $("ai-chip").querySelector(".dot").className = `dot ${aiInfo.ready ? "on" : ""}`;
  $("ai-label").textContent = aiInfo.model ? `${aiInfo.providerLabel} · ${aiInfo.model}` : "Pick an AI";
  if (!aiInfo.ready) {
    setBanner(`${aiInfo.problem ?? "The AI isn't set up yet"}, or open the AI menu to use a local model or your Claude subscription.`);
  } else if (!$("banner").textContent.startsWith("Lost connection")) {
    setBanner(null);
  }
}

let modelsMsg = null;

function openAiMenu() {
  $("provider-list").replaceChildren(el("li", "muted small", "Checking what's available…"));
  $("ai-dialog").showModal();
  send({ type: "list_models" });
}

function renderModels(msg) {
  modelsMsg = msg;
  $("provider-list").replaceChildren(
    ...msg.providers.map((p) => {
      const li = el("li");
      const label = el("label");
      const radio = el("input");
      radio.type = "radio";
      radio.name = "provider";
      radio.value = p.id;
      radio.checked = p.id === msg.current.provider;
      radio.addEventListener("change", () => pickProvider(p.id));
      const name = el("span", "name");
      name.append(el("span", `dot ${p.ready ? "on" : ""}`), p.label);
      label.append(radio, name, el("span", "detail", p.ready ? `${p.detail} · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : p.detail));
      li.append(label);
      return li;
    }),
  );
  $("model-input").value = msg.current.model;
  fillModelOptions(msg.current.provider);
  $("cc-cmd").textContent = msg.connect.claudeCode;
  $("desktop-json").textContent = msg.connect.desktopConfig;
  $("desktop-path").textContent = msg.connect.desktopConfigPath;
}

function fillModelOptions(providerId) {
  const provider = modelsMsg.providers.find((p) => p.id === providerId);
  $("model-options").replaceChildren(...(provider?.models ?? []).map((m) => Object.assign(el("option"), { value: m })));
  return provider;
}

function pickProvider(providerId) {
  const provider = fillModelOptions(providerId);
  const input = $("model-input");
  if (providerId === modelsMsg.current.provider) input.value = modelsMsg.current.model;
  else if (!provider.models.includes(input.value)) input.value = provider.models[0] ?? "";
  input.focus();
}

$("ai-chip").addEventListener("click", openAiMenu);
$("ai-apply").addEventListener("click", () => {
  const provider = document.querySelector('input[name="provider"]:checked')?.value;
  const model = $("model-input").value.trim();
  if (!provider || !model) return toast("Pick a provider and type or choose a model.", "error");
  send({ type: "set_model", provider, model });
  $("ai-dialog").close();
});
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
const WAKE = /^\s*(?:hey|okay|ok|yo)?[\s,]*(?:scruff|scruffy|scruffs|scuff|scruf|scrub|scrubs|scoff)\b[\s,.!?:]*/i;
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
    voiceStatus('Hands-free: say "Scruff, …" to ask something.');
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
    voiceStatus('Hands-free: say "Scruff, …" to ask something.');
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

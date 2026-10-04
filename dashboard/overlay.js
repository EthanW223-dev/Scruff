// The HUD: Telos's icon (a pixel sprite of the spark, see orb.js) combined with its
// reply text into ONE component (#hud-unit). The unit is just the orb at rest;
// when a reply streams in it expands to orb + text, then collapses back. The
// orb itself never leaves, so mic state (listening…) is always readable.
//
// Two windows run this page:
//   - the standalone HUD window (?hud=1): the whole UI is the unit. Dragging
//     it moves the window itself; the window never follows the game.
//   - the main overlay window: only the panel wiring + click-through live
//     here; the orb, replies, toasts and voice playback are the HUD's job.

import { SpeechStreamer } from "./audio.js";
import { AgentOrb } from "./orb.js";

const $ = (id) => document.getElementById(id);
const MAX_TOASTS = 4;

export function startHud({ toolLabel, hudOnly = false, speak = false }) {
  const bridge = window.scruffOverlay;
  if (hudOnly) startHudWindow({ bridge, toolLabel, speak });
  else startPanelWindow({ bridge });
}

/** The main overlay window: panel open/close and click-through. No orb here. */
function startPanelWindow({ bridge }) {
  // Click-through everywhere except interactive elements (the panel, which the
  // main process handles).
  let interactive = false;
  document.addEventListener("mousemove", (e) => {
    const over = Boolean(e.target.closest?.(".interactive"));
    if (over !== interactive) {
      interactive = over;
      bridge.setInteractive(over, false);
    }
  });

  // Closing the panel hands focus back to the game.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("panel-open") && !document.querySelector("dialog[open]")) {
      bridge.setPanel(false);
    }
  });
  // The open panel covers the dimmed game: a click outside its windows goes back to the game.
  document.addEventListener("mousedown", (e) => {
    if (!document.body.classList.contains("panel-open")) return;
    if (!e.target.closest(".win, .menubar, .dock, .banner, dialog, .toasts")) bridge.setPanel(false);
  });
}

/** The standalone HUD window: the orb unit, its reply text, toasts, voice. */
function startHudWindow({ bridge, toolLabel, speak }) {
  const hud = $("hud");
  const unit = $("hud-unit");
  const button = $("hud-button");
  const replyEl = $("hud-reply");
  // The tray's text lines (absent in stripped-down test DOMs: every write is guarded).
  const nameEl = $("hud-name");
  const stateEl = $("hud-state");
  const setText = (node, text) => {
    if (node) node.textContent = text;
  };
  hud.hidden = false;
  // Telos's icon: a pixel sprite of the spark. The page's ink by default; the
  // "state" handler below tints it with the active game's accent color.
  const orb = new AgentOrb($("hud-orb"), { size: 64, dark: true });
  orb.setState("connecting");
  // Hovering wakes the sprite itself (it fills in and quickens).
  button.addEventListener("mouseenter", () => orb.setHover(true));
  button.addEventListener("mouseleave", () => orb.setHover(false));

  // The mod builder (a background helper the chat AI starts): a hammering tile next to the orb
  // while it works, and for a little while after. Clicking it shows its steps in the tray.
  const buildBtn = $("hud-build");
  const buildView = $("hud-buildview");
  const buildOrb = buildBtn ? new AgentOrb($("hud-build-sprite"), { size: 32, dark: true }) : null;
  buildOrb?.setState("building");
  let build = null; // the hub's latest build
  let buildOpen = false; // its steps are showing in the tray
  const BUILD_LINGER_MS = 120_000; // a finished build's tile stays this long
  let lingerTimer = 0;
  function showBuild() {
    if (!buildBtn) return;
    const recent = build && (build.status === "running" || Date.now() - (build.endedAt ?? 0) < BUILD_LINGER_MS);
    buildBtn.hidden = !recent;
    // While the tile shows, check back now and then: a finished build's tile goes away by itself.
    if (recent && !lingerTimer) lingerTimer = setInterval(showBuild, 15_000);
    if (!recent && lingerTimer) {
      clearInterval(lingerTimer);
      lingerTimer = 0;
    }
    if (!recent && buildOpen) closeBuild();
    if (!build) return;
    buildOrb.setState(build.status === "running" ? "building" : build.status === "done" ? "breathing" : "connecting");
    buildBtn.title = `Mod builder: ${build.request} (${build.status === "running" ? "building, click to see what it's doing" : build.status})`;
    if (buildOpen) fillBuild();
  }
  function fillBuild() {
    if (!buildView || !build) return;
    const label = { running: "building", done: "built", failed: "problem", stopped: "stopped" }[build.status] ?? build.status;
    const head = document.createElement("div");
    head.className = "bv-head";
    const who = document.createElement("span");
    who.textContent = `Mod builder · ${build.game}`;
    const pill = document.createElement("span");
    pill.className = `pill ${build.status === "running" ? "on" : build.status === "failed" ? "warn" : ""}`;
    pill.textContent = label;
    head.append(who, pill);
    const req = document.createElement("div");
    req.className = "bv-req";
    req.textContent = build.request;
    const list = document.createElement("ol");
    for (const step of (build.steps ?? []).slice(-6)) {
      const li = document.createElement("li");
      li.className = step.kind;
      li.textContent = step.kind === "say" ? step.text : `› ${step.text}`;
      list.append(li);
    }
    const parts = [head, req, list];
    if (build.status === "running") {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "danger";
      stop.textContent = "Stop";
      stop.addEventListener("click", (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("scruff:send", { detail: { type: "workshop_stop", id: build.id } }));
      });
      parts.push(stop);
    } else if (build.summary || build.error) {
      const end = document.createElement("div");
      end.className = `bv-end ${build.error ? "warn" : ""}`;
      end.textContent = build.error ?? build.summary;
      parts.push(end);
    }
    buildView.replaceChildren(...parts);
  }
  function openBuild() {
    if (!buildView) return;
    if (replyOpen) closeReply();
    buildOpen = true;
    wake();
    unit.classList.add("expanded");
    buildView.hidden = false;
    fillBuild();
  }
  function closeBuild() {
    buildOpen = false;
    if (buildView) buildView.hidden = true;
    if (!replyOpen) unit.classList.remove("expanded");
  }
  buildBtn?.addEventListener("click", (e) => {
    // Not the tray's own click (that opens the panel), and not the end of a drag.
    e.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (buildOpen) closeBuild();
    else openBuild();
  });
  buildView?.addEventListener("click", (e) => e.stopPropagation());

  let game = null;
  let busy = false;
  let working = "";
  let toolOrb = null; // the tool-driven orb animation (searching/solving/working),
  // kept while background work runs so game state ticks don't stomp it
  let listening = false;
  let voice = "";
  let replyOpen = false;
  let replyText = "";
  let collapseTimer = 0;
  let keys = "";
  let shapeTimer = 0; // reverts the shaping flash after a mod lands
  let placedCorner = null; // the theme corner the tray was last sent to
  // Spoken replies: which neural engine + voice, and whether they're on (from the hello/models message).
  let voiceEnabled = false;
  let voiceEngine = "edge";
  let voiceName = "en-US-AndrewNeural";
  let voiceReady = true; // older hubs don't send it; don't nag when it's absent

  let openKey = "";
  bridge.hotkeys().then(({ panel, talk }) => {
    keys = `Open: ${pretty(panel)}  ·  Talk: ${pretty(talk)}`;
    openKey = pretty(panel);
    idle();
  });

  // Idle, the tray tucks away to just the orb in its corner; activity or the mouse brings it back.
  const TUCK_MS = 9000;
  let hovering = false;
  let tuckTimer = 0;
  function wake() {
    unit.classList.remove("compact");
    clearTimeout(tuckTimer);
    tuckTimer = setTimeout(tuck, TUCK_MS);
  }
  function tuck() {
    if (hovering || busy || listening || replyOpen || voice || buildOpen) return;
    unit.classList.add("compact");
  }
  unit.addEventListener("mouseenter", () => {
    hovering = true;
    wake();
  });
  unit.addEventListener("mouseleave", () => {
    hovering = false;
    wake();
  });

  // Each mode dissolves the orb into its matching animation; busy also runs
  // marching ants round its tile (see style.css).
  const ORB_FOR_MODE = { idle: "breathing", listening: "listening", busy: "composing" };
  function status(text, mode = "idle", orbState = null) {
    const was = hud.dataset.mode;
    hud.dataset.mode = mode;
    orb.setState(orbState ?? ORB_FOR_MODE[mode] ?? "breathing");
    button.title = [text, keys].filter(Boolean).join("\n");
    button.setAttribute("aria-label", text);
    // The tray's status line: what Telos is doing, or how to open it.
    setText(stateEl, mode === "idle" ? (openKey ? `Ready · ${openKey} to open` : "Ready") : text);
    setText(nameEl, game ?? "No game yet");
    if (mode !== "idle" || was !== mode) wake();
  }
  function idle() {
    if (listening) return status("Listening…", "listening");
    if (voice) return status(voice, "busy");
    // Busy with background work: keep the tool's own animation (searching /
    // solving / working) instead of falling back to composing, and keep the
    // weaving animation while reply text is streaming in.
    if (busy) return status(replyOpen ? "Replying…" : working || "Thinking…", "busy", replyOpen ? "weaving" : toolOrb);
    status(game ? `Telos · ${game}` : "Telos");
  }

  // A notification: an icon tile, a title, the text, and a bar counting down until it goes.
  function toast(text, kind = "", ms = 6000) {
    wake();
    const part = (tag, cls, content) => {
      const n = document.createElement(tag);
      n.className = cls;
      if (content !== undefined) n.textContent = content;
      return n;
    };
    const t = part("div", `hud-toast ${kind}`);
    const glyph = { you: "▸", error: "!", step: "»" }[kind] ?? "✦";
    const main = part("div", "t-main");
    if (kind !== "step") main.append(part("div", "t-title", kind === "you" ? "You" : kind === "error" ? "Problem" : "Telos"));
    main.append(part("div", "body", text));
    t.append(part("span", "t-glyph", glyph), main);
    if (ms) {
      const ttl = part("i", "t-ttl");
      ttl.style.animationDuration = `${ms}ms`;
      t.append(ttl);
    }
    $("hud-toasts").append(t);
    while ($("hud-toasts").children.length > MAX_TOASTS) $("hud-toasts").firstElementChild.remove();
    if (ms) fadeOut(t, ms);
    return t;
  }
  function fadeOut(t, ms) {
    setTimeout(() => {
      t.classList.add("fade");
      setTimeout(() => t.remove(), 700);
    }, ms);
  }

  /** Shows "Speaking…" on the orb while the voice reply plays. */
  function setSpeaking(on) {
    window.dispatchEvent(new CustomEvent("scruff", { detail: { type: "voice_status", text: on ? "Speaking…" : "" } }));
  }

  // Sentence-by-sentence speech: the voice starts while the reply is still
  // streaming in, keeping pace with the text instead of lagging a full reply.
  // Only the HUD window ever plays audio — never the panel window or a tab.
  const streamer = new SpeechStreamer({
    makeUrl: (sentence) =>
      `/voice/say?engine=${encodeURIComponent(voiceEngine)}&voice=${encodeURIComponent(voiceName)}&text=${encodeURIComponent(sentence.slice(0, 600))}`,
    onSpeaking: setSpeaking,
  });

  /** Warn once per turn when the selected engine is missing. */
  let warnedEngine = "";
  function warnEngineIfMissing() {
    if (!voiceReady && warnedEngine !== voiceEngine) {
      warnedEngine = voiceEngine;
      toast(
        voiceEngine === "kokoro"
          ? "Kokoro isn't installed on the PC yet — run: python -m pip install kokoro-onnx espeakng_loader, then restart Telos"
          : "Voice engine not installed — run: python -m pip install edge-tts",
        "error",
      );
    }
  }

  /** Little pop on the orb each time a batch of reply text lands (throttled). */
  let lastPop = 0;
  function pop() {
    const now = Date.now();
    if (now - lastPop < 500) return;
    lastPop = now;
    button.classList.remove("pop");
    void button.offsetWidth; // restart the animation
    button.classList.add("pop");
  }

  /** The orb becomes the text: the unit expands to orb + reply as one piece. */
  function openReply() {
    if (buildOpen) closeBuild();
    wake();
    replyOpen = true;
    clearTimeout(collapseTimer);
    unit.classList.add("expanded");
    replyEl.hidden = false;
  }
  function closeReply() {
    replyOpen = false;
    clearTimeout(collapseTimer);
    unit.classList.remove("expanded");
    replyEl.hidden = true;
    replyEl.textContent = "";
    replyText = "";
  }

  function onAgent(e) {
    switch (e.type) {
      case "user":
        toast(e.text, "you", 6000);
        closeReply();
        streamer.stop();
        break;
      case "turn_start":
        busy = true;
        working = "";
        idle();
        break;
      case "tool_call":
        busy = true;
        working = `${toolLabel(e.name, e.input)}…`;
        // The orb matches the tool: searching, solving, or plain working. This
        // is remembered in toolOrb so the animation survives game state ticks
        // until the turn ends.
        toolOrb = /search/i.test(e.name) ? "searching" : /solve|plan/i.test(e.name) ? "solving" : "working";
        status(working, "busy", toolOrb);
        // Text before and after a tool call are separate thoughts.
        if (replyText && !/\s$/.test(replyText)) replyText += " ";
        break;
      case "text":
        if (!replyOpen) {
          openReply();
          // The reply is being written: the orb types it out.
          orb.setState("weaving");
          // Speak the reply as it streams.
          const speakChecked = document.getElementById("speak")?.checked !== false;
          if (speak && voiceEnabled && speakChecked) {
            warnEngineIfMissing();
            streamer.start();
          }
        }
        replyText += e.text;
        replyEl.textContent = replyText.replace(/\*\*|`/g, "");
        streamer.push(e.text);
        pop();
        break;
      case "error":
        toast(e.text, "error", 9000);
        break;
      case "notice":
        toast(e.text, "step", 4000);
        break;
      case "turn_end":
        busy = false;
        working = "";
        toolOrb = null;
        if (replyOpen) {
          // Leave time to read it, then collapse the unit back to just the orb.
          clearTimeout(collapseTimer);
          collapseTimer = setTimeout(closeReply, 8000 + Math.min(12000, replyText.length * 40));
        }
        idle();
        // The streamer has been speaking the reply sentence-by-sentence as
        // it arrived; flush the tail. Errors and notices never reach here.
        streamer.finish();
        break;
    }
  }

  function renderMods(watch) {
    const frozen = watch.filter((w) => w.frozen).slice(0, 6);
    $("hud-mods").replaceChildren(
      ...frozen.map((w) => {
        const row = document.createElement("div");
        row.className = "hud-mod";
        const label = document.createElement("span");
        label.className = "k";
        label.textContent = w.label;
        const value = document.createElement("b");
        value.textContent = typeof w.value === "number" ? (Math.round(w.value * 100) / 100).toLocaleString() : "?";
        row.append(label, value);
        return row;
      }),
    );
  }

  function setListening(on) {
    listening = on;
    // Don't let a spoken reply bleed into the new recording.
    if (listening) streamer.stop();
    idle();
  }

  window.addEventListener("scruff", (e) => {
    const msg = e.detail;
    if (msg.type === "agent") onAgent(msg.event);
    else if (msg.type === "history") busy = false;
    else if (msg.type === "hello" || msg.type === "models") {
      const ai = msg.type === "hello" ? msg.ai : msg.current;
      if (ai) {
        voiceEnabled = Boolean(ai.voiceEnabled);
        voiceEngine = ai.voiceEngine === "kokoro" ? "kokoro" : "edge";
        voiceName = ai.voice || voiceName;
        voiceReady = ai.voiceReady !== false;
        // The composer "read aloud" checkbox lives in the panel (main window);
        // here it is hidden, so mirror the hub's setting — the hub is the truth.
        const speakBox = document.getElementById("speak");
        if (speakBox) speakBox.checked = voiceEnabled;
      }
    } else if (msg.type === "state") {
      const attached = msg.game.attached;
      game = attached ? attached.title || attached.name.replace(/\.exe$/i, "") : null;
      renderMods(attached?.watch ?? []);
      // The orb's ink: black & white on the default theme, the game's accent
      // color once the game has a theme of its own. (The page's --accent is
      // already handled by applyTheme in app.js; this is the canvas ink.)
      if (msg.theme) orb.setColor(msg.theme.source === "default" ? null : msg.theme.accent);
      if (msg.theme) buildOrb?.setColor(msg.theme.source === "default" ? null : msg.theme.accent);
      // The mod builder: a new build brings the tray out; its tile shows while it works.
      const nextBuild = msg.workshop?.job ?? null;
      if (nextBuild && nextBuild.status === "running" && (!build || build.id !== nextBuild.id)) wake();
      build = nextBuild;
      showBuild();
      // A game's own theme says which corner its HUD leaves free: the tray goes there
      // (unless the player has dragged it somewhere).
      const corner = msg.theme && msg.theme.source !== "default" ? msg.theme.corner : null;
      if (corner && corner !== placedCorner) {
        placedCorner = corner;
        try {
          bridge.placeHud?.(corner);
        } catch {}
      }
      idle();
    } else if (msg.type === "voice_status") {
      voice = msg.text;
      idle();
    } else if (msg.type === "game_event") {
      toast(msg.event.text, "step", 5000);
      // A mod just landed on the game: flash the shaping orb, then settle back.
      orb.setState("shaping");
      clearTimeout(shapeTimer);
      shapeTimer = setTimeout(() => idle(), 2500);
    }
  });
  window.addEventListener("scruff:voice", (e) => setListening(e.detail === "listening"));
  // Recording can start from the panel window too (its mic button / the shared
  // talk hotkey path); the main process relays it here so the orb still shows it.
  try {
    bridge.onListening?.((on) => setListening(Boolean(on)));
  } catch {}
  window.addEventListener("scruff:toast", (e) => toast(e.detail.text, e.detail.level === "error" ? "error" : "step", 5000));

  // Click-through everywhere except the unit. Dragging the unit moves the
  // whole window — the HUD is its own thing, it never follows the game.
  let interactive = false;
  document.addEventListener("mousemove", (e) => {
    const over = Boolean(e.target.closest?.(".interactive"));
    if (over !== interactive) {
      interactive = over;
      bridge.setInteractive(over, true);
    }
  });
  let drag = null;
  let suppressClick = false;
  const HUD_POS_KEY = "telos-hud-pos-v2"; // pre-separate-window spot; migrated once, then retired
  unit.addEventListener("pointerdown", async (e) => {
    // The build tile and its steps are buttons of their own: capturing the pointer for a drag
    // would hand their click to the tray (which opens the panel).
    if (e.target.closest?.("#hud-build, #hud-buildview")) return;
    drag = { x0: e.clientX, y0: e.clientY, moved: false };
    try {
      const b = await bridge.getHudBounds?.();
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
        drag.winX = b.x;
        drag.winY = b.y;
        drag.sx = e.screenX;
        drag.sy = e.screenY;
      }
      unit.setPointerCapture(e.pointerId);
    } catch {}
  });
  unit.addEventListener("pointermove", (e) => {
    if (!drag || drag.winX === undefined) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= 6) return;
      drag.moved = true;
    }
    try {
      bridge.moveHud?.(Math.round(drag.winX + (e.screenX - drag.sx)), Math.round(drag.winY + (e.screenY - drag.sy)));
    } catch {}
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) suppressClick = true; // swallow the click that ends a drag
    drag = null;
  };
  unit.addEventListener("pointerup", endDrag);
  unit.addEventListener("pointercancel", endDrag);
  unit.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    // The panel lives in the main overlay window; a clean click opens it.
    bridge.setPanel(true);
  });
  // First run in the separate window: honor the spot he dragged the orb to
  // back when it lived inside the game overlay, then retire that key. The old
  // spot is the unit's position; the window's top-left sits ~8px above-left
  // of the unit (page padding), and the main process clamps it on-screen.
  try {
    const s = JSON.parse(localStorage.getItem(HUD_POS_KEY) ?? "null");
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      bridge.moveHud?.(Math.round(s.x) - 8, Math.round(s.y) - 8);
    }
    localStorage.removeItem(HUD_POS_KEY);
    localStorage.removeItem("telos-hud-pos");
  } catch {}

  idle();
}

function pretty(accelerator) {
  return String(accelerator ?? "").replace("CommandOrControl", "Ctrl");
}

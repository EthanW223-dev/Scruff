// The in-game HUD: one button (Telos's icon — a thinking-orbs canvas, see orb.js), Telos's replies
// as little windows, and the values it's holding. Everything is click-through except the button;
// the full panel opens with a hotkey or a click on it. The button is draggable (see below).

import { SpeechStreamer } from "./audio.js";
import { AgentOrb } from "./orb.js";

const $ = (id) => document.getElementById(id);
const MAX_TOASTS = 4;

export function startHud({ toolLabel }) {
  const bridge = window.scruffOverlay;
  const hud = $("hud");
  const button = $("hud-button");
  hud.hidden = false;
  // Telos's icon: a thinking-orbs canvas. Black & white ink by default; the
  // "state" handler below tints it with the active game's accent color.
  const orb = new AgentOrb($("hud-orb"), { size: 64, dark: true });
  orb.setState("connecting");
  // Hovering wakes the orb itself (it brightens and quickens) instead of
  // putting a shiny glow around it.
  button.addEventListener("mouseenter", () => orb.setHover(true));
  button.addEventListener("mouseleave", () => orb.setHover(false));
  // Only true when this page runs inside the Electron overlay (not a browser tab).
  const overlayMode = document.body.classList.contains("overlay");

  let game = null;
  let busy = false;
  let working = "";
  let listening = false;
  let voice = "";
  let reply = null;
  let replyText = "";
  let keys = "";
  let shapeTimer = 0; // reverts the shaping flash after a mod lands
  // Spoken replies: which neural engine + voice, and whether they're on (from the hello/models message).
  let voiceEnabled = false;
  let voiceEngine = "edge";
  let voiceName = "en-US-AndrewNeural";
  let voiceReady = true; // older hubs don't send it; don't nag when it's absent

  bridge.hotkeys().then(({ panel, talk }) => {
    keys = `Open: ${pretty(panel)}  ·  Talk: ${pretty(talk)}`;
    idle();
  });

  // The button has no text: its state shows as a frame around it, the details in its tooltip.
  // Each mode also melts the orb into its matching thinking-orbs animation.
  const ORB_FOR_MODE = { idle: "breathing", listening: "listening", busy: "composing" };
  function status(text, mode = "idle", orbState = null) {
    hud.dataset.mode = mode;
    orb.setState(orbState ?? ORB_FOR_MODE[mode] ?? "breathing");
    button.title = [text, keys].filter(Boolean).join("\n");
    button.setAttribute("aria-label", text);
  }
  function idle() {
    if (listening) return status("Listening…", "listening");
    if (voice) return status(voice, "busy");
    if (busy) return status(working || "Thinking…", "busy");
    status(game ? `Telos · ${game}` : "Telos");
  }

  function toast(text, kind = "", ms = 6000) {
    const t = document.createElement("div");
    t.className = `hud-toast ${kind}`;
    if (kind !== "step") {
      const bar = document.createElement("div");
      bar.className = "win-bar";
      bar.textContent = kind === "you" ? "YOU" : kind === "error" ? "ERROR" : "SCRUFF";
      t.append(bar);
    }
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = text;
    t.append(body);
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

  /** Shows "Speaking…" on the HUD button while the voice reply plays. */
  function setSpeaking(on) {
    window.dispatchEvent(new CustomEvent("scruff", { detail: { type: "voice_status", text: on ? "Speaking…" : "" } }));
  }

  // Sentence-by-sentence speech: the voice starts while the reply is still
  // streaming in, keeping pace with the text instead of lagging a full reply.
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

  function onAgent(e) {
    switch (e.type) {
      case "user":
        toast(e.text, "you", 6000);
        reply = null;
        replyText = "";
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
        // The orb matches the tool: searching, solving, or plain working.
        status(working, "busy", /search/i.test(e.name) ? "searching" : /solve|plan/i.test(e.name) ? "solving" : "working");
        // Text before and after a tool call are separate thoughts.
        if (replyText && !/\s$/.test(replyText)) replyText += " ";
        break;
      case "text":
        if (!reply) {
          reply = toast("", "", 0);
          // The reply is being woven together: melt into the weaving orb.
          orb.setState("weaving");
          // Speak the reply as it streams: only the overlay plays here, never a browser tab.
          const speakChecked = document.getElementById("speak")?.checked !== false;
          if (overlayMode && voiceEnabled && speakChecked) {
            warnEngineIfMissing();
            streamer.start();
          }
        }
        replyText += e.text;
        reply.querySelector(".body").textContent = replyText.replace(/\*\*|`/g, "");
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
        {
          if (reply) fadeOut(reply, 8000 + Math.min(12000, replyText.length * 40));
          reply = null;
          replyText = "";
          idle();
          // The streamer has been speaking the reply sentence-by-sentence as
          // it arrived; flush the tail. Errors and notices never reach here.
          streamer.finish();
        }
        break;
    }
  }

  function renderMods(watch) {
    const frozen = watch.filter((w) => w.frozen).slice(0, 6);
    $("hud-mods").replaceChildren(
      ...frozen.map((w) => {
        const chip = document.createElement("span");
        chip.className = "hud-mod";
        const value = document.createElement("b");
        value.textContent = typeof w.value === "number" ? (Math.round(w.value * 100) / 100).toLocaleString() : "?";
        chip.append(`${w.label} `, value);
        return chip;
      }),
    );
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
      }
    } else if (msg.type === "state") {
      const attached = msg.game.attached;
      game = attached ? attached.title || attached.name.replace(/\.exe$/i, "") : null;
      renderMods(attached?.watch ?? []);
      // The orb's ink: black & white on the default theme, the game's accent
      // color once the game has a theme of its own. (The page's --accent is
      // already handled by applyTheme in app.js; this is the canvas ink.)
      if (msg.theme) orb.setColor(msg.theme.source === "default" ? null : msg.theme.accent);
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
  window.addEventListener("scruff:voice", (e) => {
    listening = e.detail === "listening";
    // Don't let a spoken reply bleed into the new recording.
    if (listening) streamer.stop();
    idle();
  });
  window.addEventListener("scruff:toast", (e) => toast(e.detail.text, e.detail.level === "error" ? "error" : "step", 5000));

  // Click-through everywhere except the button (and the panel, which the main process handles).
  let interactive = false;
  document.addEventListener("mousemove", (e) => {
    const over = Boolean(e.target.closest?.(".interactive"));
    if (over !== interactive) {
      interactive = over;
      bridge.setInteractive(over);
    }
  });
  // Draggable button: a pointerdown starts a potential drag, and once the pointer moves
  // more than 6px it becomes a drag — the button follows at position:fixed and the spot is
  // remembered in localStorage. A clean pointerup keeps the normal click (toggles the panel);
  // the click after a drag is swallowed. The click-through overlay keeps working because the
  // button itself still has pointer-events:auto.
  //
  // The spot is 100% the user's: it is stored in screen coordinates and the button is only
  // ever positioned from that saved spot — or from the theme corner, before the first drag.
  // The overlay window follows the game window around (see followGame in overlay/main.mjs),
  // so the page translates screen coords into viewport coords using the window's current
  // screen offset. The game moving, resizing, or switching never moves the button on screen.
  // localStorage is written only by drags; automatic re-seats never rewrite it.
  const HUD_POS_KEY = "telos-hud-pos-v2"; // v1 stored viewport coords; v2 stores screen coords
  let winOffset = { x: 0, y: 0 }; // screen coords of the viewport's top-left corner
  let savedSpot = null; // {x, y} in screen coords, null until the first drag
  let drag = null;
  let suppressClick = false;
  try {
    const s = JSON.parse(localStorage.getItem(HUD_POS_KEY) ?? "null");
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) savedSpot = { x: s.x, y: s.y };
  } catch {}
  function placeButton(x, y) {
    button.style.position = "fixed";
    button.style.left = `${Math.round(x)}px`;
    button.style.top = `${Math.round(y)}px`;
    button.style.zIndex = "9999";
  }
  /** Seat the button at a screen-coordinate spot, clamped minimally into the window. */
  function placeAtScreen(sx, sy) {
    const vx = Math.round(sx - winOffset.x);
    const vy = Math.round(sy - winOffset.y);
    // The window may have shrunk around the saved spot: keep the button as close as
    // possible to where the user put it, never jump it back to a default. The saved
    // spot itself is untouched, so it returns exactly when the window grows back.
    const w = button.offsetWidth || 48;
    const h = button.offsetHeight || 48;
    placeButton(
      Math.min(Math.max(vx, 0), Math.max(0, window.innerWidth - w)),
      Math.min(Math.max(vy, 0), Math.max(0, window.innerHeight - h)),
    );
  }
  const applySavedSpot = () => {
    if (savedSpot && !drag?.moved) placeAtScreen(savedSpot.x, savedSpot.y);
  };
  // Learn the window's screen offset, then seat the button. Falls back gracefully when
  // the wrapper predates this protocol (offset stays 0,0).
  let offsetSettled = false;
  const settleOffset = (b) => {
    if (offsetSettled) return;
    offsetSettled = true;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) winOffset = { x: b.x, y: b.y };
    applySavedSpot();
  };
  try {
    const p = bridge.getWindowBounds?.();
    if (p && typeof p.then === "function") p.then(settleOffset, () => settleOffset(null));
    else settleOffset(null);
  } catch {
    settleOffset(null);
  }
  setTimeout(() => settleOffset(null), 800);
  // The game window moved under us: re-seat at the saved screen spot (clamped, not rewritten).
  try {
    bridge.onWindowBounds?.((b) => {
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
      winOffset = { x: b.x, y: b.y };
      applySavedSpot();
    });
  } catch {}
  // Safety net: a viewport resize the main process didn't report still re-seats minimally.
  window.addEventListener("resize", applySavedSpot);
  button.addEventListener("pointerdown", (e) => {
    drag = { x0: e.clientX, y0: e.clientY, moved: false, offX: 0, offY: 0 };
    try {
      button.setPointerCapture(e.pointerId);
    } catch {}
  });
  button.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= 6) return;
      drag.moved = true;
      const rect = button.getBoundingClientRect();
      drag.offX = drag.x0 - rect.left;
      drag.offY = drag.y0 - rect.top;
    }
    placeButton(e.clientX - drag.offX, e.clientY - drag.offY);
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) {
      const rect = button.getBoundingClientRect();
      // The only writer: the user's drag, stored in screen coordinates.
      savedSpot = { x: Math.round(rect.left + winOffset.x), y: Math.round(rect.top + winOffset.y) };
      try {
        localStorage.setItem(HUD_POS_KEY, JSON.stringify(savedSpot));
        localStorage.removeItem("telos-hud-pos"); // v1 viewport-coord key, now meaningless
      } catch {}
      suppressClick = true;
    }
    drag = null;
  };
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);
  button.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    bridge.setPanel(!document.body.classList.contains("panel-open"));
  });

  // Closing the panel hands focus back to the game.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("panel-open") && !document.querySelector("dialog[open]")) {
      bridge.setPanel(false);
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (!document.body.classList.contains("panel-open")) return;
    if (!e.target.closest(".app, dialog, .hud-button")) bridge.setPanel(false);
  });

  idle();
}

function pretty(accelerator) {
  return String(accelerator ?? "").replace("CommandOrControl", "Ctrl");
}

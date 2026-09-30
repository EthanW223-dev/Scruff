// The in-game HUD: one button (the skull orb, inlined from dashboard/button.svg), Telos's replies
// as little windows, and the values it's holding. Everything is click-through except the button;
// the full panel opens with a hotkey or a click on it. The button is draggable (see below).

const $ = (id) => document.getElementById(id);
const MAX_TOASTS = 4;

export function startHud({ toolLabel }) {
  const bridge = window.scruffOverlay;
  const hud = $("hud");
  const button = $("hud-button");
  hud.hidden = false;
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
  // Spoken replies: which neural voice, and whether they're on (from the hello/models message).
  let voiceEnabled = false;
  let voiceName = "en-US-AriaNeural";
  let ttsAudio = null;

  bridge.hotkeys().then(({ panel, talk }) => {
    keys = `Open: ${pretty(panel)}  ·  Talk: ${pretty(talk)}`;
    idle();
  });

  // The button has no text: its state shows as a frame around it, the details in its tooltip.
  function status(text, mode = "idle") {
    hud.dataset.mode = mode;
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

  /** Plays a spoken reply through the hub's /voice/say TTS route. Never called for errors/notices. */
  function speakReply(text) {
    if (ttsAudio) ttsAudio.pause();
    const audio = new Audio(`/voice/say?voice=${encodeURIComponent(voiceName)}&text=${encodeURIComponent(text.slice(0, 600))}`);
    ttsAudio = audio;
    setSpeaking(true);
    const done = () => {
      if (ttsAudio === audio) {
        ttsAudio = null;
        setSpeaking(false);
      }
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    audio.play().catch(done);
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
        break;
      case "turn_start":
        busy = true;
        working = "";
        idle();
        break;
      case "tool_call":
        busy = true;
        working = `${toolLabel(e.name, e.input)}…`;
        idle();
        // Text before and after a tool call are separate thoughts.
        if (replyText && !/\s$/.test(replyText)) replyText += " ";
        break;
      case "text":
        if (!reply) reply = toast("", "", 0);
        replyText += e.text;
        reply.querySelector(".body").textContent = replyText.replace(/\*\*|`/g, "");
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
          const said = replyText.trim();
          if (reply) fadeOut(reply, 8000 + Math.min(12000, replyText.length * 40));
          reply = null;
          replyText = "";
          idle();
          // Spoken replies, overlay mode only: a browser dashboard tab must never double-play.
          // Errors and notices never reach here; only the assistant's reply text does.
          if (overlayMode && voiceEnabled && said) speakReply(said);
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
        voiceName = ai.voice || voiceName;
      }
    } else if (msg.type === "state") {
      const attached = msg.game.attached;
      game = attached ? attached.title || attached.name.replace(/\.exe$/i, "") : null;
      renderMods(attached?.watch ?? []);
      idle();
    } else if (msg.type === "voice_status") {
      voice = msg.text;
      idle();
    } else if (msg.type === "game_event") {
      toast(msg.event.text, "step", 5000);
    }
  });
  window.addEventListener("scruff:voice", (e) => {
    listening = e.detail === "listening";
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
  let drag = null;
  let suppressClick = false;
  function placeButton(x, y) {
    button.style.position = "fixed";
    button.style.left = `${Math.round(x)}px`;
    button.style.top = `${Math.round(y)}px`;
    button.style.zIndex = "9999";
  }
  try {
    const saved = JSON.parse(localStorage.getItem("telos-hud-pos") ?? "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) placeButton(saved.x, saved.y);
  } catch {}
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
      try {
        localStorage.setItem("telos-hud-pos", JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
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

// The in-game HUD: one button (dashboard/button.svg), Scruff's replies as little windows, and
// the values it's holding. Everything is click-through except the button; the full panel opens
// with a hotkey or a click on it.

const $ = (id) => document.getElementById(id);
const MAX_TOASTS = 4;

export function startHud({ toolLabel }) {
  const bridge = window.scruffOverlay;
  const hud = $("hud");
  const button = $("hud-button");
  hud.hidden = false;

  let game = null;
  let busy = false;
  let working = "";
  let listening = false;
  let voice = "";
  let reply = null;
  let replyText = "";
  let keys = "";

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
    status(game ? `Scruff · ${game}` : "Scruff");
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
        if (reply) fadeOut(reply, 8000 + Math.min(12000, replyText.length * 40));
        reply = null;
        replyText = "";
        idle();
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
    else if (msg.type === "state") {
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
  button.addEventListener("click", () => bridge.setPanel(!document.body.classList.contains("panel-open")));

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

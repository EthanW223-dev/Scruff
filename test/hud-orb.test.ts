import assert from "node:assert/strict";
import { test } from "node:test";

// Drives the real dashboard/overlay.js startHud() (standalone HUD window mode)
// with a stub DOM, proving:
// 1. background tool work keeps its own orb animation (searching/solving/working)
//    even when game state ticks arrive mid-turn (they used to stomp it to composing);
// 2. the orb and its reply are ONE component: a reply expands the unit to
//    orb + text beside the still-live orb, then collapses back to just the orb.
// 3. busy lights the activity ring (hud data-mode) while tools/thinking run.

// @ts-ignore: no declaration file for the dashboard JS
const { startHud } = (await import("../dashboard/overlay.js")) as {
  startHud: (opts: { toolLabel: (name: string, input: unknown) => string; hudOnly: boolean; speak: boolean }) => void;
};

const ctxProxy = new Proxy(
  {},
  {
    get: (_t, p) => (typeof p === "string" ? (..._a: unknown[]) => {} : undefined),
    set: () => true,
  },
);

function makeEl(tag = "div"): any {
  const children: any[] = [];
  const el: any = {
    tag,
    children,
    className: "",
    style: {},
    dataset: {},
    textContent: "",
    title: "",
    hidden: false,
    ariaLabel: "",
    removed: false,
    classList: {
      add: (c: string) => {
        if (!el.className.split(" ").includes(c)) el.className += (el.className ? " " : "") + c;
      },
      remove: (c: string) => {
        el.className = el.className
          .split(" ")
          .filter((x: string) => x && x !== c)
          .join(" ");
      },
      contains: (c: string) => el.className.split(" ").includes(c),
    },
    append: (...nodes: any[]) => {
      children.push(...nodes);
    },
    prepend: (...nodes: any[]) => {
      children.unshift(...nodes);
    },
    replaceChildren: (...nodes: any[]) => {
      children.length = 0;
      children.push(...nodes);
    },
    remove: () => {
      el.removed = true;
    },
    addEventListener: () => {},
    setAttribute: (k: string, v: string) => {
      if (k === "aria-label") el.ariaLabel = v;
    },
    querySelector: (sel: string) => {
      const cls = sel.replace(/^\./, "");
      const find = (nodes: any[]): any => {
        for (const n of nodes) {
          if (String(n.className ?? "").split(" ").includes(cls)) return n;
          const r = find(n.children ?? []);
          if (r) return r;
        }
        return null;
      };
      return find(children);
    },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 64, height: 64 }),
    offsetWidth: 64,
    offsetHeight: 64,
  };
  if (tag === "canvas") {
    el.width = 0;
    el.height = 0;
    el.getContext = () => ctxProxy;
  }
  return el;
}

function setupDom() {
  const listeners: Record<string, (e: any) => void> = {};
  const byId: Record<string, any> = {
    hud: makeEl(),
    "hud-unit": makeEl(),
    "hud-button": makeEl("button"),
    "hud-orb": makeEl("canvas"),
    "hud-reply": makeEl(),
    "hud-toasts": makeEl(),
    "hud-mods": makeEl(),
  };
  const body = makeEl();
  body.classList.contains = () => false;
  byId["hud"].hidden = true; // <div id="hud" hidden>
  byId["hud-reply"].hidden = true; // <div id="hud-reply" hidden>
  (globalThis as any).window = {
    addEventListener: (type: string, fn: (e: any) => void) => {
      listeners[type] = fn;
    },
    dispatchEvent: () => {},
    innerWidth: 1920,
    innerHeight: 1080,
    scruffOverlay: {
      hotkeys: () => Promise.resolve({ panel: "Ctrl+Alt+T", talk: "Ctrl+Alt+Space" }),
      setInteractive: () => {},
      setPanel: () => {},
      moveHud: () => {},
      getHudBounds: () => Promise.resolve({ x: 100, y: 100, width: 520, height: 300 }),
      onListening: () => {},
      getWindowBounds: () => undefined,
      onWindowBounds: () => {},
    },
  };
  (globalThis as any).document = {
    getElementById: (id: string) => byId[id],
    createElement: (tag: string) => makeEl(tag),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    body,
    visibilityState: "visible",
  };
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (globalThis as any).matchMedia = () => ({ matches: false });
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
  (globalThis as any).clearTimeout = () => {};
  const timers: (() => void)[] = [];
  (globalThis as any).setTimeout = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };
  const drainTimers = () => {
    while (timers.length) timers.shift()!();
  };
  const scruff = (msg: any) => listeners["scruff"]({ detail: msg });
  const voice = (detail: string) => listeners["scruff:voice"]({ detail });
  return { byId, scruff, voice, drainTimers };
}

const tick = () => new Promise((r) => setImmediate(r));
const hudOpts = { toolLabel: (name: string) => `${name}`, hudOnly: true, speak: false };

test("tool work keeps its orb animation across game state ticks", async () => {
  const { byId, scruff } = setupDom();
  startHud(hudOpts);
  await tick();
  await tick();
  const orbCanvas = byId["hud-orb"];
  assert.equal(orbCanvas.ariaLabel, "Thinking…");

  // Background work starts: searching the code.
  scruff({ type: "agent", event: { type: "tool_call", name: "search_code", input: {} } });
  assert.equal(orbCanvas.ariaLabel, "Searching…");

  // A game state tick arrives mid-tool (theme/watch update). The searching
  // animation must survive it, not fall back to composing.
  scruff({ type: "state", game: { attached: null }, theme: { source: "default" } });
  assert.equal(orbCanvas.ariaLabel, "Searching…");

  // Another tool: solving.
  scruff({ type: "agent", event: { type: "tool_call", name: "solve_plan", input: {} } });
  assert.equal(orbCanvas.ariaLabel, "Solving…");
  scruff({ type: "state", game: { attached: null }, theme: { source: "default" } });
  assert.equal(orbCanvas.ariaLabel, "Solving…");

  // Turn ends: back to idle breathing.
  scruff({ type: "agent", event: { type: "turn_end" } });
  assert.equal(orbCanvas.ariaLabel, "Thinking…");
});

test("busy lights the activity ring while tools/thinking run", async () => {
  const { byId, scruff } = setupDom();
  startHud(hudOpts);
  await tick();
  await tick();
  const hud = byId["hud"];
  assert.equal(hud.dataset.mode, "idle");

  scruff({ type: "agent", event: { type: "turn_start" } });
  assert.equal(hud.dataset.mode, "busy");
  scruff({ type: "agent", event: { type: "tool_call", name: "search_code", input: {} } });
  assert.equal(hud.dataset.mode, "busy");

  scruff({ type: "agent", event: { type: "turn_end" } });
  assert.equal(hud.dataset.mode, "idle");
});

test("the orb and its reply are one component: the unit expands and collapses", async () => {
  const { byId, scruff, voice, drainTimers } = setupDom();
  startHud(hudOpts);
  await tick();
  await tick();
  const orbCanvas = byId["hud-orb"];
  const unit = byId["hud-unit"];
  const replyEl = byId["hud-reply"];

  // At rest: just the orb, no reply.
  assert.ok(!unit.classList.contains("expanded"));
  assert.equal(replyEl.hidden, true);

  scruff({ type: "agent", event: { type: "turn_start" } });
  scruff({ type: "agent", event: { type: "text", text: "Hello there" } });

  // The unit expanded into orb + reply text — one component, not orb + card.
  assert.ok(unit.classList.contains("expanded"), "unit expanded");
  assert.equal(replyEl.hidden, false);
  assert.equal(replyEl.textContent, "Hello there");
  // The orb itself never left: it's weaving the reply, still live.
  assert.equal(orbCanvas.ariaLabel, "Weaving…");

  // More text streams into the same unit.
  scruff({ type: "agent", event: { type: "text", text: " — more" } });
  assert.equal(replyEl.textContent, "Hello there — more");

  // He starts speaking: the orb (still in the unit) shows listening.
  voice("listening");
  assert.equal(orbCanvas.ariaLabel, "Listening…");
  voice("idle");

  // Turn ends: the reply stays a beat for reading, then the unit collapses
  // back to just the orb.
  scruff({ type: "agent", event: { type: "turn_end" } });
  assert.ok(unit.classList.contains("expanded"), "reply still readable right after the turn");
  drainTimers();
  assert.ok(!unit.classList.contains("expanded"), "unit collapsed back to the orb");
  assert.equal(replyEl.hidden, true);
  assert.equal(replyEl.textContent, "");
  assert.equal(orbCanvas.ariaLabel, "Thinking…");
});

test("a user message collapses the reply unit immediately", async () => {
  const { byId, scruff } = setupDom();
  startHud(hudOpts);
  await tick();
  await tick();
  const unit = byId["hud-unit"];
  const replyEl = byId["hud-reply"];

  scruff({ type: "agent", event: { type: "text", text: "Hello" } });
  assert.ok(unit.classList.contains("expanded"));

  scruff({ type: "agent", event: { type: "user", text: "wait" } });
  assert.ok(!unit.classList.contains("expanded"), "user message collapses the unit at once");
  assert.equal(replyEl.textContent, "");
});

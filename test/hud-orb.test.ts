import assert from "node:assert/strict";
import { test } from "node:test";

// Drives the real dashboard/overlay.js startHud() with a stub DOM, proving:
// 1. background tool work keeps its own orb animation (searching/solving/working)
//    even when game state ticks arrive mid-turn (they used to stomp it to composing);
// 2. a reply makes the orb transform into the text card (from-orb bloom + a live
//    mini orb on the card) while the HUD orb itself stays visible and live.

// @ts-ignore: no declaration file for the dashboard JS
const { startHud } = (await import("../dashboard/overlay.js")) as {
  startHud: (opts: { toolLabel: (name: string, input: unknown) => string }) => void;
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
    "hud-button": makeEl("button"),
    "hud-orb": makeEl("canvas"),
    "hud-toasts": makeEl(),
    "hud-mods": makeEl(),
  };
  const body = makeEl();
  body.classList.contains = () => false;
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

test("tool work keeps its orb animation across game state ticks", async () => {
  const { byId, scruff } = setupDom();
  startHud({ toolLabel: (name) => `${name}` });
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

test("the orb transforms into the reply text but stays live (mini orb mirrors mic state)", async () => {
  const { byId, scruff, voice, drainTimers } = setupDom();
  startHud({ toolLabel: (name) => `${name}` });
  await tick();
  await tick();
  const orbCanvas = byId["hud-orb"];
  const toasts = byId["hud-toasts"];

  scruff({ type: "agent", event: { type: "turn_start" } });
  scruff({ type: "agent", event: { type: "text", text: "Hello there" } });

  // The reply card bloomed out of the orb…
  assert.equal(toasts.children.length, 1);
  const card = toasts.children[0];
  assert.ok(card.className.split(" ").includes("from-orb"), "reply card has the from-orb bloom");
  // …carrying a small live orb, mirroring the HUD orb's weaving melt…
  const mini = card.children.find((c: any) => String(c.className ?? "").split(" ").includes("mini-orb"));
  assert.ok(mini, "reply card carries a mini orb");
  assert.equal(mini.ariaLabel, "Weaving…");
  // …while the HUD orb itself is still right there, also weaving.
  assert.equal(orbCanvas.ariaLabel, "Weaving…");

  // He starts speaking: both orbs show listening.
  voice("listening");
  assert.equal(orbCanvas.ariaLabel, "Listening…");
  assert.equal(mini.ariaLabel, "Listening…");

  // He stops; the turn ends and the card fades away with its mini orb.
  voice("idle");
  scruff({ type: "agent", event: { type: "turn_end" } });
  drainTimers();
  assert.ok(card.removed, "reply card removed after fade");
  assert.equal(orbCanvas.ariaLabel, "Thinking…");

  // The destroyed mini orb no longer mirrors: the HUD orb keeps living on.
  voice("listening");
  assert.equal(orbCanvas.ariaLabel, "Listening…");
  assert.equal(mini.ariaLabel, "Thinking…", "dead mini orb does not follow the live orb");
});

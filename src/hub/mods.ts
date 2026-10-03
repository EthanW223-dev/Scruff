/**
 * Telos's full mod layer: what "change anything in the game" means on each engine, how a
 * player's plain-English mod request maps to bridge tools, and honest limits.
 *
 * Engines fall into tiers:
 * - full (Unity Mono and IL2CPP, via the BepInEx bridge): recolor, move/resize,
 *   hide/remove, spawn, time scale, gravity, calling the game's own methods,
 *   reading/writing any field.
 * - unreal (Unreal Engine): a bridge is staged and injected by the player; it offers
 *   object search and property read/write through engine reflection. It compiles and its
 *   protocol layer is tested, but it has NOT been verified against a real game — first
 *   use on any game is unverified. Numbers work via memory regardless.
 * - rpgmaker (RPG Maker MV/MZ): a plugin bridge (one JS file in the game's plugin list) for
 *   live gold, items, party stats, switches, variables, teleporting and encounters; the
 *   database itself (items, enemies, prices) is plain JSON the file tools edit.
 * - numbers-only (Godot, GameMaker, Ren'Py, Source, unknown): memory editing.
 *   Structural mods there need a real mod, which the Workshop builds (workshop.ts).
 */

export type ModTier = "full" | "unreal" | "rpgmaker" | "numbers";

export interface EngineModSupport {
  tier: ModTier;
  /** Short status-note line for the chat model. */
  note: string;
}

const FULL_NOTE =
  "Full modding is available through the Unity bridge (unity__ tools): recolor, move/resize, " +
  "hide/remove, spawn copies, slow motion and game speed, gravity, calling the game's own " +
  "methods, reading/writing any field, and bringing in 3D models from other games or files " +
  "(load_model; find_model_files finds exports). ";
const BRIDGE_MISSING =
  "The bridge isn't connected: offer install_unity_bridge in one line (needs a game restart), " +
  "meanwhile only number changes via memory work. ";
const BRIDGE_READY = "The bridge is connected: prefer it over memory editing for anything beyond numbers. ";

const UNREAL_NOTE =
  "Unreal Engine: number changes work via memory editing. Structural mods (finding objects, " +
  "reading/writing properties, slow-mo, console commands) need the Unreal bridge: check " +
  "unreal_bridge_status and offer it in one line. With UE4SS in the game (the community mod " +
  "loader the player installs), the bridge is a UE4SS mod: install_ue4ss_bridge, nothing to inject. The bridge compiles and its protocol is tested, but it is UNVERIFIED against real " +
  "games — say so plainly on first use with a game, and confirm one harmless change on screen " +
  "before promising anything. ";
const UNREAL_READY =
  "The Unreal bridge is connected: prefer the unreal__ tools over memory editing for object " +
  "and property work, but it is still unverified on this game — confirm on screen. ";

const RPGMAKER_NOTE =
  "RPG Maker MV/MZ: the database (items, weapons, enemies, actors, prices) is plain JSON under data/ that the " +
  "game file tools edit (restart to see it). Live changes (gold, items, party HP/MP/levels/stats, switches, " +
  "variables, teleporting, walking through walls, encounters, common events) go through the RPG Maker bridge. ";
const RPGMAKER_MISSING =
  "The bridge isn't connected: offer install_rpgmaker_bridge in one line (one plugin file; restart the game). " +
  "Meanwhile number changes via memory work. ";
const RPGMAKER_READY = "The RPG Maker bridge is connected: use the rpgmaker__ tools (start with rpgmaker__status). ";

const NUMBERS_NOTE =
  "Only number changes work live on this engine (memory editing). Colors, models, spawning, new " +
  "content and mechanics need a real mod: modding_guide has the route for this engine, and build_mod " +
  "has the Workshop build it (after the player approves). ";

/** Engine strings come from src/games/profile.ts. */
export function engineModSupport(engine: string, bridgeConnected: boolean, unrealConnected = false): EngineModSupport {
  if (engine.startsWith("Unity")) {
    return { tier: "full", note: FULL_NOTE + (bridgeConnected ? BRIDGE_READY : BRIDGE_MISSING) };
  }
  if (engine === "Unreal Engine") {
    return { tier: "unreal", note: UNREAL_NOTE + (unrealConnected || bridgeConnected ? UNREAL_READY : "") };
  }
  if (engine.startsWith("RPG Maker")) {
    return { tier: "rpgmaker", note: RPGMAKER_NOTE + (bridgeConnected ? RPGMAKER_READY : RPGMAKER_MISSING) };
  }
  return { tier: "numbers", note: NUMBERS_NOTE };
}

// ------------------------------------------------------------------ intents

export type ModIntentKind =
  | "recolor"
  | "move"
  | "resize"
  | "hide"
  | "show"
  | "remove"
  | "spawn"
  | "time_scale"
  | "gravity"
  | "call_method"
  | "get_value"
  | "set_value"
  | "load_level"
  | "look_like"
  | "unknown";

export interface ModIntent {
  kind: ModIntentKind;
  /** What the player wants changed, in their words. */
  target: string;
  /** The requested change, in their words (color, size, speed...). */
  change?: string;
}

const PATTERNS: { kind: ModIntentKind; re: RegExp }[] = [
  { kind: "recolor", re: /\b(color|colour|recolor|recolour|paint|dye|tint|purple|red|blue|green|pink|rainbow|glow)\b/i },
  { kind: "hide", re: /\b(hide|invisible|make .* disappear|get rid of|remove .* (wall|tree|ui|hud))\b/i },
  { kind: "show", re: /\b(show|unhide|visible|bring back)\b/i },
  { kind: "remove", re: /\b(delete|destroy|remove|kill) (the|that|this)\b/i },
  { kind: "spawn", re: /\b(spawn|summon|duplicate|clone|copy|add|create) (more|another|some|\d+|an?)\b/i },
  { kind: "move", re: /\b(move|teleport|place|put) (it|them|that|the)\b/i },
  { kind: "resize", re: /\b(bigger|smaller|resize|scale|size|shrink|grow|giant|tiny|huge)\b/i },
  { kind: "time_scale", re: /\b(slow[- ]?mo|slow motion|bullet time|speed up|faster|slower|pause time|half speed|double speed|time scale)\b/i },
  { kind: "gravity", re: /\bgravity\b/i },
  { kind: "load_level", re: /\b(load|go to|switch to|open) (level|scene|map|area)\b/i },
  { kind: "look_like", re: /\blook like\b/i },
  { kind: "call_method", re: /\b(unlock|heal|damage|kill|complete|finish|skip)\b/i },
];

/**
 * Rough classifier for "change something structural" requests. Number changes ("give me 99
 * food") are the fast path's job and come back unknown here on purpose — unless the verb is
 * explicitly about creating things ("spawn 5 enemies").
 */
export function detectModIntent(text: string): ModIntent {
  const lower = text.toLowerCase();
  const structuralVerb = /\b(spawn|summon|clone|duplicate|add|create)\b/.test(lower);
  if (!structuralVerb && /\b(give me|set|i have|i've got|i got)\b[^.?!]*\d/.test(lower)) {
    return { kind: "unknown", target: text.trim() };
  }
  for (const { kind, re } of PATTERNS) {
    if (re.test(lower)) return { kind, target: text.trim() };
  }
  return { kind: "unknown", target: text.trim() };
}

// ------------------------------------------------------------------ plans

export interface ModStep {
  /** Adapter tool to call through use_game_adapter, e.g. "unity__color". */
  tool: string;
  /** What to pass as input (ids get filled in after find). */
  input: Record<string, unknown>;
  /** Why, in one line for the model. */
  why: string;
}

export interface ModPlan {
  intent: ModIntent;
  steps: ModStep[];
  /** Vision question for verify_visual_change afterwards. */
  verify: string;
}

const FIND = (target: string): ModStep => ({
  tool: "unity__find",
  input: { name: target },
  why: "Find the object's id first; every other tool needs it.",
});

/**
 * A concrete recipe for a mod intent on the Unity bridge. The chat model still executes the
 * steps (it fills in ids from find), but it doesn't have to invent the recipe.
 */
export function planMod(intent: ModIntent): ModPlan | null {
  const t = intent.target;
  switch (intent.kind) {
    case "recolor":
      return {
        intent,
        steps: [FIND(t), { tool: "unity__color", input: { color: intent.change ?? "?" }, why: "Recolor it (and children)." }],
        verify: `Is the ${t} now the requested color?`,
      };
    case "hide":
      return {
        intent,
        steps: [FIND(t), { tool: "unity__set_active", input: { active: false }, why: "Hide it (undoable, unlike destroy)." }],
        verify: `Is the ${t} hidden or gone from the scene?`,
      };
    case "show":
      return {
        intent,
        steps: [
          FIND(t),
          { tool: "unity__set_active", input: { active: true }, why: "Show it again." },
        ],
        verify: `Is the ${t} visible again?`,
      };
    case "remove":
      return {
        intent,
        steps: [FIND(t), { tool: "unity__set_active", input: { active: false }, why: "Hide first (undoable); destroy only if asked twice." }],
        verify: `Is the ${t} gone from the scene?`,
      };
    case "spawn":
      return {
        intent,
        steps: [FIND(t), { tool: "unity__spawn", input: {}, why: "Spawn copies of it." }],
        verify: `Are there extra copies of the ${t} in the scene?`,
      };
    case "move":
    case "resize":
      return {
        intent,
        steps: [FIND(t), { tool: "unity__transform", input: {}, why: "Move/resize it." }],
        verify: `Did the ${t} move or change size as asked?`,
      };
    case "time_scale":
      return {
        intent,
        steps: [{ tool: "unity__world", input: { time_scale: "?" }, why: "Set game speed (0.5 slow-mo, 2 fast)." }],
        verify: "Is the game running at the requested speed?",
      };
    case "gravity":
      return {
        intent,
        steps: [{ tool: "unity__world", input: { gravity: "?" }, why: "Change gravity." }],
        verify: "Do things fall as asked?",
      };
    case "look_like":
      return {
        intent,
        steps: [FIND(t), { tool: "unity__copy_look", input: {}, why: "Copy the look from the source object." }],
        verify: "Does it look like the source object now?",
      };
    case "load_level":
      return {
        intent,
        steps: [{ tool: "unity__scenes", input: {}, why: "List levels, then load the one asked for." }],
        verify: "Did the requested level load?",
      };
    case "call_method":
    case "get_value":
    case "set_value":
      return {
        intent,
        steps: [
          { tool: "unity__types", input: { query: t }, why: "Find the game's classes/singletons that own this." },
          { tool: "unity__get", input: {}, why: "Read the current state before changing anything." },
        ],
        verify: "Did the requested change take effect in the game?",
      };
    default:
      return null;
  }
}

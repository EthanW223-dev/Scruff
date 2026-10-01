import type { AgentEvent } from "./agent.ts";
import type { GameSession } from "../memory/session.ts";
import type { GameManager } from "./game.ts";
import { JEV_MAX_OPTIONS, JevError, type ChoiceAnswer, type Jev, type JevQuestion } from "./jev.ts";
import type { HubTool } from "./tools.ts";
import { confirmQuestion, hudQuestion, parseConfirm, parseNumber, VisionError, type VisionClient } from "./vision.ts";

/**
 * Telos's fast path: every message goes to Jev first (one call, a fraction of a second). When
 * Jev is sure the message is a simple command (undo, set or lock a value Telos already found,
 * pick the game, "I have 5 cans, give me 99", "now it's 4.75"), code does it right away through
 * the same tools the chat model uses. Anything else, or anything Jev isn't sure about, goes to
 * the chat model, which is told what the fast path did.
 *
 * Jev only picks between options; the options come from code (numbers and phrases pulled out
 * of the message, the found values, the running programs), and all arithmetic stays in code.
 */

export type QuickOutcome =
  /** Done. `log` is what the chat model is told later. */
  | { handled: true; log: string }
  /** The chat model takes the message. `note` says what the fast path already did. */
  | { handled: false; note?: string };

export type QuickHandler = (text: string, emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<QuickOutcome>;

export interface QuickPathOptions {
  jev: () => Jev | null;
  games: GameManager;
  tools: HubTool[];
  /** Whether a chat model is set up to take messages Jev can't handle. */
  chatReady: () => boolean;
  /** How each Jev call went (null when fine), so the AI menu shows the real status. */
  report?: (err: unknown) => void;
  /**
   * Screenshot the game window. In the overlay this is automatic (no clicks); in a plain
   * browser tab it needs the player's screen share. Enables hands-free scanning: the
   * player just plays while Telos watches the HUD for the number to change.
   */
  capture?: () => Promise<string>;
  /** A chat model that can read screenshots (Claude, or a local vision model). */
  vision?: () => VisionClient | null;
  /** Hands-free tuning: how often to look at the screen while the player plays, and when to give up. */
  watch?: { pollMs?: number; timeoutMs?: number };
}

/** Act on an intent only when Jev is at least this confident. */
const ACT = 0.6;
/** Picking which program to attach to, or which number to write, needs a clearer answer. */
const SURE = 0.7;
const FEW = 8;
const MAX_PROCESSES = 200;
const PROCESS_CACHE_MS = 10_000;
const JEV_BUDGET_MS = 3000;
/** Extra narrowing steps asked for when the last few candidates disagree. */
const MAX_EXTRA_STEPS = 2;
/** Hands-free narrowing: how often to look at the HUD while the player plays. */
const WATCH_POLL_MS = 20_000;
/** Hands-free narrowing gives up after this long and asks the player instead. */
const WATCH_TIMEOUT_MS = 5 * 60_000;
const PHRASE_STOP = new Set(
  (
    "and but so then give make set to can could please now it its it's i im i'm i've ive me my we our you your the a an " +
    "of for in on at with is are was be left more less max maximum full infinite unlimited lots tons lot bunch " +
    "lock locked freeze frozen unlock keep want need get got have has had some all never runs run out go goes went " +
    "down up same still value amount number how much many what whats what's everything anything stuff thing things"
  ).split(" "),
);
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, fifty: 50, hundred: 100,
};

interface Mention {
  value: number;
  text: string;
  context: string;
  index: number;
}

/** Numbers in the message, as written ("1,500", "4.75", "5k", "five"). */
export function findNumbers(text: string): Mention[] {
  const out: Mention[] = [];
  const re = /(?<![\w.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(k|m)?(?![\w])|\b([a-z]+)\b/gi;
  for (const m of text.matchAll(re)) {
    let value: number;
    if (m[1] !== undefined) {
      value = Number(m[1].replace(/,/g, "")) * (m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1);
    } else {
      const word = WORD_NUMBERS[m[3].toLowerCase()];
      if (word === undefined) continue;
      value = word;
    }
    if (!Number.isFinite(value)) continue;
    const start = Math.max(0, m.index! - 25);
    const end = Math.min(text.length, m.index! + m[0].length + 25);
    out.push({ value, text: m[0], context: text.slice(start, end).trim(), index: m.index! });
  }
  return out.slice(0, 12);
}

/** Short phrases that could name the thing: words after a number, after "my"/"the", before "to <n>". */
export function findPhrases(text: string, numbers: Mention[]): string[] {
  const words = (s: string) => s.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
  const take = (list: string[]) => {
    const kept: string[] = [];
    for (const w of list) {
      if (PHRASE_STOP.has(w) || WORD_NUMBERS[w] !== undefined) break;
      kept.push(w);
      if (kept.length === 3) break;
    }
    return kept;
  };
  const out = new Set<string>();
  const addAll = (kept: string[]) => {
    for (let n = kept.length; n > 0; n--) out.add(kept.slice(0, n).join(" "));
    if (kept.length > 1) out.add(kept[kept.length - 1]);
  };
  for (const n of numbers) {
    addAll(take(words(text.slice(n.index + n.text.length, n.index + n.text.length + 40))));
    // "set gold to 500", "gold at 5k": the words just before.
    const before = words(text.slice(Math.max(0, n.index - 30), n.index));
    while (before.length && ["to", "at", "is", "of", "have", "got"].includes(before[before.length - 1])) before.pop();
    const tail = before.slice(-2).filter((w) => !PHRASE_STOP.has(w));
    if (tail.length) addAll(tail);
  }
  for (const m of text.toLowerCase().matchAll(/\b(?:my|the|our)\s+([a-z][a-z' -]{1,30})/g)) addAll(take(words(m[1])));
  // Runs of words between command words: "give me max health" → "health", "more soup cans" → "soup cans".
  let run: string[] = [];
  for (const w of [...words(text.replace(/[\d.,]+/g, " , ")), "and"]) {
    if (PHRASE_STOP.has(w) || WORD_NUMBERS[w] !== undefined) {
      if (run.length && run.length <= 3) addAll(run);
      run = [];
    } else run.push(w);
  }
  return [...out].filter((p) => p.length > 1).slice(0, 20);
}

/** "Max" as a number: comfortably above what they have, without overflowing anything. */
export function maxFor(current: number): number {
  return Math.abs(current) < 1000 ? 999 : Math.abs(current) < 100_000 ? 99_999 : 999_999;
}

/** "Full" for a bar: bars are usually out of 1, 100 or 1000. */
export function barMax(current: number): number {
  return current <= 1 ? 1 : current <= 100 ? 100 : current <= 1000 ? 1000 : maxFor(current);
}

/** What the player wants a value to become: a number, as much as possible, or never running out. */
type Goal = number | "max" | "infinite";

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 1000) / 1000));

export function quickPath(opts: QuickPathOptions): QuickHandler {
  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  let lastError: string | null = null;
  let callId = 0;
  /** The goal for the current search, when the fast path started it ("max" and "infinite" can't go in find_value). */
  let want: { what: string; goal: Goal; bar: boolean; session: GameSession; extra: number } | null = null;
  // Listing processes spawns PowerShell on Windows (about a second); reuse it for a little while.
  let processCache: { at: number; list: Awaited<ReturnType<GameManager["listGames"]>> } | null = null;
  const runningPrograms = async () => {
    if (!processCache || Date.now() - processCache.at > PROCESS_CACHE_MS) {
      processCache = { at: Date.now(), list: await opts.games.listGames().catch(() => []) };
    }
    return processCache.list.slice(0, MAX_PROCESSES);
  };

  return async (text, emit, signal) => {
    const jev = opts.jev();
    if (!jev) return { handled: false };
    const { games } = opts;
    const session = games.session && !games.session.isClosed ? games.session : null;
    const supported = games.state().supported.ok;

    // --- what's on the table right now ---
    const numbers = findNumbers(text);
    const phrases = findPhrases(text, numbers);
    const watch = session ? games.state().attached?.watch ?? [] : [];
    const labels = [...new Set(watch.map((w) => w.label))].slice(0, 60);
    const search = session?.searchLabel && session.scanner.count > 0 ? session.searchLabel : null;
    if (want && want.session !== session) want = null;
    const hasChanges = Boolean(session?.changes.some((c) => !c.undone));
    const wantsGame = !session || /\b(play|playing|game|switch|attach|connect|pick|open)\b/i.test(text);
    const processes = supported && wantsGame ? await runningPrograms() : [];

    const intents: Record<string, string> = {};
    if (session) {
      intents.find_and_change =
        "The player says how much of something they have right now and wants Telos to change it " +
        "(for example 'I have 5 soup cans, give me 99' or 'I've got 350 gold, max it out').";
      intents.change_no_number =
        "The player wants something in the game changed (more, full, max, infinite, or a set amount) but doesn't say " +
        "how much they have right now (for example 'give me max health', 'make my food infinite', 'I want more ammo').";
      if (search) {
        intents.report_new_amount =
          "The player tells Telos the amount of `search.what` the game shows now " +
          "(for example 'ok now it's 4.75', 'it says 73', 'I have 3 now' or just a number).";
        intents.report_direction =
          "The player says `search.what` went down, went up, or stayed the same in the game, without giving a number " +
          "(for example 'it went down', 'I took damage', 'it's the same', 'it filled back up').";
      }
      if (labels.length) {
        intents.set_known = "The player wants one of the `found_values` set to a specific amount or to the max.";
        intents.freeze_known =
          "The player wants one of the `found_values` locked or frozen so it never changes (infinite, never runs out).";
        if (watch.some((w) => w.frozen)) intents.unfreeze_known = "The player wants a locked value in `found_values` unlocked.";
        intents.read_known = "The player asks how much of one of the `found_values` they have.";
      }
      if (hasChanges) {
        intents.undo_last = "The player wants Telos's most recent change taken back (undo that, put it back).";
        intents.undo_all = "The player wants every change Telos made taken back (undo everything, reset it all).";
      }
    }
    if (processes.length) {
      intents.pick_game = "The player names the game they are playing, or asks Telos to connect to a game.";
    }
    if (!Object.keys(intents).length) return { handled: false };
    intents.other = "Anything else: questions, advice, how the overlay looks, or anything unclear.";

    const state = {
      player_message: text,
      game: session ? session.target.title || session.target.name : null,
      found_values: labels.length ? watch.map((w) => ({ name: w.label, now: w.value, locked: w.frozen })) : undefined,
      search: search
        ? { what: search, by: session!.searchKind === "unknown" ? "how it changes (no number)" : "its number", last_number: session!.searchValue ?? undefined }
        : undefined,
    };

    const numberOptions = Object.fromEntries(numbers.map((n, i) => [`n${i}`, `${n.text} (in "…${n.context}…")`]));
    const questions: Record<string, JevQuestion> = {
      intent: { type: "choice", instructions: "What does the player want Telos to do with `player_message`?", criteria: intents },
    };
    if (session) {
      questions.wanted_number = {
        type: "choice",
        instructions: "What amount does the player want it to become?",
        criteria: {
          ...numberOptions,
          max: "As much as possible or full, with no number given (max, full, more, tons, a lot).",
          infinite: "It should never run out or go down (infinite, unlimited, never dies, god mode).",
          none: "The player doesn't ask for a new amount.",
        },
      };
      if (numbers.length) {
        questions.current_number = {
          type: "choice",
          instructions: "Which number in `player_message` is how much the player has right now?",
          criteria: { ...numberOptions, none: "The message doesn't say how much they have now." },
        };
      }
      if (phrases.length) {
        questions.thing = {
          type: "choice",
          instructions: "Which phrase names the thing in the game the player is talking about (an item, money, a stat)?",
          criteria: { ...Object.fromEntries(phrases.map((p, i) => [`p${i}`, p])), none: "None of these names it." },
        };
      }
      if (search) {
        questions.direction = {
          type: "choice",
          instructions: "How does the player say `search.what` changed in the game?",
          criteria: {
            decreased: "It went down (dropped, lost some, took damage, used or spent some).",
            increased: "It went up (gained some, healed, filled up, picked some up).",
            unchanged: "It stayed the same (nothing happened to it).",
            none: "The message doesn't say how it changed.",
          },
        };
      }
      if (labels.length) {
        questions.which_value = {
          type: "choice",
          instructions: "Which of the `found_values` is the player talking about?",
          criteria: { ...Object.fromEntries(labels.map((l, i) => [`v${i}`, l])), none: "None of them." },
        };
      }
    }
    if (processes.length) {
      questions.game = {
        type: "choice",
        instructions: "Which of these running programs is the game the player means?",
        criteria: {
          ...Object.fromEntries(
            processes.slice(0, JEV_MAX_OPTIONS - 1).map((p, i) => [`g${i}`, [p.title, p.name].filter(Boolean).join(" — ")]),
          ),
          none: "None of these is the game the player means.",
        },
      };
    }

    // --- one call ---
    const started = performance.now();
    let answers: Record<string, ChoiceAnswer>;
    try {
      // Jev normally answers in well under a second; if it doesn't, the chat model shouldn't wait.
      const budget = AbortSignal.any([signal, AbortSignal.timeout(JEV_BUDGET_MS)]);
      answers = (await jev.ask(state, questions, budget)).answers as Record<string, ChoiceAnswer>;
    } catch (err) {
      if (signal.aborted) throw err;
      opts.report?.(err);
      const message = err instanceof JevError ? err.message : `Jev didn't answer within ${JEV_BUDGET_MS / 1000} seconds.`;
      // Say so once per kind of failure, so it's clear why the chat AI is answering.
      if (message !== lastError) emit({ type: "notice", text: `${message} The chat AI is taking this one.` });
      lastError = message;
      return { handled: false };
    }
    opts.report?.(null);
    lastError = null;
    const ms = Math.round(performance.now() - started);
    const intent = answers.intent;
    if (!intent || intent.choice === "other" || intent.confidence < ACT || !intents[intent.choice]) {
      return notHandled();
    }

    const pick = (id: string, min = ACT) => {
      const a = answers[id];
      return a && a.choice !== "none" && a.confidence >= min ? a.choice : null;
    };
    const numberAt = (key: string | null) => (key && key.startsWith("n") ? numbers[Number(key.slice(1))]?.value ?? null : null);
    const currentNumber = numberAt(pick("current_number"));
    const wantedKey = pick("wanted_number");
    const wanted: Goal | null = wantedKey === "max" || wantedKey === "infinite" ? wantedKey : numberAt(wantedKey);
    const phrase = pick("thing", 0.5);
    const thing = phrase ? phrases[Number(phrase.slice(1))] : null;
    const valueKey = pick("which_value");
    const label = valueKey ? labels[Number(valueKey.slice(1))] : null;
    const entries = label ? watch.filter((w) => w.label === label) : [];

    // Show what Jev understood, then do it.
    const id = `jev_${++callId}`;
    emit({ type: "tool_call", id, name: "jev", input: { intent: intent.choice } });
    emit({
      type: "tool_result",
      id,
      ok: true,
      text: `${intent.choice.replace(/_/g, " ")} · ${Math.round(intent.confidence * 100)}% sure · ${ms} ms`,
    });

    const run = async (name: string, input: Record<string, unknown>): Promise<{ ok: boolean; text: string }> => {
      const tool = tools.get(name)!;
      const toolId = `jev_${++callId}`;
      emit({ type: "tool_call", id: toolId, name, input });
      try {
        const out = await tool.run(input, { signal, progress: (t) => emit({ type: "tool_progress", id: toolId, text: t }) });
        const result = typeof out === "string" ? out : JSON.stringify(out);
        emit({ type: "tool_result", id: toolId, ok: true, text: result });
        return { ok: true, text: result };
      } catch (err) {
        const message = (err as Error).message;
        emit({ type: "tool_result", id: toolId, ok: false, text: message });
        return { ok: false, text: message };
      }
    };
    const say = (reply: string): QuickOutcome => {
      emit({ type: "text", text: reply });
      return { handled: true, log: `Player said "${text}". Handled with Jev: ${reply}` };
    };
    function notHandled(note?: string): QuickOutcome {
      if (opts.chatReady()) return { handled: false, note };
      emit({
        type: "text",
        text:
          (note ? `${note} ` : "") +
          "Jev handles quick commands (undo, set or lock a value I found, \"I have 5 cans, give me 99\", picking the game), " +
          "but this one needs a chat AI. Pick one in the AI menu.",
      });
      return { handled: true, log: `Player said "${text}"; no chat AI was set up to answer.` };
    }

    /** Hands-free mode needs a screenshot and something that can read it. */
    let visionDead = false;
    const canWatch = () => Boolean(opts.capture && opts.vision?.() && !visionDead);

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(t);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

    /**
     * Read the HUD number for `what` off a screenshot. Null when it's not visible or the
     * read failed. Throws when the vision model turns out to be blind (text-only): the
     * caller falls back to asking the player, and hands-free stays off afterwards.
     */
    const readHud = async (what: string, gameName: string | null): Promise<number | null> => {
      const vc = opts.vision?.();
      if (visionDead || !vc || !opts.capture) return null;
      try {
        const jpeg = await opts.capture();
        if (signal.aborted) return null;
        return parseNumber(await vc.ask(jpeg, hudQuestion(what, gameName), signal));
      } catch (err) {
        if (err instanceof VisionError && err.code === "no-vision") {
          visionDead = true;
          throw err;
        }
        return null; // a failed read is a missed poll, not a failure
      }
    };

    /** Ask the screen whether the HUD shows the value just written. Never throws. */
    const confirmOnScreen = async (what: string, value: number): Promise<"yes" | "no" | "unknown"> => {
      const vc = opts.vision?.();
      if (visionDead || !vc || !opts.capture) return "unknown";
      try {
        const jpeg = await opts.capture();
        if (signal.aborted) return "unknown";
        return parseConfirm(await vc.ask(jpeg, confirmQuestion(what, fmt(value)), signal), value);
      } catch (err) {
        if (err instanceof VisionError && err.code === "no-vision") visionDead = true;
        return "unknown";
      }
    };

    /**
     * Hands-free narrowing: the player just plays. Poll the HUD until the number for `what`
     * moves from `last` (establishing a baseline from the screen when null), then refine the
     * search to it. A change is only trusted after two consecutive reads agree, so a single
     * misread can't kill the search. Returns null when watching isn't possible or it timed
     * out: the caller falls back to asking the player.
     */
    const autoNarrow = async (
      what: string,
      first: { count: number; addresses: { address: string; value: number; type: string }[] },
      last: number | null,
      bar: boolean,
    ): Promise<QuickOutcome | null> => {
      const watchId = `jev_${++callId}`;
      const gameName = session!.target.title || session!.target.name;
      const done = (ok: boolean, text: string) => emit({ type: "tool_result", id: watchId, ok, text });
      // Probe: one screenshot now. If capture is off, fall back silently to asking the
      // player — a missing screen isn't an error, the old path just takes over.
      try {
        await opts.capture!();
      } catch {
        return null;
      }
      emit({ type: "tool_call", id: watchId, name: "watch_screen", input: { what } });
      emit({ type: "tool_progress", id: watchId, text: `Just play — I'll watch the ${what} number and narrow it down.` });
      const started = Date.now();
      const pollMs = opts.watch?.pollMs ?? WATCH_POLL_MS;
      const timeoutMs = opts.watch?.timeoutMs ?? WATCH_TIMEOUT_MS;
      let result = first;
      let deadRestarts = 0; // fresh restarts after misread-emptied searches; capped so it can't loop
      for (;;) {
        if (signal.aborted) {
          done(false, "stopped");
          return null;
        }
        if (Date.now() - started > timeoutMs) {
          done(false, "timed out");
          return null;
        }
        emit({
          type: "tool_progress",
          id: watchId,
          text: `Watching for the ${what} number to change… (${Math.round((Date.now() - started) / 1000)}s)`,
        });
        await sleep(pollMs);
        if (signal.aborted) {
          done(false, "stopped");
          return null;
        }
        let seen: number | null;
        try {
          seen = await readHud(what, gameName);
        } catch {
          done(false, "the chat model can't see images");
          return null;
        }
        if (seen === null || seen === last) continue;
        if (last === null) {
          last = seen; // baseline established; need a second reading to judge a change
          continue;
        }
        // A change is only trusted when two back-to-back reads agree.
        let again: number | null = null;
        try {
          again = await readHud(what, gameName);
        } catch {
          done(false, "the chat model can't see images");
          return null;
        }
        if (again !== seen) {
          last = again ?? last;
          continue;
        }
        const prevTrusted = last; // what the current search was built on; a misread must not kill it
        const out = await run("find_value", { what, value: seen });
        if (!out.ok) {
          done(false, out.text);
          return notHandled(`I saw the ${what} change to ${fmt(seen)}, but narrowing failed: ${out.text}`);
        }
        result = JSON.parse(out.text);
        if (result.count === 0) {
          // The reading was a misread (or the display changed encoding): the refine emptied the
          // search, so watching on would narrow nothing. Restart fresh from the last trusted
          // reading instead. Give up after a couple of dead restarts and ask the player.
          if (++deadRestarts > 2) {
            done(false, "search kept coming up empty");
            return notHandled(
              `I kept seeing the ${what} change but every search came up empty — the game may store it ` +
                `somewhere I can't reach. Tell me the number it shows and I'll try a direct search.`,
            );
          }
          emit({
            type: "tool_progress",
            id: watchId,
            text: `That reading (${fmt(seen)}) matched nothing — restarting the search from ${fmt(prevTrusted)}. Keep playing…`,
          });
          const fresh = await run("find_value", { what, value: prevTrusted, new_search: true });
          if (!fresh.ok) {
            done(false, fresh.text);
            return notHandled(`Restarting the ${what} search failed: ${fresh.text}`);
          }
          result = JSON.parse(fresh.text);
          last = prevTrusted;
        } else {
          last = seen;
          deadRestarts = 0;
        }
        if (want?.what === what.toLowerCase()) want.bar = false; // it has a readable number
        if (result.count === 0 || result.count > FEW) {
          emit({
            type: "tool_progress",
            id: watchId,
            text:
              result.count === 0
                ? `Nothing holds ${fmt(last)} either. Keep playing…`
                : `${result.count.toLocaleString("en-US")} places left. Keep playing…`,
          });
          continue;
        }
        done(true, `narrowed to ${result.count} place${result.count === 1 ? "" : "s"}`);
        return afterSearch(what, result, { value: seen });
      }
    };

    /** A goal as a number: "max" depends on what it holds now, and on whether it's a bar. */
    const resolve = (goal: Goal, current: number, bar: boolean) =>
      typeof goal === "number" ? goal : bar ? barMax(current) : maxFor(current);

    /**
     * Sets the goal on the remaining results ("infinite" locks it there), then says honestly
     * whether it held. For bars, decimals are the likely match, so they go first.
     */
    const writeGoal = async (what: string, goal: Goal, found: { address: string; value: number; type: string }[], bar: boolean) => {
      const decimals = found.filter((f) => f.type === "float" || f.type === "double");
      const targets = bar && decimals.length ? decimals : found;
      const plausible = targets.map((t) => t.value).filter((v) => Math.abs(v) <= 100_000);
      const value = resolve(goal, plausible.length ? Math.max(...plausible) : targets[0].value, bar);
      const shown = `${fmt(value)}${typeof goal === "number" ? "" : bar ? " (my guess at full)" : ""}`;
      if (goal === "infinite") {
        for (const t of targets) {
          const out = await run("freeze_value", { address: t.address, value, label: what });
          if (!out.ok) return notHandled(`Jev tried to lock ${what}, but: ${out.text}`);
        }
        return say(`Locked ${what} at ${shown}, so it won't go down. Does the game show it? Say "unlock ${what}" to let it change again.`);
      }
      if (canWatch()) return writeVerified(what, value, shown, targets);
      const out = await run("write_value", { addresses: targets.map((t) => t.address), value, label: what });
      if (!out.ok) return notHandled(`Jev tried to set ${what} to ${fmt(value)}, but the write failed: ${out.text}`);
      const report = JSON.parse(out.text) as { results: { warning?: string; error?: string }[] };
      const held = report.results.filter((r) => !r.warning && !r.error).length;
      if (!held) {
        return say(`I set ${what} to ${fmt(value)}, but the game put it straight back. Say "lock ${what}" and I'll hold it there.`);
      }
      return say(
        `Set ${what} to ${shown}${targets.length > 1 ? ` (${targets.length} places)` : ""}. ` +
          `Does the game show it now? Some games only redraw after you use or open something. If not, say "undo".`,
      );
    };

    /**
     * One candidate at a time, each verified on the game's screen: a write can stick in
     * memory at an address that is only a copy of the real value, so the game never shows
     * it. The first candidate the HUD confirms wins; the rest are undone. Never claims
     * success the screen didn't confirm.
     */
    const writeVerified = async (
      what: string,
      value: number,
      shown: string,
      targets: { address: string; value: number; type: string }[],
    ) => {
      const verifyId = `jev_${++callId}`;
      emit({ type: "tool_call", id: verifyId, name: "verify_on_screen", input: { what, expected: value } });
      let unverified = false;
      for (const t of targets) {
        if (signal.aborted) break;
        emit({ type: "tool_progress", id: verifyId, text: `Trying ${t.address}…` });
        const out = await run("write_value", { addresses: [t.address], value, label: what, type: t.type });
        if (!out.ok) continue;
        const res = (JSON.parse(out.text) as { results: { change_id?: number; warning?: string; error?: string }[] })
          .results[0];
        if (!res || res.error || res.warning || res.change_id === undefined) continue; // didn't stick
        const verdict = await confirmOnScreen(what, value);
        if (verdict === "yes") {
          emit({ type: "tool_result", id: verifyId, ok: true, text: `the game shows ${what} at ${shown}` });
          return say(`Done — the game shows ${what} at ${shown}.`);
        }
        if (verdict === "unknown") {
          // The counter isn't on screen: leave this one (it held in memory) and say so honestly.
          unverified = true;
          break;
        }
        await run("undo_change", { change_id: res.change_id }); // a copy, not the real value
      }
      if (unverified) {
        emit({ type: "tool_result", id: verifyId, ok: true, text: "the counter wasn't on screen" });
        return say(
          `Set ${what} to ${shown} and it held in memory, but I couldn't see the ${what} counter on your screen ` +
            `to confirm. Check the game — if it's wrong, say "undo".`,
        );
      }
      emit({ type: "tool_result", id: verifyId, ok: false, text: "no candidate showed on screen" });
      return say(
        `I tried every candidate for ${what} and none of them showed up in the game. Say "lock ${what}" and I'll ` +
          `hold the most likely one there instead.`,
      );
    };

    switch (intent.choice) {
      case "undo_last": {
        const out = await run("undo_change", {});
        return out.ok ? say(out.text) : notHandled();
      }
      case "undo_all": {
        const out = await run("revert_all_changes", {});
        if (!out.ok) return notHandled();
        const n = Number(/\d+/.exec(out.text)?.[0] ?? 0);
        return say(n ? `Undid all ${n} change${n === 1 ? "" : "s"}.` : "There was nothing to undo.");
      }
      case "pick_game": {
        const key = pick("game", SURE);
        const target = key ? processes[Number(key.slice(1))] : null;
        if (!target) return notHandled();
        const out = await run("attach_to_game", { pid: target.pid });
        if (!out.ok) return say(out.text);
        const p = games.profile;
        return say(
          `Connected to ${target.title || target.name}.` +
            (p && p.engine !== "Unknown"
              ? ` It's ${/^[AEIOU]/.test(p.engine) ? "an" : "a"} ${p.engine} game${p.saveDirs.length ? ", and I found its save folder" : ""}.`
              : "") +
            " Tell me what you want changed, and how much you have now.",
        );
      }
      case "read_known": {
        if (!entries.length) return notHandled();
        const values = entries.map((e) => e.value).filter((v): v is number => typeof v === "number");
        return say(values.length ? `${label} is ${fmt(values[0])}${entries[0].frozen ? " (locked)" : ""}.` : `I can't read ${label} right now.`);
      }
      case "set_known": {
        if (!entries.length || wanted === null) return notHandled();
        const bar = Boolean(want && want.what === label && want.bar);
        return writeGoal(label!, wanted, entries.map((e) => ({ address: e.address, value: e.value ?? 0, type: e.type })), bar);
      }
      case "freeze_known": {
        if (!entries.length || typeof entries[0].value !== "number") return notHandled();
        const current = entries[0].value;
        const goal = wanted === null || wanted === "infinite" ? current : resolve(wanted, current, Boolean(want?.bar && want.what === label));
        for (const e of entries) {
          const out = await run("freeze_value", { address: e.address, value: goal, label: label! });
          if (!out.ok) return notHandled(`Jev tried to lock ${label}, but: ${out.text}`);
        }
        return say(`Locked ${label} at ${fmt(goal)}. Check the game shows it; say "unlock ${label}" to let it change again.`);
      }
      case "unfreeze_known": {
        const frozen = entries.filter((e) => e.frozen);
        if (!frozen.length) return notHandled();
        for (const e of frozen) await run("unfreeze_value", { address: e.address });
        return say(`Unlocked ${label}.`);
      }
      case "find_and_change": {
        if (wanted === null || !thing) return notHandled();
        let current = currentNumber;
        let fromScreen = false;
        const gameName = session!.target.title || session!.target.name;
        if (current === null && canWatch()) {
          // The player didn't say how much they have: read it off the HUD instead of asking.
          const lookId = `jev_${++callId}`;
          emit({ type: "tool_call", id: lookId, name: "look_at_screen", input: { what: thing } });
          try {
            current = await readHud(thing, gameName);
            emit({ type: "tool_result", id: lookId, ok: true, text: current === null ? "not visible" : `reads ${current}` });
          } catch {
            emit({ type: "tool_result", id: lookId, ok: false, text: "the chat model can't see images" });
            current = null;
          }
          fromScreen = current !== null;
        }
        if (current === null) return notHandled();
        const out = await run("find_value", {
          what: thing,
          value: current,
          new_search: true,
          ...(typeof wanted === "number" ? { goal: wanted } : {}),
        });
        if (!out.ok) return notHandled(`Jev started a search for ${thing} = ${fmt(current)}, but it failed: ${out.text}`);
        const parsed = JSON.parse(out.text) as { count: number; addresses: { address: string; value: number; type: string }[] };
        if (parsed.count === 0 && fromScreen) {
          return say(
            `I read ${fmt(current)} for ${thing} off your screen, but nothing in memory holds that number. ` +
              `What's the exact number the game shows?`,
          );
        }
        want = { what: thing.toLowerCase(), goal: wanted, bar: false, session: session!, extra: 0 };
        return afterSearch(thing, parsed, { value: current });
      }
      case "change_no_number": {
        // No number yet: snapshot now, so both "it says 73" and "it went down" can narrow it next.
        if (!thing) return notHandled();
        const goal = wanted ?? "max";
        const gameName = session!.target.title || session!.target.name;
        if (canWatch()) {
          // A number on the HUD turns this into the fast numbered search.
          let seen: number | null = null;
          try {
            seen = await readHud(thing, gameName);
          } catch {
            seen = null;
          }
          if (seen !== null) {
            const out = await run("find_value", {
              what: thing,
              value: seen,
              new_search: true,
              ...(typeof goal === "number" ? { goal } : {}),
            });
            if (out.ok) {
              const parsed = JSON.parse(out.text);
              if (parsed.count > 0) {
                want = { what: thing.toLowerCase(), goal, bar: false, session: session!, extra: 0 };
                return afterSearch(thing, parsed, { value: seen });
              }
            }
            // Misread (or nothing holds it): fall through to the snapshot path.
          }
        }
        const out = await run("find_value", {
          what: thing,
          new_search: true,
          steady: false,
          ...(typeof goal === "number" ? { goal } : {}),
        });
        if (!out.ok) return notHandled(`Jev tried to start a search for ${thing} without a number, but: ${out.text}`);
        want = { what: thing.toLowerCase(), goal, bar: true, session: session!, extra: 0 };
        // A fresh snapshot: nothing has moved yet, so explain the first step (not "it went…").
        return say(
          `On it. Tell me the number the game shows for ${thing}, or if it's a bar or has no number, make it go down or up ` +
            `in the game (take a hit, eat, use one...) and tell me which way it went.`,
        );
      }
      case "report_new_amount": {
        if (currentNumber === null || !search) return notHandled();
        const out = await run("find_value", { what: search, value: currentNumber });
        if (!out.ok) return notHandled(`Jev tried to narrow ${search} to ${fmt(currentNumber)}, but: ${out.text}`);
        if (want?.what === search) want.bar = false; // it has a number after all
        return afterSearch(search, JSON.parse(out.text), { value: currentNumber });
      }
      case "report_direction": {
        const direction = pick("direction") as "decreased" | "increased" | "unchanged" | null;
        if (!direction || !search) return notHandled();
        const out = await run("find_value", { what: search, change: direction, steady: false });
        if (!out.ok) return notHandled(`Jev tried to narrow ${search} (${direction}), but: ${out.text}`);
        return afterSearch(search, JSON.parse(out.text), { direction });
      }
      default:
        return notHandled();
    }

    async function afterSearch(
      what: string,
      result: { count: number; addresses: { address: string; value: number; type: string }[] },
      step: { value?: number; direction?: "decreased" | "increased" | "unchanged" },
    ): Promise<QuickOutcome> {
      if (result.count === 0) {
        return notHandled(
          step.value !== undefined
            ? `Jev searched for ${what} = ${fmt(step.value)} and nothing matched.`
            : `Jev narrowed ${what} by "${step.direction}" and nothing was left: it may have moved the other way, or twice.`,
        );
      }
      const mine = want && want.what === what.toLowerCase() ? want : null;
      if (result.count <= FEW && mine?.bar && step.direction && mine.extra < MAX_EXTRA_STEPS) {
        // Found without a number, a few places can still be noise holding other values. Copies of the
        // real thing agree, so until they do, one more step is safer than writing to all of them.
        const decimals = result.addresses.filter((a) => a.type === "float" || a.type === "double");
        const values = (decimals.length ? decimals : result.addresses).map((a) => a.value);
        const agree = values.every((v) => Math.abs(v - values[0]) <= Math.max(0.01, Math.abs(values[0]) * 1e-3));
        if (!agree) {
          mine.extra++;
          return say(
            `Almost: ${result.count} places left. Make the ${what} go ${step.direction === "decreased" ? "up" : "down"} once more and tell me.`,
          );
        }
      }
      if (result.count <= FEW) {
        const goal: Goal | null = mine?.goal ?? session!.searchGoal;
        if (goal === null) {
          const addresses = result.addresses.map((a) => a.address);
          return opts.chatReady()
            ? { handled: false, note: `Jev narrowed ${what} to ${result.count} place(s): ${addresses.join(", ")}. The player hasn't said what to set it to here.` }
            : say(`Found ${what} (${result.count} place${result.count > 1 ? "s" : ""}). What should I set it to?`);
        }
        return writeGoal(what, goal, result.addresses, Boolean(mine?.bar));
      }
      const n = result.count.toLocaleString("en-US");
      // Too many to write: narrow further. Hands-free when the player said what to set it to
      // and the screen can be read: the player just plays, Telos watches the HUD for the
      // number to change and narrows on its own.
      const goal: Goal | null = mine?.goal ?? session!.searchGoal ?? null;
      if (goal !== null && canWatch()) {
        const watched = await autoNarrow(what, result, step.value ?? session!.searchValue ?? null, Boolean(mine?.bar));
        if (watched) return watched;
        // Watching wasn't possible or timed out: fall through and ask the player.
      }
      if (step.value !== undefined) {
        return say(`${n} places hold ${fmt(step.value)}. Change the ${what} in the game (use, spend or pick some up), then tell me the new number.`);
      }
      return say(
        step.direction === "unchanged"
          ? `${n} places could be it. Now make the ${what} go down or up again and tell me which way.`
          : `${n} places could be it. Now leave it alone for a few seconds and say "same", or make it go ` +
              `${step.direction === "decreased" ? "up" : "down"} and tell me.`,
      );
    }
  };
}

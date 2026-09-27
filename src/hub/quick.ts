import type { AgentEvent } from "./agent.ts";
import type { GameManager } from "./game.ts";
import { JEV_MAX_OPTIONS, JevError, type ChoiceAnswer, type Jev, type JevQuestion } from "./jev.ts";
import type { HubTool } from "./tools.ts";

/**
 * Scruff's fast path: every message goes to Jev first (one call, a fraction of a second). When
 * Jev is sure the message is a simple command (undo, set or lock a value Scruff already found,
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
  /** Called once when Jev stops working (bad key), so the UI can say so. */
  onDisabled?: (reason: string) => void;
}

/** Act on an intent only when Jev is at least this confident. */
const ACT = 0.6;
/** Picking which program to attach to, or which number to write, needs a clearer answer. */
const SURE = 0.7;
const FEW = 8;
const MAX_PROCESSES = 200;
const PROCESS_CACHE_MS = 10_000;
const JEV_BUDGET_MS = 3000;
const PHRASE_STOP = new Set(
  "and but so then give make set to can could please now it its it's i im i'm me my we the a an of for in on at with is are was left more".split(" "),
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
  return [...out].filter((p) => p.length > 1).slice(0, 20);
}

/** "Max" as a number: comfortably above what they have, without overflowing anything. */
export function maxFor(current: number): number {
  return Math.abs(current) < 1000 ? 999 : Math.abs(current) < 100_000 ? 99_999 : 999_999;
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 1000) / 1000));

export function quickPath(opts: QuickPathOptions): QuickHandler {
  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  let disabled: string | null = null;
  let callId = 0;
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
    if (!jev || disabled) return { handled: false };
    const { games } = opts;
    const session = games.session && !games.session.isClosed ? games.session : null;
    const supported = games.state().supported.ok;

    // --- what's on the table right now ---
    const numbers = findNumbers(text);
    const phrases = findPhrases(text, numbers);
    const watch = session ? games.state().attached?.watch ?? [] : [];
    const labels = [...new Set(watch.map((w) => w.label))].slice(0, 60);
    const search = session?.searchLabel && session.scanner.count > 0 ? session.searchLabel : null;
    const hasChanges = Boolean(session?.changes.some((c) => !c.undone));
    const wantsGame = !session || /\b(play|playing|game|switch|attach|connect|pick|open)\b/i.test(text);
    const processes = supported && wantsGame ? await runningPrograms() : [];

    const intents: Record<string, string> = {};
    if (session) {
      intents.find_and_change =
        "The player says how much of something they have right now and wants Scruff to change it " +
        "(for example 'I have 5 soup cans, give me 99' or 'I've got 350 gold, max it out').";
      if (search) {
        intents.report_new_amount =
          "The player tells Scruff the new amount of `search.what` they have now, after changing it in the game " +
          "(for example 'ok now it's 4.75', 'I have 3 now' or just a number).";
      }
      if (labels.length) {
        intents.set_known = "The player wants one of the `found_values` set to a specific amount or to the max.";
        intents.freeze_known =
          "The player wants one of the `found_values` locked or frozen so it never changes (infinite, never runs out).";
        if (watch.some((w) => w.frozen)) intents.unfreeze_known = "The player wants a locked value in `found_values` unlocked.";
        intents.read_known = "The player asks how much of one of the `found_values` they have.";
      }
      if (hasChanges) {
        intents.undo_last = "The player wants Scruff's most recent change taken back (undo that, put it back).";
        intents.undo_all = "The player wants every change Scruff made taken back (undo everything, reset it all).";
      }
    }
    if (processes.length) {
      intents.pick_game = "The player names the game they are playing, or asks Scruff to connect to a game.";
    }
    if (!Object.keys(intents).length) return { handled: false };
    intents.other =
      "Anything else: questions, advice, changing something without saying how much they have now, how the " +
      "overlay looks, or anything unclear.";

    const state = {
      player_message: text,
      game: session ? session.target.title || session.target.name : null,
      found_values: labels.length ? watch.map((w) => ({ name: w.label, now: w.value, locked: w.frozen })) : undefined,
      search: search ? { what: search, last_number: session!.searchValue } : undefined,
    };

    const numberOptions = Object.fromEntries(numbers.map((n, i) => [`n${i}`, `${n.text} (in "…${n.context}…")`]));
    const questions: Record<string, JevQuestion> = {
      intent: { type: "choice", instructions: "What does the player want Scruff to do with `player_message`?", criteria: intents },
    };
    if (session) {
      questions.wanted_number = {
        type: "choice",
        instructions: "What amount does the player want it to become?",
        criteria: {
          ...numberOptions,
          max: "As much as possible, with no number given (max, infinite, unlimited, tons, a lot).",
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
      if (err instanceof JevError && (err.status === 401 || err.status === 403)) {
        disabled = err.message;
        opts.onDisabled?.(err.message);
      }
      return { handled: false };
    }
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

    /** Writes the goal to every remaining result, then says honestly whether it held. */
    const writeGoal = async (what: string, goal: number, addresses: string[]) => {
      const out = await run("write_value", { addresses, value: goal, label: what });
      if (!out.ok) return notHandled(`Jev tried to set ${what} to ${fmt(goal)}, but the write failed: ${out.text}`);
      const report = JSON.parse(out.text) as { results: { warning?: string; error?: string }[] };
      const held = report.results.filter((r) => !r.warning && !r.error).length;
      if (!held) {
        return say(
          `I set ${what} to ${fmt(goal)}, but the game put it straight back. Say "lock ${what}" and I'll hold it there.`,
        );
      }
      return say(
        `Set ${what} to ${fmt(goal)}${addresses.length > 1 ? ` (${addresses.length} places)` : ""}. ` +
          `Does the game show ${fmt(goal)} now? Some games only redraw the number after you use or open something.`,
      );
    };
    const goalFrom = (current: number | null): number | null =>
      wantedKey === "max" ? maxFor(current ?? 0) : numberAt(wantedKey);

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
        const goal = goalFrom(entries[0]?.value ?? null);
        if (!entries.length || goal === null) return notHandled();
        return writeGoal(label!, goal, entries.map((e) => e.address));
      }
      case "freeze_known": {
        if (!entries.length) return notHandled();
        const goal = goalFrom(entries[0].value ?? null) ?? entries[0].value;
        if (typeof goal !== "number") return notHandled();
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
        const goal = goalFrom(currentNumber);
        if (currentNumber === null || goal === null || !thing) return notHandled();
        const out = await run("find_value", { what: thing, value: currentNumber, new_search: true, goal });
        if (!out.ok) return notHandled(`Jev started a search for ${thing} = ${fmt(currentNumber)}, but it failed: ${out.text}`);
        return afterSearch(thing, goal, JSON.parse(out.text), currentNumber);
      }
      case "report_new_amount": {
        if (currentNumber === null || !search) return notHandled();
        const out = await run("find_value", { what: search, value: currentNumber });
        if (!out.ok) return notHandled(`Jev tried to narrow ${search} to ${fmt(currentNumber)}, but: ${out.text}`);
        return afterSearch(search, session!.searchGoal, JSON.parse(out.text), currentNumber);
      }
      default:
        return notHandled();
    }

    async function afterSearch(
      what: string,
      goal: number | null,
      result: { count: number; addresses: { address: string }[] },
      value: number,
    ): Promise<QuickOutcome> {
      if (result.count === 0) {
        return notHandled(`Jev searched for ${what} = ${fmt(value)} and nothing matched.`);
      }
      if (result.count <= FEW) {
        const addresses = result.addresses.map((a) => a.address);
        if (goal === null) {
          return opts.chatReady()
            ? { handled: false, note: `Jev narrowed ${what} to ${result.count} place(s): ${addresses.join(", ")}. The player hasn't said what to set it to here.` }
            : say(`Found ${what} (${result.count} place${result.count > 1 ? "s" : ""}). What should I set it to?`);
        }
        return writeGoal(what, goal, addresses);
      }
      return say(
        `${result.count.toLocaleString("en-US")} places hold ${fmt(value)}. Change the ${what} in the game ` +
          `(use, spend or pick some up), then tell me the new number.`,
      );
    }
  };
}

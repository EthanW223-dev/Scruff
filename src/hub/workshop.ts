import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { describeProfile, type GameProfile } from "../games/profile.ts";
import { Agent, type AgentEvent, type Brain } from "./agent.ts";
import { SHELL, builderTools } from "./buildtools.ts";
import { onlineGame } from "../memory/safety.ts";
import { CHAT_HEADER, MCP_NAME, childEnv, explain, run, stopTree } from "./providers/claudecode.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * The Workshop: real mods, built for the player with universal-modder (its mod-any-game loop,
 * engine playbooks, knowledge base and `um` CLI). Telos's live tools change the running game;
 * the Workshop makes new content: items, weapons, enemies, mechanics, art.
 *
 * The builder is the chat's own AI. When that's Claude Code, Claude Code builds with
 * universal-modder loaded as a plugin. Any other AI (a local model, Claude through an API key,
 * an OpenAI-compatible service) drives Telos's own builder tools (buildtools.ts) with
 * universal-modder's loop as its instructions.
 *
 * It runs like a subagent of the chat: when the player asks for a mod, the chat AI starts a
 * build (build_mod) and carries on talking while it works in the background. The overlay shows
 * it as a hammering sprite the player can click to watch its steps, or stop it. One build runs
 * at a time; the next request for the same game continues the same session, so "now make the
 * nuke bigger" works.
 */

export type JobStatus = "running" | "done" | "failed" | "stopped";

export interface WorkshopStep {
  at: number;
  /** tool: something it did. say: what it told the player. */
  kind: "tool" | "say";
  text: string;
}

export interface WorkshopJob {
  id: number;
  game: string;
  engine: string;
  request: string;
  status: JobStatus;
  /** Carries on the last build for this game (same session, same folder). */
  continues: boolean;
  /** The AI building it ("Claude Code", "Ollama · qwen3:8b"). */
  builder?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  steps: WorkshopStep[];
  summary?: string;
  error?: string;
  /** The working folder: the mod's sources, MODLOG.md and Telos's log of the build. */
  folder: string;
}

export interface ClaudeLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
  /** A Claude Code model alias, or undefined for its own default. */
  model?: string;
}

/** Which AI builds: the chat's own choice. */
export type BuilderChoice =
  | { kind: "claude-code"; label: string; launch: ClaudeLaunch }
  | { kind: "chat"; label: string; brain: Brain; ready: boolean; problem?: string };

export interface WorkshopOptions {
  /** Telos's data folder: builds go under <dataDir>/workshop/<game>. */
  dataDir: string;
  /** universal-modder: Claude Code loads it with --plugin-dir; the chat AI reads it. */
  pluginDir: string;
  /** Telos's MCP endpoint: Claude Code can look at the game through Telos. */
  mcpUrl: string;
  /** The AI that builds (the chat's), asked when a build starts. */
  builder: () => BuilderChoice;
  /** Who'd build right now, for the overlay (cheap: called on every update). */
  describeBuilder?: () => { label: string; ready: boolean; problem?: string };
  /** Telos's own tools the chat AI may use while building (modding_guide, look_at_screen, game_info…). */
  extraTools?: () => import("./tools.ts").HubTool[];
  /** The environment its commands run in. */
  env?: NodeJS.ProcessEnv;
  /** The player's home folder (Documents/My Games is where many games keep mod sources). */
  home?: string;
}

/** Claude Code's tools the builder may use without asking: it can't ask mid-build. */
const BUILDER_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Skill",
  "TodoWrite",
  "Task",
  `mcp__${MCP_NAME}`,
  "mcp__fal",
].join(",");

/** Added to Claude Code's system prompt for a build. Kept free of quotes and % (it goes on a command line). */
const BUILDER_ROLE =
  "You are the mod builder of Telos, the in-game modding overlay, working in the background. The player asked for the " +
  "mod below. They are playing or away and cannot answer questions mid-build: make sensible choices, write them down " +
  "in MODLOG.md, and keep going. Follow universal-modder's mod-any-game skill: search its knowledge base, recon the " +
  "game, pick the route, back up saves before any modded launch, get one working slice first, then the rest. Work in " +
  "the current folder and the game's folders. Never touch online games or anti-cheat. Don't launch the game, drive the " +
  "mouse or keyboard, install anything outside the game's mod folders, or publish anything unless the request asks for " +
  "it. Telos's tools (mcp__telos) can look at the running game if it's open, to check your work. Finish with a short " +
  "summary for the player in plain words: what you built, where it is, and exactly how to load it in the game.";

const MAX_STEPS = 300;
/** Tool rounds the chat AI gets for one build. */
const CHAT_BUILD_STEPS = 160;

export class Workshop extends EventEmitter {
  private jobs: WorkshopJob[] = [];
  /** The game each build is for, until it ends. */
  private nextId = 1;
  /** The running build: how to stop it. */
  private active: { stop(): void } | null = null;
  private stopping = false;
  /** The chat-AI builder per game, so "now make it bigger" continues the same conversation. */
  private agents = new Map<string, { agent: Agent; model: string }>();
  private sessionsFile: string;

  constructor(private opts: WorkshopOptions) {
    super();
    this.sessionsFile = path.join(opts.dataDir, "workshop", "sessions.json");
  }

  get pluginReady(): boolean {
    return fs.existsSync(path.join(this.opts.pluginDir, "skills", "mod-any-game", "SKILL.md"));
  }

  /** The build that's running, if any. */
  get current(): WorkshopJob | null {
    return this.jobs.find((j) => j.status === "running") ?? null;
  }

  /** The newest build, running or not. */
  get latest(): WorkshopJob | null {
    return this.jobs.at(-1) ?? null;
  }

  job(id: number): WorkshopJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** What the overlay shows: the live (or latest) build, and a short history. */
  snapshot() {
    const view = (j: WorkshopJob) => ({ ...j, steps: j.steps.slice(-80), stepCount: j.steps.length });
    const live = this.current ?? this.jobs.at(-1) ?? null;
    return {
      available: this.pluginReady,
      builder: this.opts.describeBuilder?.() ?? null,
      job: live ? view(live) : null,
      history: this.jobs
        .filter((j) => j !== live)
        .slice(-5)
        .reverse()
        .map((j) => ({ id: j.id, game: j.game, request: j.request, status: j.status, summary: j.summary, error: j.error })),
    };
  }

  /** Starts building a mod for the attached game, in the background: the player asked for it. */
  start(profile: GameProfile, request: string, opts: { continues?: boolean } = {}): WorkshopJob {
    const text = request.trim();
    if (!text) throw new Error("Say what the mod should do.");
    if (!this.pluginReady) throw new Error("universal-modder isn't bundled with this Telos (vendor/universal-modder). Run npm run update:modder.");
    const online = onlineGame(profile.exe);
    if (online) throw new Error(`${online} is an online game with anti-cheat. Telos only builds mods for single-player games.`);
    const running = this.current;
    if (running) throw new Error(`Still building "${running.request}" for ${running.game}. Wait for it, or stop it first.`);
    const folder = path.join(this.opts.dataDir, "workshop", slug(profile.name));
    const continues = Boolean(opts.continues && (this.sessions()[slug(profile.name)] || this.agents.has(slug(profile.name)) || fs.existsSync(folder)));
    const job: WorkshopJob = {
      id: this.nextId++,
      game: profile.name,
      engine: profile.engine,
      request: text,
      status: "running",
      continues,
      createdAt: Date.now(),
      startedAt: Date.now(),
      steps: [],
      folder,
    };
    this.jobs.push(job);
    if (this.jobs.length > 20) this.jobs.splice(0, this.jobs.length - 20);
    this.emit("update");
    this.emit("notice", `Building "${text}" for ${profile.name} in the background. Click the hammer to watch.`);
    this.run(job, profile);
    return job;
  }

  stop(id?: number): void {
    const job = id === undefined ? this.jobs.find((j) => j.status === "running") : this.job(id);
    if (!job || job.status !== "running" || !this.active) return;
    this.stopping = true;
    this.active.stop();
  }

  close(): void {
    this.stop();
  }

  /** The folders a build may work in: its own, the game's, and Documents (My Games). */
  private dirs(job: WorkshopJob, profile: GameProfile): string[] {
    const dirs = [job.folder, profile.installDir, ...profile.saveDirs];
    const docs = path.join(this.opts.home ?? os.homedir(), "Documents");
    if (fs.existsSync(docs)) dirs.push(docs); // Documents/My Games/<game>/…: where many games keep mod sources
    return dirs;
  }

  private run(job: WorkshopJob, profile: GameProfile): void {
    fs.mkdirSync(job.folder, { recursive: true });
    const log = path.join(job.folder, `telos-build-${job.id}.log`);
    const note = (line: string) => {
      try {
        fs.appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // the log is a convenience
      }
    };
    note(`request: ${job.request}`);
    const prompt = [
      `Mod request from the player: ${job.request}`,
      job.continues ? "This continues your earlier work on this game: build on what's already in this folder (MODLOG.md says what was done)." : "",
      `Game: ${profile.name} (${profile.engine}). Exe: ${profile.exe}`,
      describeProfile(profile),
    ]
      .filter(Boolean)
      .join("\n\n");
    this.stopping = false;
    let choice: BuilderChoice;
    try {
      choice = this.opts.builder();
    } catch (err) {
      return this.finish(job, "failed", undefined, `No AI to build with: ${(err as Error).message}`);
    }
    job.builder = choice.label;
    note(`builder: ${choice.label}`);
    this.emit("update");
    if (choice.kind === "claude-code") this.startClaudeCode(job, profile, choice.launch, prompt, note);
    else this.startChat(job, profile, choice, prompt, note);
  }

  /** Records one step of the build (for the overlay and the build's log). */
  private step(job: WorkshopJob, step: WorkshopStep, note: (line: string) => void): void {
    job.steps.push(step);
    if (job.steps.length > MAX_STEPS) job.steps.splice(0, job.steps.length - MAX_STEPS);
    note(`${step.kind}: ${step.text}`);
    this.emit("update");
  }

  /** The chat's AI builds, with Telos's builder tools and universal-modder's loop as its instructions. */
  private startChat(job: WorkshopJob, profile: GameProfile, choice: Extract<BuilderChoice, { kind: "chat" }>, prompt: string, note: (line: string) => void): void {
    if (!choice.ready) return this.finish(job, "failed", undefined, `${choice.problem ?? "The chat AI isn't set up"}. Pick an AI in the AI menu, then build again.`);
    const dirs = this.dirs(job, profile);
    const key = slug(job.game);
    let entry = job.continues ? this.agents.get(key) : undefined;
    if (!entry || entry.model !== `${choice.label}`) {
      const tools = [
        ...builderTools({ cwd: job.folder, roots: dirs, readOnlyRoots: [this.opts.pluginDir], env: this.opts.env ?? process.env, pluginDir: this.opts.pluginDir }),
        ...(this.opts.extraTools?.() ?? []),
      ];
      entry = {
        agent: new Agent({ brain: choice.brain, tools, status: () => ({ note: "", events: [] }), system: this.builderPrompt(job, profile, dirs), maxSteps: CHAT_BUILD_STEPS }),
        model: choice.label,
      };
      this.agents.set(key, entry);
    }
    const agent = entry.agent;
    let said = "";
    let lastWords = "";
    let error: string | undefined;
    const flush = () => {
      const text = said.trim();
      if (text) this.step(job, { at: Date.now(), kind: "say", text: text.slice(0, 600) }, note);
      said = "";
    };
    const onEvent = (e: AgentEvent) => {
      if (job.status !== "running") return;
      if (e.type === "text") {
        said += e.text;
        lastWords += e.text;
      } else if (e.type === "tool_call") {
        flush();
        lastWords = "";
        this.step(job, { at: Date.now(), kind: "tool", text: describeTool(e.name, (e.input ?? {}) as Record<string, any>) }, note);
      } else if (e.type === "tool_result" && !e.ok) {
        this.step(job, { at: Date.now(), kind: "tool", text: `  ↳ ${e.text.split(/\r?\n/)[0].slice(0, 160)}` }, note);
      } else if (e.type === "error") {
        error = e.text;
      } else if (e.type === "turn_end") {
        flush();
        agent.off("event", onEvent);
        this.active = null;
        if (this.stopping) return this.finish(job, "stopped");
        if (error) return this.finish(job, "failed", undefined, error);
        this.finish(job, "done", lastWords.trim() || "The build finished without a summary. MODLOG.md in its folder has the details.");
      }
    };
    agent.on("event", onEvent);
    this.active = { stop: () => agent.stop() };
    agent.send(prompt);
  }

  /** The chat AI's instructions for a build: Telos's rules and universal-modder's loop. */
  private builderPrompt(job: WorkshopJob, profile: GameProfile, dirs: string[]): string {
    let loop = "";
    try {
      loop = fs.readFileSync(path.join(this.opts.pluginDir, "skills", "mod-any-game", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    } catch {
      // modding_guide still has it
    }
    return [
      BUILDER_ROLE.replace("Telos's tools (mcp__telos) can look at the running game if it's open, to check your work.", "look_at_screen shows the running game if it's open, to check your work."),
      `Your tools: run_command (${SHELL}), read_file, write_file, edit_file, list_files, search_files, fetch_url, download_file, ` +
        "modding_guide (universal-modder's engine playbooks, skills and field notes: start with it), and Telos's game tools. " +
        "Work step by step: one tool call, look at the result, then the next. Don't stop to ask the player anything.",
      `The game: ${profile.name} (${profile.engine}), installed at ${profile.installDir}. The build folder: ${job.folder}. ` +
        `You can change files in: ${dirs.join("; ")}.`,
      "universal-modder's CLI is `python -m um <group> ...` (Python 3.10+ with pillow, numpy and pyyaml; if Python is missing, " +
        "do without it). Where its loop below says `um ...`, run `python -m um ...`. Its fal art commands need FAL_KEY.",
      `# universal-modder's loop (mod-any-game)\n${loop}`,
    ].join("\n\n");
  }

  /** Claude Code builds, with universal-modder loaded as a plugin. */
  private startClaudeCode(job: WorkshopJob, profile: GameProfile, launch: ClaudeLaunch, prompt: string, note: (line: string) => void): void {
    const config = path.join(job.folder, "telos-mcp.json");
    const servers: Record<string, unknown> = {
      [MCP_NAME]: { type: "http", url: this.opts.mcpUrl, headers: { [CHAT_HEADER]: "workshop" } },
    };
    // fal makes sprites, models and sounds; universal-modder's own config, when the player has a key.
    if (launch.env.FAL_KEY) servers.fal = { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer ${FAL_KEY}" } };
    fs.writeFileSync(config, JSON.stringify({ mcpServers: servers }, null, 2));

    const dirs = this.dirs(job, profile).slice(1); // its own folder is where it starts
    const session = job.continues ? this.sessions()[slug(job.game)] : undefined;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--plugin-dir",
      this.opts.pluginDir,
      "--mcp-config",
      config,
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      BUILDER_TOOLS,
      "--append-system-prompt",
      BUILDER_ROLE,
      ...dirs.flatMap((d) => ["--add-dir", d]),
      ...(launch.model && launch.model !== "default" ? ["--model", launch.model] : []),
      ...(session ? ["--resume", session] : []),
    ];
    let child: ChildProcess;
    try {
      child = run(launch.command, args, { cwd: job.folder, env: childEnv(launch.env) });
    } catch (err) {
      return this.finish(job, "failed", undefined, explain((err as Error).message, launch.command));
    }
    this.active = { stop: () => stopTree(child) };
    let result: Record<string, any> | null = null;
    let stderr = "";
    const noise: string[] = [];
    let buf = "";
    const onLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(t);
      } catch {
        noise.push(t);
        return;
      }
      if (typeof msg.session_id === "string" && msg.session_id) this.saveSession(slug(job.game), msg.session_id);
      if (msg.type === "result") {
        result = msg;
        return;
      }
      // A subagent's own messages are its business; its result comes back as a tool result.
      if (msg.type !== "assistant" || msg.parent_tool_use_id) return;
      for (const b of msg.message?.content ?? []) {
        const step: WorkshopStep | null =
          b.type === "tool_use" ? { at: Date.now(), kind: "tool", text: describeTool(b.name, b.input ?? {}) } : b.type === "text" && b.text?.trim() ? { at: Date.now(), kind: "say", text: b.text.trim().slice(0, 600) } : null;
        if (step) this.step(job, step, note);
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => {
      this.active = null;
      this.finish(job, "failed", undefined, explain((err as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : err.message, launch.command));
    });
    child.on("close", (code) => {
      if (job.status !== "running") return;
      this.active = null;
      if (buf) onLine(buf);
      const r = result as Record<string, any> | null;
      note(`exit ${code}${r ? `, result ${r.subtype}` : ""}`);
      if (this.stopping) return this.finish(job, "stopped");
      if (r && !r.is_error && (r.subtype === "success" || r.subtype === undefined)) {
        return this.finish(job, "done", typeof r.result === "string" ? r.result.trim() : undefined);
      }
      const why =
        (r && (typeof r.result === "string" && r.result ? r.result : Array.isArray(r.errors) ? r.errors.join("; ") : r.subtype)) ||
        [stderr.trim(), ...noise].filter(Boolean).join("\n") ||
        `exited with code ${code}`;
      this.finish(job, "failed", undefined, explain(String(why), launch.command));
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" }) + "\n");
  }

  private finish(job: WorkshopJob, status: JobStatus, summary?: string, error?: string): void {
    job.status = status;
    job.endedAt = Date.now();
    if (summary) job.summary = summary;
    if (error) job.error = error;
    this.emit("update");
    if (status === "done") {
      this.emit("notice", `The ${job.game} mod is built. ${firstSentences(job.summary ?? "Click the hammer for the details.", 2)}`);
    } else if (status === "failed") {
      this.emit("notice", `The ${job.game} mod build stopped with a problem. ${error ?? ""}`.trim());
    } else if (status === "stopped") {
      this.emit("notice", `Stopped building "${job.request}". What it made so far stays in its folder.`);
    }
  }

  private sessions(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.sessionsFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private saveSession(game: string, id: string): void {
    const all = this.sessions();
    if (all[game] === id) return;
    all[game] = id;
    try {
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      fs.writeFileSync(this.sessionsFile, JSON.stringify(all, null, 2));
    } catch {
      // the next build just starts fresh
    }
  }
}

/** One line for the overlay: what a Claude Code tool call did. */
export function describeTool(name: string, input: Record<string, any>): string {
  const short = (s: unknown, n = 140) => String(s ?? "").split(/\r?\n/)[0].slice(0, n);
  const file = (p: unknown) => path.basename(String(p ?? ""));
  switch (name) {
    case "Bash":
    case "run_command":
      return `$ ${short(input.command)}`;
    case "read_file":
      return `read ${file(input.path)}`;
    case "write_file":
      return `write ${file(input.path)}`;
    case "edit_file":
      return `edit ${file(input.path)}`;
    case "list_files":
      return `list ${short(input.path ?? ".", 80)}`;
    case "search_files":
      return `search ${short(input.pattern, 80)}`;
    case "fetch_url":
      return `read ${short(input.url, 100)}`;
    case "download_file":
      return `download ${file(input.to)}`;
    case "modding_guide":
      return `guide${input.open ? `: ${short(input.open, 80)}` : input.query ? `: ${short(input.query, 80)}` : ""}`;
    case "Read":
      return `read ${file(input.file_path)}`;
    case "Write":
      return `write ${file(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `edit ${file(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `search ${short(input.pattern, 80)}`;
    case "WebFetch":
      return `read ${short(input.url, 100)}`;
    case "WebSearch":
      return `search the web: ${short(input.query, 100)}`;
    case "Skill":
      return `skill ${short(input.skill ?? input.name ?? input.command, 60)}`;
    case "Task":
      return `helper: ${short(input.description, 100)}`;
    case "TodoWrite": {
      const doing = (input.todos ?? []).find((t: any) => t.status === "in_progress");
      return `plan: ${short(doing?.activeForm ?? doing?.content ?? `${(input.todos ?? []).length} steps`, 100)}`;
    }
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      if (m) return `${m[1] === MCP_NAME ? "telos" : m[1]} ${m[2].replace(/_/g, " ")}`;
      // Telos's own tools, when the chat AI builds.
      if (/^[a-z][a-z_]+$/.test(name)) return `telos ${name.replace(/_/g, " ")}`;
      return name;
    }
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "game";
}

function firstSentences(text: string, n: number): string {
  const parts = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) ?? [text];
  return parts.slice(0, n).join("").trim().slice(0, 300);
}

/** The chat AI's side: start a build (its background builder), check on it, stop it. */
export function workshopTools(workshop: Workshop, profile: () => GameProfile | null): HubTool[] {
  if (!workshop.pluginReady) return [];
  const view = (j: WorkshopJob | null | undefined) =>
    j && {
      id: j.id,
      game: j.game,
      request: j.request,
      status: j.status,
      running_for: j.startedAt ? `${Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 60000)} min` : undefined,
      recent_steps: j.steps.slice(-12).map((s) => (s.kind === "say" ? `said: ${s.text}` : s.text)),
      summary: j.summary,
      problem: j.error,
      folder: j.folder,
    };
  return [
    defineTool({
      name: "build_mod",
      description:
        "Start your mod builder: a background helper that builds a REAL mod for the attached game with universal-modder " +
        "(new items, weapons, enemies, bosses, mechanics, art, sounds), installs it and tests it, running commands and " +
        "editing files on the player's PC. Only when the player asks you to make or build a mod (and no ready-made one from " +
        "find_mods fits). It starts right away and works on its own, often for many minutes: say so in a sentence and keep " +
        "chatting. The player sees a hammer in the overlay and can click it to watch or stop it. Single-player games only.",
      input: z.object({
        request: z.string().describe("The mod, complete and in the player's words, with any details they gave"),
        continue_previous: z.boolean().optional().describe("Build on the last build for this game (e.g. 'make the nuke bigger')"),
      }),
      run({ request, continue_previous }) {
        const p = profile();
        if (!p) throw new Error("Attach to the game first: the builder needs to know which game and where it's installed.");
        const job = workshop.start(p, request, { continues: continue_previous });
        return json({
          started: view(job),
          next: "It's building in the background. Tell the player in a sentence that it's started, that they can click the hammer to watch, and that Telos says when it's done.",
        });
      },
    }),
    defineTool({
      name: "workshop_status",
      description: "What your mod builder is doing: the current or last build, its recent steps, and its summary when done.",
      input: z.object({}),
      readOnly: true,
      run() {
        const s = workshop.snapshot();
        return json({ build: view(s.job ? workshop.job(s.job.id) : null) ?? "No builds yet.", earlier: s.history });
      },
    }),
    defineTool({
      name: "stop_mod_build",
      description: "Stop your mod builder's running build (what it made so far stays in its folder).",
      input: z.object({}),
      run() {
        const j = workshop.current;
        if (!j) return "Nothing is being built.";
        workshop.stop(j.id);
        return "Stopping the build.";
      },
    }),
  ];
}

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { describeProfile, type GameProfile } from "../games/profile.ts";
import { onlineGame } from "../memory/safety.ts";
import { CHAT_HEADER, MCP_NAME, childEnv, explain, run, stopTree } from "./providers/claudecode.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * The Workshop: real mods, built for the player by Claude Code with universal-modder loaded as
 * a plugin (its mod-any-game loop, engine playbooks, knowledge base and `um` CLI). Telos's live
 * tools change the running game; the Workshop makes new content: items, weapons, enemies,
 * mechanics, art.
 *
 * Building a mod means running commands and editing files on the player's PC, for minutes or
 * hours. So nothing starts without the player: the chat AI can only propose a build
 * (build_mod), and the player presses Build in the overlay. One build runs at a time; the next
 * request for the same game continues the same Claude Code session, so "now make the nuke
 * bigger" works.
 */

export type JobStatus = "proposed" | "running" | "done" | "failed" | "stopped" | "declined";

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
  /** Who asked: the player in the Workshop window, or the chat AI (which needs the player's OK). */
  by: "player" | "ai";
  /** Carries on the last build for this game (same Claude Code session). */
  continues: boolean;
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

export interface WorkshopOptions {
  /** Telos's data folder: builds go under <dataDir>/workshop/<game>. */
  dataDir: string;
  /** universal-modder, loaded into Claude Code with --plugin-dir. */
  pluginDir: string;
  /** Telos's MCP endpoint: the builder can look at the game through Telos. */
  mcpUrl: string;
  /** How to run Claude Code (the same command the chat's Claude Code choice uses). */
  launch: () => ClaudeLaunch;
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
  "You are the mod workshop of Telos, the in-game modding overlay. The player asked for the mod below and approved " +
  "this build. They are playing or away and cannot answer questions mid-build: make sensible choices, write them down " +
  "in MODLOG.md, and keep going. Follow universal-modder's mod-any-game skill: search its knowledge base, recon the " +
  "game, pick the route, back up saves before any modded launch, get one working slice first, then the rest. Work in " +
  "the current folder and the game's folders. Never touch online games or anti-cheat. Don't launch the game, drive the " +
  "mouse or keyboard, install anything outside the game's mod folders, or publish anything unless the request asks for " +
  "it. Telos's tools (mcp__telos) can look at the running game if it's open, to check your work. Finish with a short " +
  "summary for the player in plain words: what you built, where it is, and exactly how to load it in the game.";

const MAX_STEPS = 300;

export class Workshop extends EventEmitter {
  private jobs: WorkshopJob[] = [];
  /** The game each build is for, until it ends. */
  private profiles = new Map<number, GameProfile>();
  private nextId = 1;
  private child: ChildProcess | null = null;
  private stopping = false;
  private sessionsFile: string;

  constructor(private opts: WorkshopOptions) {
    super();
    this.sessionsFile = path.join(opts.dataDir, "workshop", "sessions.json");
  }

  get pluginReady(): boolean {
    return fs.existsSync(path.join(this.opts.pluginDir, "skills", "mod-any-game", "SKILL.md"));
  }

  get current(): WorkshopJob | null {
    return this.jobs.find((j) => j.status === "running") ?? this.jobs.find((j) => j.status === "proposed") ?? null;
  }

  job(id: number): WorkshopJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** What the overlay shows: the live (or latest) build, and a short history. */
  snapshot() {
    const view = (j: WorkshopJob) => ({ ...j, steps: j.steps.slice(-40), stepCount: j.steps.length });
    const live = this.current ?? this.jobs.at(-1) ?? null;
    return {
      available: this.pluginReady,
      job: live ? view(live) : null,
      history: this.jobs
        .filter((j) => j !== live)
        .slice(-5)
        .reverse()
        .map((j) => ({ id: j.id, game: j.game, request: j.request, status: j.status, summary: j.summary, error: j.error })),
    };
  }

  /** A build for the attached game. The chat AI's proposals wait for the player; the player's own start right away. */
  propose(profile: GameProfile, request: string, opts: { by: "player" | "ai"; continues?: boolean }): WorkshopJob {
    const text = request.trim();
    if (!text) throw new Error("Say what the mod should do.");
    if (!this.pluginReady) throw new Error("universal-modder isn't bundled with this Telos (vendor/universal-modder). Run npm run update:modder.");
    const online = onlineGame(profile.exe);
    if (online) throw new Error(`${online} is an online game with anti-cheat. The Workshop only builds mods for single-player games.`);
    const running = this.jobs.find((j) => j.status === "running");
    if (running) throw new Error(`The Workshop is still building "${running.request}" for ${running.game}. Wait for it, or stop it first.`);
    // A newer proposal replaces one still waiting for the player.
    for (const j of this.jobs) if (j.status === "proposed") j.status = "declined";
    const folder = path.join(this.opts.dataDir, "workshop", slug(profile.name));
    const continues = Boolean(opts.continues && this.sessions()[slug(profile.name)]);
    const job: WorkshopJob = {
      id: this.nextId++,
      game: profile.name,
      engine: profile.engine,
      request: text,
      status: "proposed",
      by: opts.by,
      continues,
      createdAt: Date.now(),
      steps: [],
      folder,
    };
    this.jobs.push(job);
    if (this.jobs.length > 20) this.jobs.splice(0, this.jobs.length - 20);
    this.profiles.set(job.id, profile);
    this.emit("update");
    if (opts.by === "player") this.approve(job.id);
    else this.emit("notice", `The AI wants to build a mod for ${profile.name}: "${text}". Open the Workshop window to start it.`);
    return job;
  }

  approve(id: number): void {
    const job = this.job(id);
    if (!job || job.status !== "proposed") throw new Error("That build isn't waiting to start.");
    const profile = this.profiles.get(id);
    if (!profile) throw new Error("Telos lost track of that game; propose the build again.");
    job.status = "running";
    job.startedAt = Date.now();
    this.emit("update");
    this.emit("notice", `Workshop: building "${job.request}" for ${job.game}. This can take a while; Telos tells you when it's done.`);
    this.start(job, profile);
  }

  decline(id: number): void {
    const job = this.job(id);
    if (!job || job.status !== "proposed") return;
    job.status = "declined";
    job.endedAt = Date.now();
    this.emit("update");
  }

  stop(id?: number): void {
    const job = id === undefined ? this.jobs.find((j) => j.status === "running") : this.job(id);
    if (!job) return;
    if (job.status === "proposed") return this.decline(job.id);
    if (job.status !== "running" || !this.child) return;
    this.stopping = true;
    stopTree(this.child);
  }

  close(): void {
    this.stop();
  }

  private start(job: WorkshopJob, profile: GameProfile): void {
    fs.mkdirSync(job.folder, { recursive: true });
    const launch = this.opts.launch();
    const config = path.join(job.folder, "telos-mcp.json");
    const servers: Record<string, unknown> = {
      [MCP_NAME]: { type: "http", url: this.opts.mcpUrl, headers: { [CHAT_HEADER]: "workshop" } },
    };
    // fal makes sprites, models and sounds; universal-modder's own config, when the player has a key.
    if (launch.env.FAL_KEY) servers.fal = { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer ${FAL_KEY}" } };
    fs.writeFileSync(config, JSON.stringify({ mcpServers: servers }, null, 2));

    const dirs = [profile.installDir, ...profile.saveDirs];
    const docs = path.join(this.opts.home ?? os.homedir(), "Documents");
    if (fs.existsSync(docs)) dirs.push(docs); // Documents/My Games/<game>/…: where many games keep mod sources
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
    const prompt = [
      `Mod request from the player: ${job.request}`,
      job.continues ? "This continues your earlier work on this game: build on what's already in this folder." : "",
      `Game: ${profile.name} (${profile.engine}). Exe: ${profile.exe}`,
      describeProfile(profile),
    ]
      .filter(Boolean)
      .join("\n\n");
    const log = path.join(job.folder, `telos-build-${job.id}.log`);
    const note = (line: string) => {
      try {
        fs.appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // the log is a convenience
      }
    };
    note(`request: ${job.request}`);

    let child: ChildProcess;
    try {
      child = run(launch.command, args, { cwd: job.folder, env: childEnv(launch.env) });
    } catch (err) {
      return this.finish(job, "failed", undefined, explain((err as Error).message, launch.command));
    }
    this.child = child;
    this.stopping = false;
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
        if (!step) continue;
        job.steps.push(step);
        if (job.steps.length > MAX_STEPS) job.steps.splice(0, job.steps.length - MAX_STEPS);
        note(`${step.kind}: ${step.text}`);
        this.emit("update");
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
      this.child = null;
      this.finish(job, "failed", undefined, explain((err as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : err.message, launch.command));
    });
    child.on("close", (code) => {
      if (job.status !== "running") return;
      this.child = null;
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
    this.profiles.delete(job.id);
    this.emit("update");
    if (status === "done") {
      this.emit("notice", `Workshop: the ${job.game} mod is built. ${firstSentences(job.summary ?? "See the Workshop window.", 2)}`);
    } else if (status === "failed") {
      this.emit("notice", `Workshop: the ${job.game} build stopped with a problem. ${error ?? ""}`.trim());
    } else if (status === "stopped") {
      this.emit("notice", `Workshop: stopped building "${job.request}". What it made so far stays in its folder.`);
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
      return `$ ${short(input.command)}`;
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

/** The chat AI's side: propose a build (the player starts it), check on it, stop it. */
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
        "Propose a REAL mod for the attached game to Telos's Workshop: Claude Code with universal-modder builds it (new " +
        "items, weapons, enemies, bosses, mechanics, art, sounds), installs it and tests it. Use it for anything Telos's " +
        "live tools can't do. It runs commands and edits files on the player's PC and can take a long time, so it only " +
        "starts when the player presses Build in the overlay's Workshop window: tell them that. Check modding_guide first " +
        "to set expectations. Single-player games only.",
      input: z.object({
        request: z.string().describe("The mod, complete and in the player's words, with any details they gave"),
        continue_previous: z.boolean().optional().describe("Build on the last Workshop build for this game (e.g. 'make the nuke bigger')"),
      }),
      run({ request, continue_previous }) {
        const p = profile();
        if (!p) throw new Error("Attach to the game first: the Workshop needs to know which game and where it's installed.");
        const job = workshop.propose(p, request, { by: "ai", continues: continue_previous });
        return json({
          proposed: view(job),
          next: "Waiting for the player: they press Build in the Workshop window of the overlay (Ctrl+T) to start it. Say so in one or two sentences, and that it can take a while.",
        });
      },
    }),
    defineTool({
      name: "workshop_status",
      description: "What Telos's Workshop is doing: the current or last mod build, its recent steps, and its summary when done.",
      input: z.object({}),
      readOnly: true,
      run() {
        const s = workshop.snapshot();
        return json({ build: view(s.job ? workshop.job(s.job.id) : null) ?? "No builds yet.", earlier: s.history });
      },
    }),
    defineTool({
      name: "stop_mod_build",
      description: "Stop the Workshop's running mod build (what it made so far stays in its folder).",
      input: z.object({}),
      run() {
        const j = workshop.current;
        if (!j) return "Nothing is being built.";
        const waiting = j.status === "proposed";
        workshop.stop(j.id);
        return waiting ? "Dropped the proposed build." : "Stopping the build.";
      },
    }),
  ];
}

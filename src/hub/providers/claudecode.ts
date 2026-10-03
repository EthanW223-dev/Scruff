import type Anthropic from "@anthropic-ai/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ModelStream, StreamFactory } from "../agent.ts";

/**
 * Claude Code as Telos's brain. Each chat message runs the player's own `claude` command
 * headless (`claude -p`, JSON in and out), with Telos's tools plugged in over MCP, so the
 * reply comes from whatever that command is set up with: a Claude Pro/Max login, an API
 * key, or a router. Claude Code runs its own tool loop and calls Telos's tools itself (they
 * show up in the overlay like any other tool call); Telos just streams its words. The
 * conversation continues by resuming the same Claude Code session; "New chat" starts a
 * fresh one.
 */

/** "default" leaves the model to Claude Code's own setting. */
export const CLAUDE_CODE_MODELS = ["default", "sonnet", "opus", "haiku"];

/** The name Telos's MCP server gets inside Claude Code: its tools are mcp__telos__*. */
export const MCP_NAME = "telos";
/** Sent with every MCP request from these runs, so Telos knows they're its own chat. */
export const CHAT_HEADER = "x-telos-chat";

export interface ClaudeCodeOptions {
  /** The command to run; "claude" (found on PATH) unless SCRUFF_CLAUDE_COMMAND says otherwise. */
  command: string;
  /** Telos's MCP endpoint. */
  mcpUrl: string;
  /** Where Claude Code runs: a folder of Telos's own, so no project's settings or CLAUDE.md come along. */
  cwd: string;
  /** Its environment (see ModelRouter: Telos's own Anthropic key is left out). */
  env: NodeJS.ProcessEnv;
}

/** Added to Claude Code's system prompt. Telos's full modding guide reaches it as the MCP server's instructions. */
const ROLE =
  "You are the brain of Telos, an in-game overlay that live-mods the single-player PC game the player is playing. " +
  "The player talks to you from inside the game, often by voice, and your replies may be read aloud: answer in one to " +
  "three short sentences with no markdown, and do the work with the mcp__telos tools instead of explaining how. " +
  "Notes in [Telos status] blocks come from Telos, not the player.";

/** Claude Code's built-in tools that act on the PC itself: never from the game overlay. */
const NOT_FROM_OVERLAY = "Bash,Edit,Write,MultiEdit,NotebookEdit,KillShell";

/** Flags newer than some Claude Code installs; dropped (and remembered) when a command rejects them. */
const OPTIONAL_FLAGS = ["--include-partial-messages"];
const unsupported = new Map<string, Set<string>>();

type Params = Parameters<StreamFactory>[0];
type Message = Anthropic.Beta.BetaMessage;

export function claudeCodeStreamFactory(opts: ClaudeCodeOptions): StreamFactory {
  // One Claude Code session per conversation: the agent's history array identifies it
  // ("New chat" gives the agent a fresh array, so a fresh session).
  const sessions = new WeakMap<object, string>();
  return (params, signal) => {
    const key = params.messages as unknown as object;
    return new ClaudeCodeStream(opts, params, signal, sessions.get(key), (id) => sessions.set(key, id));
  };
}

class ClaudeCodeStream extends EventEmitter implements ModelStream {
  private result: Promise<Message>;

  constructor(
    private opts: ClaudeCodeOptions,
    private params: Params,
    private signal: AbortSignal,
    private resume: string | undefined,
    private onSession: (id: string) => void,
  ) {
    super();
    this.result = this.run();
    // finalMessage() may be called later; don't let an early failure go unhandled meanwhile.
    this.result.catch(() => {});
  }

  finalMessage(): Promise<Message> {
    return this.result;
  }

  private async run(): Promise<Message> {
    fs.mkdirSync(this.opts.cwd, { recursive: true });
    const skip = unsupported.get(this.opts.command) ?? new Set<string>();
    for (;;) {
      const outcome = await this.attempt(skip);
      if (outcome.kind === "done") return outcome.message;
      const flag = OPTIONAL_FLAGS.find((f) => !skip.has(f) && outcome.text.includes(f));
      if (flag && /unknown option|unrecognized/i.test(outcome.text)) {
        skip.add(flag);
        unsupported.set(this.opts.command, skip);
        continue;
      }
      // Claude Code no longer has the conversation (cleaned up, or another PC): carry on in a new one.
      if (this.resume && /no conversation found|session.*not found/i.test(outcome.text)) {
        this.resume = undefined;
        continue;
      }
      throw new Error(explain(outcome.text, this.opts.command));
    }
  }

  /** The command line for this run. */
  private args(skip: Set<string>): string[] {
    // With Telos's tools (a chat turn) or without (a one-off question, like reading a screenshot).
    const agentic = Boolean(this.params.tools?.length);
    const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
    for (const f of OPTIONAL_FLAGS) if (!skip.has(f)) args.push(f);
    if (this.params.model && this.params.model !== "default") args.push("--model", this.params.model);
    if (this.resume) args.push("--resume", this.resume);
    args.push("--strict-mcp-config", "--disallowedTools", NOT_FROM_OVERLAY);
    if (agentic) {
      const config = path.join(this.opts.cwd, "telos-mcp.json");
      fs.writeFileSync(
        config,
        JSON.stringify({ mcpServers: { [MCP_NAME]: { type: "http", url: this.opts.mcpUrl, headers: { [CHAT_HEADER]: "1" } } } }, null, 2),
      );
      args.push("--mcp-config", config, "--allowedTools", `mcp__${MCP_NAME}`, "--append-system-prompt", ROLE);
    } else if (typeof this.params.system === "string" && this.params.system.length < 600) {
      args.push("--append-system-prompt", safeArg(this.params.system));
    }
    return args;
  }

  /** The newest user message, as Claude Code's stream-json input (text and screenshots). */
  private input(): string {
    const last = this.params.messages[this.params.messages.length - 1];
    const content =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? []).flatMap((b): Record<string, unknown>[] =>
            b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "image" ? [{ type: "image", source: b.source }] : [],
          );
    return JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.resume ?? "" }) + "\n";
  }

  /** One run of the command. */
  private attempt(skip: Set<string>): Promise<{ kind: "done"; message: Message } | { kind: "failed"; text: string }> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) return reject(abortError());
      let child: ChildProcess;
      try {
        child = run(this.opts.command, this.args(skip), { cwd: this.opts.cwd, env: childEnv(this.opts.env) });
      } catch (err) {
        return resolve({ kind: "failed", text: (err as Error).message });
      }
      const onAbort = () => stopTree(child);
      this.signal.addEventListener("abort", onAbort, { once: true });

      const texts: string[] = [];
      let streamed = false; // partial chunks arrive: whole messages then only fill in the final text
      let result: Record<string, any> | null = null;
      const noise: string[] = []; // anything that isn't Claude Code's JSON (a wrapper's banner, errors)
      let stderr = "";
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
        if (typeof msg.session_id === "string" && msg.session_id) this.onSession(msg.session_id);
        // A subagent's own messages aren't the reply.
        if (msg.parent_tool_use_id) return;
        if (msg.type === "stream_event") {
          const d = msg.event?.type === "content_block_delta" ? msg.event.delta : null;
          if (d?.type === "text_delta" && d.text) {
            streamed = true;
            this.emit("text", d.text);
          } else if (d?.type === "thinking_delta" && d.thinking) {
            streamed = true;
            this.emit("thinking", d.thinking);
          }
        } else if (msg.type === "assistant") {
          for (const b of msg.message?.content ?? []) {
            if (b.type === "text" && b.text) {
              texts.push(b.text);
              if (!streamed) this.emit("text", b.text);
            } else if (b.type === "thinking" && b.thinking && !streamed) {
              this.emit("thinking", b.thinking);
            }
          }
        } else if (msg.type === "result") {
          result = msg;
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
        this.signal.removeEventListener("abort", onAbort);
        resolve({ kind: "failed", text: (err as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : err.message });
      });
      child.on("close", (code) => {
        this.signal.removeEventListener("abort", onAbort);
        if (buf) onLine(buf);
        if (this.signal.aborted) return reject(abortError());
        const r = result as Record<string, any> | null;
        if (r && !r.is_error && (r.subtype === "success" || r.subtype === undefined)) {
          const text = texts.join("\n\n") || (typeof r.result === "string" ? r.result : "");
          return resolve({ kind: "done", message: finalMessage(text, this.params.model) });
        }
        const why =
          (r && (typeof r.result === "string" && r.result ? r.result : Array.isArray(r.errors) ? r.errors.join("; ") : r.subtype)) ||
          [stderr.trim(), ...noise].filter(Boolean).join("\n") ||
          `exited with code ${code}`;
        resolve({ kind: "failed", text: String(why) });
      });
      child.stdin!.on("error", () => {}); // it may exit before reading (a bad flag): the close handler reports that
      child.stdin!.end(this.input());
    });
  }
}

/** Whether the command runs, and its version line. */
export async function probeClaudeCode(command: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = run(command, ["--version"], { env: childEnv(env) });
    } catch (err) {
      return resolve({ ok: false, detail: explain((err as Error).message, command) });
    }
    const timer = setTimeout(() => {
      stopTree(child);
      resolve({ ok: false, detail: `\`${command} --version\` didn't answer within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (out += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: explain((err as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : err.message, command) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = /\d+\.\d+\.\d+[^\r\n]*/.exec(out)?.[0]?.trim();
      if (code === 0 && version) return resolve({ ok: true, detail: `${path.basename(command)} ${version}` });
      resolve({ ok: false, detail: explain(out.trim() || `exited with code ${code}`, command) });
    });
  });
}

/** Turns what went wrong into something the player can act on. */
export function explain(text: string, command: string): string {
  const line = errorLine(text);
  // Only when it's the command itself that's missing: a build's own "dotnet: command not found" is something else.
  const name = (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe|bat)$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missing = new RegExp(`'${name}(\\.\\w+)?' is not recognized as an internal or external command|(^|[\\s/\\\\])${name}(\\.\\w+)?: (command )?not found`, "i");
  if (text === "not found" || /ENOENT/.test(text) || missing.test(text)) {
    return `Telos couldn't find Claude Code (the \`${command}\` command). Install it from claude.com/claude-code, or set SCRUFF_CLAUDE_COMMAND in .env to where it is.`;
  }
  if (/\/login|not logged in|invalid api key|authentication_error|oauth token/i.test(text)) {
    return "Claude Code isn't logged in. Run `claude` in a terminal once and log in, then try again.";
  }
  if (/unknown option|unrecognized/i.test(text)) {
    return (
      `Your \`${command}\` command didn't accept Claude Code's options (${line.slice(0, 200)}). If it's a wrapper or an old ` +
      "version, update Claude Code (`claude update`) or set SCRUFF_CLAUDE_COMMAND in .env to the real Claude Code."
    );
  }
  return `Claude Code: ${line.slice(0, 400)}`;
}

/** The line that says what went wrong: a wrapper may print a banner first. */
function errorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|unknown option|not recognized|invalid|denied|fail|log ?in|not found/i.test(l)) ?? lines[0] ?? text;
}

function finalMessage(text: string, model: string): Message {
  return {
    id: `cc_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: text ? [{ type: "text", text, citations: null }] : [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Message;
}

function abortError(): Error {
  const err = new Error("Stopped.");
  err.name = "AbortError";
  return err;
}

/**
 * The given environment, minus what belongs to a Claude Code session Telos itself may have
 * been started from (a terminal inside Claude Code): the brain is its own session, not that one.
 */
const PARENT_SESSION = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_TEE_SDK_STDOUT",
  "CLAUDE_PID",
];
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of PARENT_SESSION) delete out[k];
  return out;
}

/** Only what Telos itself puts on the command line (flags, paths, model names): nothing a shell would act on. */
export function safeArg(arg: string): string {
  return arg.replace(/["%^&|<>\r\n]/g, " ");
}

/**
 * Starts the command. On Windows `claude` is usually a .cmd shim, which only a shell can
 * run, so it goes through cmd.exe with every argument quoted (and no window flashing up).
 */
export function run(command: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): ChildProcess {
  if (process.platform === "win32") {
    const quote = (a: string) => (/^[\w\-.:\\/=@,]+$/.test(a) ? a : `"${safeArg(a)}"`);
    return spawn([command, ...args].map(quote).join(" "), [], { ...opts, shell: true, windowsHide: true, stdio: "pipe" });
  }
  return spawn(command, args, { ...opts, stdio: "pipe" });
}

/** Ends the run, including what the shell started on Windows. */
export function stopTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  } else {
    child.kill("SIGTERM");
  }
}

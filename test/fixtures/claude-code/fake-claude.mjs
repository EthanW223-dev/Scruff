#!/usr/bin/env node
// A stand-in for the `claude` command (Claude Code), for tests. It logs how it was called
// (FAKE_CLAUDE_LOG) and answers in Claude Code's stream-json shape; FAKE_CLAUDE_MODE picks
// what it does: ok, no-partial, login, wrapper, slow, stale-session, build-fails. Run with
// --plugin-dir (a Workshop build), it acts out a short build instead of a chat reply.
import fs from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    const env = { anthropicKey: process.env.ANTHROPIC_API_KEY ?? null, claudecode: process.env.CLAUDECODE ?? null };
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdin, cwd: process.cwd(), env }) + "\n");
  }
  if (mode === "wrapper") {
    console.log("  starting router...");
    console.log("* free stack: 4 models");
    console.error("error: unknown option '-p'");
    process.exit(1);
  }
  if (mode === "no-partial" && args.includes("--include-partial-messages")) {
    console.error("error: unknown option '--include-partial-messages'");
    process.exit(1);
  }
  if (mode === "stale-session" && args.includes("--resume")) {
    console.error(`No conversation found with session ID: ${args[args.indexOf("--resume") + 1]}`);
    process.exit(1);
  }
  const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
  const session = resumed ?? `sess-${process.pid}`;
  out({ type: "system", subtype: "init", session_id: session, mcp_servers: [{ name: "telos", status: "connected" }] });
  if (mode === "slow") {
    await new Promise((r) => setTimeout(r, 30_000));
    process.exit(0);
  }
  if (mode === "login") {
    out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", session_id: session });
    process.exit(1);
  }
  if (args.includes("--plugin-dir")) {
    // A Workshop build: a few steps, a word to the player, a summary.
    const pause = () => new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_STEP_MS ?? 20)));
    const steps = [
      { type: "tool_use", id: "t1", name: "Skill", input: { skill: "universal-modder:mod-any-game" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "um scan \"Test Game\"" } },
      { type: "text", text: "It's a Unity game with BepInEx: building a BepInEx plugin." },
      { type: "tool_use", id: "t3", name: "Write", input: { file_path: "/w/MissileLauncher/Plugin.cs", content: "..." } },
      { type: "tool_use", id: "t4", name: "Bash", input: { command: "dotnet build MissileLauncher -c Release" } },
      { type: "tool_use", id: "t5", name: "mcp__telos__look_at_screen", input: {} },
    ];
    for (const b of steps) {
      await pause();
      out({ type: "assistant", message: { content: [b] }, parent_tool_use_id: null, session_id: session });
    }
    if (mode === "build-fails") {
      out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["dotnet: command not found"], session_id: session });
      process.exit(1);
    }
    const summary = "Built MissileLauncher, a BepInEx plugin, into BepInEx/plugins. Start the game and press F8 to get the launcher.";
    out({ type: "assistant", message: { content: [{ type: "text", text: summary }] }, parent_tool_use_id: null, session_id: session });
    out({ type: "result", subtype: "success", is_error: false, result: summary, session_id: session });
    return;
  }
  const reply = `Hello from ${resumed ? "the same" : "a new"} session.`;
  if (args.includes("--include-partial-messages")) {
    for (const piece of reply.match(/.{1,6}/g)) {
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, parent_tool_use_id: null, session_id: session });
    }
  }
  // A subagent's chatter is never the reply.
  out({ type: "assistant", message: { content: [{ type: "text", text: "(subagent noise)" }] }, parent_tool_use_id: "toolu_sub", session_id: session });
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }] }, parent_tool_use_id: null, session_id: session });
  out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: session });
});

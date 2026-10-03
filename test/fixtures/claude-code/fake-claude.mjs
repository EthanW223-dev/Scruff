#!/usr/bin/env node
// A stand-in for the `claude` command (Claude Code), for tests. It logs how it was called
// (FAKE_CLAUDE_LOG) and answers in Claude Code's stream-json shape; FAKE_CLAUDE_MODE picks
// what it does: ok, no-partial, login, wrapper, slow, stale-session.
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/hub/agent.ts";
import { defineTool } from "../src/hub/tools.ts";
import { fakeModel, lastToolResult, lastUserText, text, toolUse, type Reply } from "./fake-model.ts";

function makeAgent(policy: Parameters<typeof fakeModel>[0], tools = [echo]) {
  const model = fakeModel(policy);
  const agent = new Agent({
    brain: { model: "claude-opus-5", createStream: model.factory },
    tools,
    status: () => ({ note: "status", events: [] }),
  });
  const events: AgentEvent[] = [];
  agent.on("event", (e) => events.push(e));
  const turn = () => new Promise<void>((resolve) => agent.once("event", function wait(e: AgentEvent) {
    if (e.type === "turn_end") resolve();
    else agent.once("event", wait);
  }));
  return { agent, model, events, turn };
}

const echo = defineTool({
  name: "echo",
  description: "Echo a number",
  input: z.object({ n: z.number() }),
  run: ({ n }) => `echo ${n}`,
});

test("invalid tool input comes back to Claude as an error instead of running", async () => {
  const { agent, model, events, turn } = makeAgent((p): Reply => {
    const last = lastToolResult(p);
    if (!last) return { content: [toolUse("echo", { n: "not a number" })] };
    return { content: [text(last.isError ? "retrying" : "ok")] };
  });
  const done = turn();
  agent.send("go");
  await done;
  const result = lastToolResult(model.calls.at(-1)!)!;
  assert.equal(result.isError, true);
  assert.match(result.result, /INVALID_JSON/);
  assert.ok(events.some((e) => e.type === "text" && e.text === "retrying"));
});

test("stop during a slow tool answers every tool call, keeping history valid", async () => {
  let release!: () => void;
  const slow = defineTool({
    name: "slow",
    description: "Takes a while",
    input: z.object({}),
    run: () => new Promise((r) => (release = () => r("finished"))),
  });
  const { agent, model, events, turn } = makeAgent(
    (p): Reply => (lastUserText(p) === "go" ? { content: [toolUse("slow", {}), toolUse("echo", { n: 1 })] } : { content: [text("after")] }),
    [slow, echo],
  );
  const done = turn();
  agent.send("go");
  while (!release) await new Promise((r) => setTimeout(r, 5));
  agent.stop();
  release();
  await done;
  assert.ok(events.some((e) => e.type === "notice" && e.text === "Stopped."));

  // The next message must follow a user turn that answers both tool calls.
  const next = turn();
  agent.send("hello again");
  await next;
  const msgs = model.calls.at(-1)!.messages;
  const results = msgs.at(-2)!.content as { type: string; tool_use_id: string; content: string }[];
  assert.deepEqual(results.map((r) => r.type), ["tool_result", "tool_result"]);
  assert.equal(results[1].content, "Cancelled by the user.");
});

test("a refusal drops the turn so it isn't replayed", async () => {
  let refuse = true;
  const { agent, model, events, turn } = makeAgent((): Reply => {
    if (refuse) return { content: [], stop_reason: "refusal" };
    return { content: [text("fine")] };
  });
  let done = turn();
  agent.send("something declined");
  await done;
  assert.ok(events.some((e) => e.type === "error"));
  refuse = false;
  done = turn();
  agent.send("something else");
  await done;
  const msgs = model.calls.at(-1)!.messages;
  assert.equal(msgs.length, 1);
  assert.match(JSON.stringify(msgs[0].content), /something else/);
  assert.match(JSON.stringify(msgs[0].content), /Scruff status/, "status note is re-sent after a rollback");
});

test("a tool call cut off by max_tokens is never run", async () => {
  let ran = false;
  const guarded = defineTool({
    name: "guarded",
    description: "",
    input: z.object({}),
    run: () => {
      ran = true;
      return "ran";
    },
  });
  const { agent, events, turn } = makeAgent(() => ({ content: [toolUse("guarded", {})], stop_reason: "max_tokens" }), [guarded]);
  const done = turn();
  agent.send("go");
  await done;
  assert.equal(ran, false);
  assert.ok(events.some((e) => e.type === "error"));
});

test("messages sent while busy are queued, not dropped", async () => {
  const { agent, events, turn } = makeAgent((p) => ({ content: [text(`re: ${lastUserText(p)}`)] }));
  const first = turn();
  agent.send("one");
  agent.send("two");
  await first;
  await turn();
  const replies = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text);
  assert.deepEqual(replies, ["re: one", "re: two"]);
});

test("unparseable tool JSON is retried; other SDK errors are reported, not retried", async () => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  let attempts = 0;
  const { agent, events, turn } = makeAgent(() => {
    attempts++;
    if (attempts === 1) throw new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model. JSON: {\"n\":");
    return { content: [text("recovered")] };
  });
  let done = turn();
  agent.send("go");
  await done;
  assert.equal(attempts, 2);
  assert.ok(events.some((e) => e.type === "text" && e.text === "recovered"));

  const noKey = makeAgent(() => {
    attempts++;
    throw new Anthropic.AnthropicError("Could not resolve authentication method. Expected one of apiKey...");
  });
  attempts = 0;
  done = noKey.turn();
  noKey.agent.send("go");
  await done;
  assert.equal(attempts, 1);
  const error = noKey.events.find((e) => e.type === "error") as { text: string };
  assert.match(error.text, /No Anthropic API key/);
});

test("New chat during a running tool leaves the fresh conversation clean", async () => {
  let release!: () => void;
  const slow = defineTool({
    name: "slow",
    description: "",
    input: z.object({}),
    run: () => new Promise((r) => (release = () => r("finished"))),
  });
  const { agent, model, turn } = makeAgent(
    (p): Reply => (lastUserText(p) === "go" ? { content: [toolUse("slow", {})] } : { content: [text("fresh")] }),
    [slow],
  );
  let done = turn();
  agent.send("go");
  while (!release) await new Promise((r) => setTimeout(r, 5));
  agent.reset();
  release();
  await done;
  done = turn();
  agent.send("hi");
  await done;
  const msgs = model.calls.at(-1)!.messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
});

test("an adapter tool called directly (unity__find) is routed through use_game_adapter", async () => {
  const seen: unknown[] = [];
  const useGameAdapter = defineTool({
    name: "use_game_adapter",
    description: "Call an adapter tool",
    input: z.looseObject({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
    run: (input) => {
      seen.push(input);
      return "found Ted";
    },
  });
  const { agent, model, turn } = makeAgent(
    (p): Reply => (lastToolResult(p) ? { content: [text("done")] } : { content: [toolUse("unity__find", { name: "Ted" })] }),
    [echo, useGameAdapter],
  );
  const done = turn();
  agent.send("find ted");
  await done;
  assert.deepEqual(seen, [{ tool: "unity__find", input: { name: "Ted" } }]);
  const result = lastToolResult(model.calls.at(-1)!)!;
  assert.equal(result.isError, false);
  assert.equal(result.result, "found Ted");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeStreamFactory } from "../src/hub/providers/anthropic.ts";
import { ThinkSplitter, toChatMessages } from "../src/hub/providers/openai.ts";

test("Claude history converts to chat-completions messages in a valid order", () => {
  const messages = toChatMessages(
    "be brief",
    [
      { role: "user", content: [{ type: "text", text: "[Telos status] ..." }, { type: "text", text: "give me gold" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "x" },
          { type: "text", text: "On it." },
          { type: "tool_use", id: "t1", name: "new_scan", input: { value: 350 } },
          { type: "tool_use", id: "t2", name: "look_at_screen", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: '{"count": 3}' },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] },
        ],
      },
    ],
    true,
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "tool", "user"],
    "tool results come straight after the tool calls; the screenshot follows as a user image",
  );
  assert.equal(messages[1].content, "[Telos status] ...\n\ngive me gold");
  const assistant = messages[2] as { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[] };
  assert.equal(assistant.content, "On it.", "thinking blocks are dropped");
  assert.deepEqual(assistant.tool_calls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]), [
    ["t1", "new_scan", { value: 350 }],
    ["t2", "look_at_screen", {}],
  ]);
  assert.deepEqual(messages[5].content, [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }]);
});

test("text-only models get a note instead of the screenshot", () => {
  const messages = toChatMessages("", [
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "look_at_screen", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] }] },
  ], false);
  assert.equal(messages.length, 2);
  assert.match(String(messages[1].content), /can't see images/);
});

test("<think> blocks are split out of streamed text, even across chunk boundaries", () => {
  const out: [string, string][] = [];
  const s = new ThinkSplitter();
  for (const chunk of ["<thi", "nk>plan it", "</th", "ink>Sure", "! <", "b>ok"]) s.push(chunk, (k, p) => p && out.push([k, p]));
  s.flush((k, p) => p && out.push([k, p]));
  const joined = (kind: string) => out.filter(([k]) => k === kind).map(([, p]) => p).join("");
  assert.equal(joined("thinking"), "plan it");
  assert.equal(joined("text"), "Sure! <b>ok");
});

test("Claude requests get thinking, effort and fallbacks only on models that support them", () => {
  const seen: any[] = [];
  const client = { beta: { messages: { stream: (params: unknown) => (seen.push(params), {}) } } } as any;
  const factory = claudeStreamFactory(client, "medium");
  const base = { max_tokens: 10, messages: [{ role: "user" as const, content: "hi" }] };
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) factory({ ...base, model }, new AbortController().signal);
  const [opus, sonnet, haiku] = seen;
  assert.deepEqual(opus.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(opus.fallbacks, "default");
  assert.deepEqual(opus.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(sonnet.output_config, { effort: "medium" });
  assert.equal(sonnet.fallbacks, undefined);
  assert.equal(haiku.thinking, undefined);
  assert.equal(haiku.output_config, undefined);
  for (const p of seen) assert.deepEqual(p.cache_control, { type: "ephemeral" });
});

test("never sends null content: Ollama answers 400 'invalid message content type: <nil>' and the chat is stuck", () => {
  const messages = toChatMessages("sys", [
    { role: "user", content: "give me max of everything" },
    // A thinking model that only thought, and stopped.
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "" }] },
    { role: "user", content: "hello?" },
    // Called a tool without saying anything.
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "game_status", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ] as never, false);
  for (const m of messages) assert.notEqual((m as { content?: unknown }).content, null, JSON.stringify(m));
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "user", "user", "assistant", "tool"],
    "the empty turn is left out",
  );
  assert.equal((messages[3] as { content: string }).content, "");
});

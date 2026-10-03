// A stand-in for the Anthropic Messages API, so the real Claude Code CLI can run in tests
// without a model: asked to "check the game", it calls Telos's game_status tool over MCP,
// then answers with what the tool said. Every request is logged for the test to inspect.
import http from "node:http";

export function startMockApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let json = {};
      try {
        json = JSON.parse(body || "{}");
      } catch {}
      requests.push({ method: req.method, url: req.url, body: json });
      if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(req.url.includes("count_tokens") ? { input_tokens: 10 } : {}));
      }
      const msgs = json.messages ?? [];
      const blocksOf = (m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []));
      // A tool result since the last assistant turn (Claude Code may add a context message after it).
      let lastAssistant = -1;
      msgs.forEach((m, i) => m.role === "assistant" && (lastAssistant = i));
      const toolResult = msgs.slice(lastAssistant + 1).flatMap(blocksOf).find((b) => b.type === "tool_result");
      // What the player asked: Claude Code adds its own context blocks around the prompt.
      const texts = msgs
        .filter((m) => m.role === "user")
        .flatMap((m) => blocksOf(m).filter((b) => b.type === "text").map((b) => b.text));
      const asked = texts.filter((t) => !t.startsWith("<") && !t.startsWith("#")).join(" ");
      const tool = (json.tools ?? []).find((t) => t.name === "mcp__telos__game_status");
      let content;
      if (toolResult) {
        const text = typeof toolResult.content === "string" ? toolResult.content : (toolResult.content ?? []).map((c) => c.text ?? "").join(" ");
        content = [{ type: "text", text: `Telos says: ${text.slice(0, 80)}` }];
      } else if (tool && /check the game/i.test(asked)) {
        content = [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_test_1", name: tool.name, input: {} },
        ];
      } else {
        content = [{ type: "text", text: `Echo: ${asked.slice(-60)}` }];
      }
      const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      const message = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: json.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (!json.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(message));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", { message: { ...message, content: [], stop_reason: null } });
      content.forEach((b, index) => {
        if (b.type === "text") {
          send("content_block_start", { index, content_block: { type: "text", text: "" } });
          for (const piece of b.text.match(/.{1,8}/gs) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        } else {
          send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
        }
        send("content_block_stop", { index });
      });
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
      send("message_stop", {});
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, requests })));
}

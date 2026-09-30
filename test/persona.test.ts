import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../src/hub/agent.ts";
import { ModelRouter } from "../src/hub/models.ts";
import { buildSystemPrompt, PERSONA_IDS, SYSTEM_PROMPT, type PersonaId } from "../src/hub/prompt.ts";
import { fakeModel, text, type Reply } from "./fake-model.ts";

function tmpSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-persona-"));
  return path.join(dir, "settings.json");
}

function makeAgent() {
  const model = fakeModel((_p): Reply => ({ content: [text("ok")] }));
  const agent = new Agent({
    brain: { model: "test-model", createStream: model.factory },
    tools: [],
    status: () => ({ note: "", events: [] }),
  });
  const turn = () =>
    new Promise<void>((resolve) =>
      agent.once("event", function wait(e) {
        if (e.type === "turn_end") resolve();
        else agent.once("event", wait);
      }),
    );
  return { agent, model, turn };
}

test("buildSystemPrompt(\"telos\") is the default Telos prompt", () => {
  assert.equal(buildSystemPrompt("telos"), SYSTEM_PROMPT);
  assert.match(SYSTEM_PROMPT, /You are Telos, a live game-modding sidekick/);
});

test("buildSystemPrompt(\"grim\") uses the Grim preamble and the same guide", () => {
  const grim = buildSystemPrompt("grim");
  assert.match(grim, /^You are Grim, Ethan's personal AI/);
  assert.match(grim, /brutally honest/);
  assert.match(grim, /Piglet Farm/);
  assert.ok(grim.includes("## What you can do"), "the modding guide is shared");
  assert.ok(!grim.includes("You are Telos, a live game-modding sidekick"), "no Telos preamble");
  for (const id of PERSONA_IDS) assert.ok(buildSystemPrompt(id as PersonaId).length > 0);
});

test("the agent sends the default Telos prompt when no system is given", async () => {
  const { agent, model, turn } = makeAgent();
  const done = turn();
  agent.send("hi");
  await done;
  assert.equal(model.calls.at(-1)!.system, SYSTEM_PROMPT);
});

test("setSystem changes the prompt without rebuilding the agent", async () => {
  const { agent, model, turn } = makeAgent();
  agent.setSystem(buildSystemPrompt("grim"));
  const done = turn();
  agent.send("hi");
  await done;
  const system = model.calls.at(-1)!.system as string;
  assert.match(system, /^You are Grim/);
  // The conversation kept going: the turn still completed.
  assert.equal(agent.busy, false);
});

test("the router defaults to the telos persona", () => {
  const router = new ModelRouter({}, tmpSettings(), "medium");
  assert.equal(router.persona, "telos");
  assert.match(String(router.describe().persona), /^telos$/);
});

test("setPersona validates, persists, and reloads across instances", async () => {
  const settings = tmpSettings();
  const router = new ModelRouter({}, settings, "medium");
  await router.init({});
  assert.throws(() => router.setPersona("clippy"), /Unknown persona/);
  router.setPersona("grim");
  assert.equal(router.persona, "grim");
  assert.equal(router.describe().persona, "grim");
  const saved = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(saved.persona, "grim");

  const again = new ModelRouter({}, settings, "medium");
  await again.init({});
  assert.equal(again.persona, "grim");
  again.setPersona("telos");
  const third = new ModelRouter({}, settings, "medium");
  await third.init({});
  assert.equal(third.persona, "telos");
});

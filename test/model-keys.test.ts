import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelRouter } from "../src/hub/models.ts";

function tmpSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-keys-"));
  return path.join(dir, "settings.json");
}

test("setProviderKey rejects providers that don't use keys", async () => {
  const router = new ModelRouter({}, tmpSettings(), "medium");
  await assert.rejects(router.setProviderKey("ollama", "x"), /doesn't use an API key/);
});

test("setProviderKey rejects garbage before touching the network", async () => {
  const router = new ModelRouter({}, tmpSettings(), "medium");
  await assert.rejects(router.setProviderKey("claude", "  short  "), /doesn't look like an API key/);
});

test("forgetting a key removes keys.json and marks the provider unusable", async () => {
  const settings = tmpSettings();
  const keysFile = path.join(path.dirname(settings), "keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ claude: "sk-ant-test-fakekey123" }));
  const router = new ModelRouter({}, settings, "medium");
  assert.equal(router.describe().ready, true);
  await router.setProviderKey("claude", null);
  assert.equal(fs.existsSync(keysFile), false);
  assert.equal(router.describe().ready, false);
  assert.match(router.describe().problem ?? "", /No API key/);
});

test("a saved key in keys.json makes claude ready without env", () => {
  const settings = tmpSettings();
  fs.writeFileSync(path.join(path.dirname(settings), "keys.json"), JSON.stringify({ claude: "sk-ant-test-fakekey123" }));
  const router = new ModelRouter({}, settings, "medium");
  const d = router.describe();
  assert.equal(d.provider, "claude");
  assert.equal(d.ready, true);
});

test("without any key, claude reports a friendly problem", () => {
  const router = new ModelRouter({}, tmpSettings(), "medium");
  const d = router.describe();
  assert.equal(d.ready, false);
  assert.match(d.problem ?? "", /No API key/);
});

test("every cloud provider accepts a key id and forgets it without network", async () => {
  const settings = tmpSettings();
  fs.writeFileSync(
    path.join(path.dirname(settings), "keys.json"),
    JSON.stringify({ openrouter: "sk-or-test-key-12345", groq: "gsk_test_key_12345", deepseek: "sk-test-key-12345", mistral: "mistral-test-key-12", gemini: "AIza-test-key-1234567", xai: "xai-test-key-123456789" }),
  );
  const router = new ModelRouter({}, settings, "medium");
  // Forgetting never validates, so this touches no network.
  for (const id of ["openrouter", "groq", "deepseek", "mistral", "gemini", "xai"]) {
    await router.setProviderKey(id, null);
  }
  const keysFile = path.join(path.dirname(settings), "keys.json");
  const raw = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
  assert.equal(raw.openrouter, undefined);
  assert.equal(raw.groq, undefined);
});

test("an env key makes its provider ready without network", () => {
  const router = new ModelRouter({ OPENROUTER_API_KEY: "sk-test-key-12345" }, tmpSettings(), "medium");
  router.select({ provider: "openrouter", model: "moonshotai/kimi-k2" });
  const d = router.describe();
  assert.equal(d.ready, true);
  assert.equal(d.providerLabel, "OpenRouter");
});

test("custom server URL round-trips through keys.json without network", async () => {
  const settings = tmpSettings();
  const router = new ModelRouter({}, settings, "medium");
  // No key: nothing to validate, so this touches no network.
  await router.setProviderKey("custom", null, "https://my-server:8000/v1");
  const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(settings), "keys.json"), "utf8"));
  assert.equal(raw._customBaseURL, "https://my-server:8000/v1");
  const r2 = new ModelRouter({}, settings, "medium");
  r2.select({ provider: "custom", model: "my-model" });
  const d = r2.describe();
  assert.equal(d.ready, true);
  assert.equal(d.providerLabel, "my-server");
});

test("custom server rejects a garbage URL before touching the network", async () => {
  const router = new ModelRouter({}, tmpSettings(), "medium");
  await assert.rejects(router.setProviderKey("custom", null, "not a url"), /server URL/);
});

test("the old OPENAI_BASE_URL env still lands on the custom provider", () => {
  const router = new ModelRouter({ OPENAI_BASE_URL: "http://localhost:9999/v1" }, tmpSettings(), "medium");
  router.select({ provider: "custom", model: "local-model" });
  const d = router.describe();
  assert.equal(d.ready, true);
  assert.equal(d.providerLabel, "Local server");
});

test("setProviderKey still rejects unknown provider ids", async () => {
  const router = new ModelRouter({}, tmpSettings(), "medium");
  await assert.rejects(router.setProviderKey("nope", "some-key-value"), /doesn't use an API key/);
});

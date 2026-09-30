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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelRouter } from "../src/hub/models.ts";
import {
  DEFAULT_VOICE,
  defaultVoiceFor,
  isVoiceFor,
  probeVoiceEngineNow,
  sanitizeVoiceText,
  synthesizeVoice,
  voicesFor,
  VOICE_ALLOWLIST,
  voiceCacheKey,
  voiceEngineReady,
} from "../src/hub/voice.ts";

function tmpSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-voice-"));
  return path.join(dir, "settings.json");
}

test("the sanitizer strips markdown so the voice doesn't read it aloud", () => {
  assert.equal(sanitizeVoiceText("**Done!** Set `gold` to `99`."), "Done! Set gold to 99.");
  assert.equal(sanitizeVoiceText("# Heading\n\nSome _italic_ text"), "Heading Some italic text");
  assert.equal(sanitizeVoiceText("See [the wiki](https://example.com) for details"), "See the wiki for details");
  assert.equal(sanitizeVoiceText("Wrote to 0x1A2B3C4D in memory"), "Wrote to that address in memory");
});

test("the sanitizer collapses whitespace and caps length", () => {
  assert.equal(sanitizeVoiceText("  too\n\n   much   \t space  "), "too much space");
  assert.equal(sanitizeVoiceText("x".repeat(1000)).length, 600);
  assert.equal(sanitizeVoiceText("   "), "");
});

test("cache keys are stable and differ by voice", () => {
  assert.equal(voiceCacheKey("hi", "en-US-AriaNeural"), voiceCacheKey("hi", "en-US-AriaNeural"));
  assert.notEqual(voiceCacheKey("hi", "en-US-AriaNeural"), voiceCacheKey("hi", "en-US-JennyNeural"));
  assert.notEqual(voiceCacheKey("hi", "en-US-AriaNeural"), voiceCacheKey("bye", "en-US-AriaNeural"));
});

test("a cached mp3 is served without touching python", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-voice-cache-"));
  const text = "cached reply";
  const file = path.join(cacheDir, `${voiceCacheKey(text, DEFAULT_VOICE)}.mp3`);
  fs.writeFileSync(file, Buffer.from("fake-mp3"));
  const { file: got, cached, mime } = await synthesizeVoice({ text, voice: DEFAULT_VOICE, engine: "edge", cacheDir });
  assert.equal(got, file);
  assert.equal(cached, true);
  assert.equal(mime, "audio/mpeg");
});

test("a cached kokoro wav is served without spawning the daemon", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "scruff-voice-cache-"));
  const text = "cached kokoro reply";
  const file = path.join(cacheDir, `${voiceCacheKey(text, "kokoro:af_heart")}.wav`);
  fs.writeFileSync(file, Buffer.from("fake-wav"));
  const { file: got, cached, mime } = await synthesizeVoice({ text, voice: "af_heart", engine: "kokoro", cacheDir });
  assert.equal(got, file);
  assert.equal(cached, true);
  assert.equal(mime, "audio/wav");
});

test("engine voice helpers route voices to the right engine", () => {
  assert.ok(voicesFor("edge").includes("en-US-AndrewNeural"));
  assert.ok(voicesFor("kokoro").includes("af_heart"));
  assert.ok(!voicesFor("edge").includes("af_heart"));
  assert.ok(!voicesFor("kokoro").includes("en-US-AndrewNeural"));
  assert.equal(defaultVoiceFor("edge"), DEFAULT_VOICE);
  assert.equal(defaultVoiceFor("kokoro"), "af_heart");
  assert.ok(isVoiceFor("kokoro", "af_heart"));
  assert.ok(!isVoiceFor("kokoro", "en-US-AndrewNeural"));
});

test("the router defaults to Andrew with voice off, and setVoice validates engine + voice and persists", async () => {
  const settings = tmpSettings();
  const router = new ModelRouter({}, settings, "medium");
  await router.init({});
  assert.equal(router.voice, DEFAULT_VOICE);
  assert.equal(router.voiceEngine, "edge");
  assert.equal(router.voiceEnabled, false);

  assert.throws(() => router.setVoice("en-US-NotARealVoice", true), /Unknown voice/);
  assert.throws(() => router.setVoice("af_heart", true, "edge"), /Unknown voice/);
  assert.throws(() => router.setVoice("en-US-AndrewNeural", true, "kokoro"), /Unknown voice/);
  router.setVoice("af_heart", true, "kokoro");
  assert.equal(router.voice, "af_heart");
  assert.equal(router.voiceEngine, "kokoro");
  assert.equal(router.voiceEnabled, true);
  const d = router.describe();
  assert.equal(d.voice, "af_heart");
  assert.equal(d.voiceEngine, "kokoro");
  assert.equal(d.voiceEnabled, true);
  assert.equal(typeof d.voiceEngines.edge, "boolean");
  assert.equal(typeof d.voiceEngines.kokoro, "boolean");
  const saved = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(saved.voice, "af_heart");
  assert.equal(saved.voiceEngine, "kokoro");
  assert.equal(saved.voiceEnabled, true);

  const again = new ModelRouter({}, settings, "medium");
  await again.init({});
  assert.equal(again.voice, "af_heart");
  assert.equal(again.voiceEngine, "kokoro");
  assert.equal(again.voiceEnabled, true);
});

test("a voice saved under a retired list falls back to the engine default", async () => {
  const settings = tmpSettings();
  fs.writeFileSync(settings, JSON.stringify({ provider: "claude", model: "x", voice: "en-US-JennyNeural", voiceEnabled: true }));
  const router = new ModelRouter({}, settings, "medium");
  await router.init({});
  assert.equal(router.voice, DEFAULT_VOICE);
  assert.equal(router.voiceEngine, "edge");
});

test("every allowlisted voice is a plausible neural voice id", () => {
  assert.ok(VOICE_ALLOWLIST.length >= 4);
  for (const v of VOICE_ALLOWLIST) assert.match(v, /^[a-z]{2}-[A-Z]{2}-.+Neural$/);
});

test("describe() reports the voice engine status so the dashboard can warn when edge-tts is missing", async () => {
  const settings = tmpSettings();
  const router = new ModelRouter({}, settings, "medium");
  await router.init({});
  assert.equal(typeof router.describe().voiceReady, "boolean");
});

test("probeVoiceEngineNow() settles the engine state so the first hello is honest", async () => {
  const ready = await probeVoiceEngineNow();
  assert.equal(typeof ready, "boolean");
  // After an awaited probe the sync read is deterministic, never "not yet probed".
  assert.equal(voiceEngineReady(), ready);
  // A second call inside the TTL reuses the cached result.
  assert.equal(await probeVoiceEngineNow(), ready);
});

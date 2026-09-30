import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: dashboard JS is untyped; the runtime import works fine.
import { fallbackLabel, resolveDeviceId, shouldSpeakReply } from "../dashboard/audio.js";

test("fallbackLabel numbers microphones and speakers from 1", () => {
  assert.equal(fallbackLabel("audioinput", 0), "Microphone 1");
  assert.equal(fallbackLabel("audioinput", 2), "Microphone 3");
  assert.equal(fallbackLabel("audiooutput", 1), "Speaker 2");
});

test("resolveDeviceId keeps the saved device when it's still plugged in", () => {
  const devices = [{ deviceId: "a" }, { deviceId: "b" }];
  assert.equal(resolveDeviceId(devices, "b"), "b");
});

test("resolveDeviceId falls back to the first device when the saved one vanished", () => {
  const devices = [{ deviceId: "a" }, { deviceId: "b" }];
  assert.equal(resolveDeviceId(devices, "gone"), "a");
  assert.equal(resolveDeviceId(devices, ""), "a");
});

test("resolveDeviceId returns empty when no devices are listed", () => {
  assert.equal(resolveDeviceId([], "a"), "");
});

test("shouldSpeakReply needs the voice on, the box checked, and a real reply", () => {
  const base = { replay: false, voiceEnabled: true, speakChecked: true, overlayMode: false, text: "Done." };
  assert.equal(shouldSpeakReply(base), true);
  assert.equal(shouldSpeakReply({ ...base, replay: true }), false);
  assert.equal(shouldSpeakReply({ ...base, voiceEnabled: false }), false);
  assert.equal(shouldSpeakReply({ ...base, speakChecked: false }), false);
  assert.equal(shouldSpeakReply({ ...base, text: "   " }), false);
  // The in-game overlay owns playback: a browser tab must never double-play.
  assert.equal(shouldSpeakReply({ ...base, overlayMode: true }), false);
});

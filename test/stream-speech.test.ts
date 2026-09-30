import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore - dashboard JS lives outside the typechecked tree
import { SpeechStreamer } from "../dashboard/audio.js";

function streaming(sentences: string[]): { st: any; out: string[] } {
  const out: string[] = [];
  const st: any = new SpeechStreamer({ makeUrl: (s: string) => s });
  st.enqueue = (s: string) => {
    out.push(s);
  };
  st.start();
  for (const s of sentences) st.push(s);
  return { st, out };
}

test("sentences are emitted as they complete, in order", () => {
  const { out } = streaming(["Hello there. This is great! Really? ", "Yes."]);
  assert.deepEqual(out, ["Hello there.", "This is great!", "Really?"]);
});

test("a sentence split across deltas is emitted whole", () => {
  const { st, out } = streaming(["Hel", "lo the", "re. Next one."]);
  st.finish();
  assert.deepEqual(out, ["Hello there.", "Next one."]);
});

test("finish() flushes the trailing partial sentence", () => {
  const { st, out } = streaming(["First. Trailing"]);
  assert.deepEqual(out, ["First."]);
  st.finish();
  assert.deepEqual(out, ["First.", "Trailing"]);
});

test("code fences are never spoken", () => {
  const { st, out } = streaming(["Run this: ```js const x = 1; ``` Got it. Spoken."]);
  st.finish();
  assert.deepEqual(out, ["Run this:", "Got it.", "Spoken."]);
  assert.ok(!out.some((s) => s.includes("const x")));
});

test("an unclosed fence swallows the rest until it closes", () => {
  const { st, out } = streaming(["Say this. ```python x = 1"]);
  assert.deepEqual(out, ["Say this."]);
  const { out: out2 } = streaming([]);
  void out2;
  st.push("more code ``` and then spoken. ");
  st.finish();
  assert.deepEqual(out, ["Say this.", "and then spoken."]);
});

test("stop() cancels the queue and marks the streamer inactive", () => {
  const { st, out } = streaming(["One. Two. "]);
  assert.deepEqual(out, ["One.", "Two."]);
  st.stop();
  assert.equal(st.speaking, false);
  st.push("Three. ");
  st.finish();
  assert.deepEqual(out, ["One.", "Two."]);
});

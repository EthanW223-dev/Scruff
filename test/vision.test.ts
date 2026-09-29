import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brain } from "../src/hub/agent.ts";
import { ImageNotSupportedError } from "../src/hub/providers/openai.ts";
import {
  askVision,
  confirmQuestion,
  hudQuestion,
  parseConfirm,
  parseNumber,
  VisionError,
  visionFromBrain,
} from "../src/hub/vision.ts";

// ---------- parsing ----------

test("parseNumber pulls the first number out of a reply", () => {
  assert.equal(parseNumber("12"), 12);
  assert.equal(parseNumber("The soup count shows 4.75 cans."), 4.75);
  assert.equal(parseNumber("1,500"), 1500);
  assert.equal(parseNumber("not visible"), null);
  assert.equal(parseNumber("I can't see the counter right now."), null);
  assert.equal(parseNumber("no idea"), null);
});

test("parseConfirm compares against the expected number, tolerating wording", () => {
  assert.equal(parseConfirm("It shows 99.", 99), "yes");
  assert.equal(parseConfirm("99", 99), "yes");
  assert.equal(parseConfirm("It shows 11.", 99), "no");
  assert.equal(parseConfirm("No, it shows 11.", 99), "no");
  assert.equal(parseConfirm("not visible", 99), "unknown");
  assert.equal(parseConfirm("I can't see the counter.", 99), "unknown");
  assert.equal(parseConfirm("yes", 99), "yes");
  assert.equal(parseConfirm("no", 99), "no");
  assert.equal(parseConfirm("maybe?", 99), "unknown");
});

test("the questions name the value and ask for just the number", () => {
  assert.match(hudQuestion("soup cans", "60 Seconds!"), /soup cans/);
  assert.match(hudQuestion("soup cans", "60 Seconds!"), /not visible/);
  assert.match(confirmQuestion("soup cans", "99"), /99/);
  assert.match(confirmQuestion("soup cans", "99"), /not visible/);
});

// ---------- askVision ----------

function fakeBrain(reply: string | Error, check?: (params: any) => void): Brain {
  const createStream = (params: any) => {
    check?.(params);
    return {
      on: () => {},
      finalMessage: async () => {
        if (reply instanceof Error) throw reply;
        return { content: reply ? [{ type: "text", text: reply, citations: null }] : [] };
      },
    };
  };
  return { model: "fake-vision", createStream: createStream as unknown as Brain["createStream"] };
}

test("askVision sends the screenshot with strictVision and returns the text", async () => {
  let seen: any;
  const brain = fakeBrain("12", (p) => (seen = p));
  const answer = await askVision(brain, "jpeg-bytes", "what number?", new AbortController().signal);
  assert.equal(answer, "12");
  assert.equal(seen.strictVision, true);
  const image = seen.messages[0].content.find((b: any) => b.type === "image");
  assert.equal(image.source.data, "jpeg-bytes");
});

test("askVision turns a blind model into a no-vision error", async () => {
  const brain = fakeBrain(new ImageNotSupportedError("nope"));
  await assert.rejects(askVision(brain, "jpeg", "q?", new AbortController().signal), (err) => {
    assert.ok(err instanceof VisionError && err.code === "no-vision");
    return true;
  });
});

test("askVision fails when the model says nothing", async () => {
  const brain = fakeBrain("");
  await assert.rejects(askVision(brain, "jpeg", "q?", new AbortController().signal), VisionError);
});

test("visionFromBrain builds a fresh client per call", async () => {
  let brains = 0;
  const vc = visionFromBrain(() => {
    brains++;
    return fakeBrain("7");
  });
  assert.equal(await vc.ask("jpeg", "q?", new AbortController().signal), "7");
  assert.equal(await vc.ask("jpeg", "q?", new AbortController().signal), "7");
  assert.equal(brains, 2);
});

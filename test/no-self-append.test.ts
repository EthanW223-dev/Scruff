import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

// Regression test: `inner.append(inner)` in the voice accordion (2026-09-30)
// appended an element to itself, which throws HierarchyRequestError in a real
// browser. renderVoiceSection() runs before the provider grid in renderModels,
// so the one typo left the whole AI menu stuck on "Probing providers…" forever.
// The real DOM throws on self-append; a stub that silently accepts it would
// hide the bug, so this scans the shipped source instead.
const SELF_APPEND = /\b([A-Za-z_$][\w$]*)\.append(?:Child)?\(\s*\1\s*[,)]/g;

for (const file of ["dashboard/app.js", "dashboard/overlay.js"]) {
  test(`${file}: no element is ever appended to itself`, () => {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const hits = [...src.matchAll(SELF_APPEND)].map((m) => `${m[1]} at index ${m.index}`);
    assert.deepEqual(hits, [], `self-append throws HierarchyRequestError in the browser: ${hits.join(", ")}`);
  });
}

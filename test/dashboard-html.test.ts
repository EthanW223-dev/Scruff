import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// The dashboard page is hand-written HTML. A stray end tag doesn't fail anywhere: the browser
// quietly closes the panel early, and what followed it (the hotkey strip) then showed over the
// game all the time, covering the tray. So: every tag closes in order, and the parts that
// must sit inside the panel or the tray do.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea"]);

interface Node {
  tag: string;
  id?: string;
  cls: string[];
  parent?: Node;
}

function parse(html: string): Node[] {
  const src = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "");
  const root: Node = { tag: "#root", cls: [] };
  const stack: Node[] = [root];
  const all: Node[] = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [, closing, rawTag, attrs, selfClosing] = m;
    const tag = rawTag.toLowerCase();
    const line = src.slice(0, m.index).split("\n").length;
    if (closing) {
      const open = stack.at(-1)!;
      assert.equal(open.tag, tag, `</${tag}> on line ${line} closes <${open.tag}${open.id ? `#${open.id}` : ""}>`);
      stack.pop();
      continue;
    }
    const attr = (name: string) => attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1];
    const node: Node = { tag, id: attr("id"), cls: (attr("class") ?? "").split(/\s+/).filter(Boolean), parent: stack.at(-1) };
    all.push(node);
    if (VOID.has(tag) || selfClosing) continue;
    if (RAW.has(tag)) {
      const end = src.indexOf(`</${tag}`, re.lastIndex);
      assert.ok(end >= 0, `<${tag}> on line ${line} never closes`);
      re.lastIndex = src.indexOf(">", end) + 1;
      continue;
    }
    stack.push(node);
  }
  assert.deepEqual(
    stack.slice(1).map((n) => n.tag + (n.id ? `#${n.id}` : "")),
    [],
    "every tag is closed",
  );
  return all;
}

const inside = (node: Node, ancestorId: string) => {
  for (let p = node.parent; p; p = p.parent) if (p.id === ancestorId) return true;
  return false;
};

test("the dashboard page's tags all close in order, and its parts sit where they belong", () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "index.html"), "utf8");
  const nodes = parse(html);
  const byId = (id: string) => nodes.find((n) => n.id === id) ?? assert.fail(`#${id} is missing`);
  const dock = nodes.find((n) => n.tag === "footer" && n.cls.includes("dock")) ?? assert.fail("the hotkey strip is missing");
  assert.ok(inside(dock, "app"), "the hotkey strip is part of the panel (hidden with it in the overlay)");
  for (const id of ["hud-button", "hud-build", "hud-reply", "hud-buildview"]) assert.ok(inside(byId(id), "hud-unit"), `#${id} is in the tray`);
  for (const id of ["chat-panel", "market-panel", "input"].filter((id) => nodes.some((n) => n.id === id))) {
    assert.ok(inside(byId(id), "app"), `#${id} is in the panel`);
  }
  for (const id of ["build-dialog", "market-dialog", "ai-dialog"]) {
    const d = byId(id);
    assert.ok(!inside(d, "app") && !inside(d, "hud"), `#${id} is a page-level dialog`);
  }
});

test("the check catches a stray end tag", () => {
  assert.throws(() => parse('<div id="app"><main><aside><div></div></div></aside></main><footer class="dock"></footer></div>'), /<\/div> on line 1 closes <aside>/);
  assert.throws(() => parse("<div><span></div>"), /closes <span>/);
  assert.throws(() => parse("<div><p>"), /every tag is closed/);
  assert.doesNotThrow(() => parse('<div><input type="text"><br/><script>if (a < b) document.write("</div>")</script></div>'));
});

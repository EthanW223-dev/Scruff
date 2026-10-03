#!/usr/bin/env node
// Refreshes Telos's bundled copy of universal-modder (https://github.com/rehan-remade/universal-modder,
// MIT): its skills, engine playbooks, knowledge base of field notes and the `um` CLI. Telos's
// modding_guide tool reads the playbooks and notes; the Workshop loads the whole thing into
// Claude Code as a plugin.
//
//   npm run update:modder              # the latest from GitHub
//   npm run update:modder -- <folder>  # from a local clone instead

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/rehan-remade/universal-modder";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "vendor", "universal-modder");

/** What Telos needs: the plugin itself (manifest, hooks, MCP config, skills, CLI) and the knowledge base. Not the example mods. */
const KEEP = [
  "LICENSE",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "pyproject.toml",
  "plugin.json",
  ".claude-plugin",
  ".mcp.json",
  "hooks",
  "skills",
  "knowledge",
  "um",
  "bin",
];

let src = process.argv[2];
let tmp = null;
if (!src) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "universal-modder-"));
  src = path.join(tmp, "repo");
  console.log(`Fetching ${REPO}…`);
  execFileSync("git", ["clone", "--depth", "1", REPO, src], { stdio: "inherit" });
}
const commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const item of KEEP) {
  const from = path.join(src, item);
  if (!fs.existsSync(from)) {
    console.warn(`  (not in this version: ${item})`);
    continue;
  }
  fs.cpSync(from, path.join(dest, item), { recursive: true, dereference: true });
}
fs.writeFileSync(
  path.join(dest, "VENDORED.md"),
  `# universal-modder, bundled with Telos

This folder is a copy of [universal-modder](${REPO}) by Rehan and contributors, under its MIT
license (see LICENSE). Telos ships it so that:

- every AI in Telos can read its engine playbooks and field notes (the \`modding_guide\` tool);
- the Workshop can load it into Claude Code as a plugin to build real mods.

Source: ${REPO}/tree/${commit}
Copied: ${new Date().toISOString().slice(0, 10)}
Included: ${KEEP.join(", ")} (not the example mods or media).

Update it with \`npm run update:modder\`. Don't edit files here: changes belong upstream.
`,
);
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`universal-modder ${commit.slice(0, 7)} → vendor/universal-modder`);

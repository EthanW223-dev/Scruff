# universal-modder, bundled with Telos

This folder is a copy of [universal-modder](https://github.com/rehan-remade/universal-modder) by Rehan and contributors, under its MIT
license (see LICENSE). Telos ships it so that:

- every AI in Telos can read its engine playbooks and field notes (the `modding_guide` tool);
- the Workshop can load it into Claude Code as a plugin to build real mods.

Source: https://github.com/rehan-remade/universal-modder/tree/15d6f9d5fbd32de9b1884f29ddec3be9133bd912
Copied: 2026-10-03
Included: LICENSE, README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, pyproject.toml, plugin.json, .claude-plugin, .mcp.json, hooks, skills, knowledge, um, bin (not the example mods or media).

Update it with `npm run update:modder`. Don't edit files here: changes belong upstream.

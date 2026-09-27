import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readFields, scanTypeFor, type FieldInfo } from "../games/dotnet.ts";
import { allowedRoots, isInside, type GameProfile } from "../games/profile.ts";
import type { GameManager } from "./game.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * Tools that read the attached game's files: its code (variable names and types), its saves
 * and settings. Edits are limited to text save/settings files, backed up and undoable.
 */

const TEXT_EXT = /\.(json|ini|cfg|conf|txt|xml|yaml|yml|csv|lua|properties|sav|save)$/i;
const MAX_READ = 40_000;
const MAX_FILES = 150;

function looksText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return false;
  let odd = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) odd++;
  return odd < sample.length * 0.02;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, out);
    else out.push(full);
  }
}

/** IL2CPP keeps names in global-metadata.dat as plain strings; no types, but still telling. */
function identifierStrings(buf: Buffer): string[] {
  const out = new Set<string>();
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const ok = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 60 || b === 62 || b === 46;
    if (ok) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && b === 0 && i - start >= 3 && i - start <= 80) out.add(buf.toString("latin1", start, i));
      start = -1;
    }
  }
  return [...out];
}

export function gameFileTools(games: GameManager, backupDir: string): HubTool[] {
  let codeFor: string | null = null;
  let fields: FieldInfo[] = [];
  let names: string[] = [];

  const profile = (): GameProfile => {
    if (!games.profile) {
      throw new Error(
        games.session ? "Scruff couldn't find this game's files (it didn't report where it's installed)." : "Not attached to a game.",
      );
    }
    return games.profile;
  };

  const loadCode = (p: GameProfile) => {
    if (codeFor === p.exe) return;
    codeFor = p.exe;
    fields = [];
    names = [];
    for (const file of p.codeFiles) {
      try {
        const buf = fs.readFileSync(file);
        if (p.codeKind === "dotnet") fields.push(...readFields(buf));
        else names.push(...identifierStrings(buf));
      } catch {
        // obfuscated or unreadable: skip that file
      }
    }
  };

  const checkPath = (file: string) => {
    const p = profile();
    const resolved = path.resolve(p.installDir, file);
    if (!isInside(resolved, allowedRoots(p))) {
      throw new Error("That file is outside the game's install, save and settings folders.");
    }
    return resolved;
  };

  return [
    defineTool({
      name: "game_info",
      readOnly: true,
      description:
        "What Scruff found in the attached game's files: engine, install folder, where saves and settings live, " +
        "and whether its code can be searched. Check this after attaching.",
      input: z.object({}),
      run() {
        const p = profile();
        return json({
          name: p.name,
          engine: p.engine,
          install_dir: p.installDir,
          code: p.codeKind === "dotnet" ? "readable: names and types (search_game_code)" : p.codeKind === "il2cpp" ? "names only (search_game_code)" : "not readable",
          save_dirs: p.saveDirs,
          config_files: p.configFiles.slice(0, 20),
          notes: p.notes,
        });
      },
    }),

    defineTool({
      name: "search_game_code",
      readOnly: true,
      description:
        "Search the game's own variable names (Unity games) for a word, e.g. 'soup' or 'ammo'. Results show the " +
        "class, the variable and how it's stored (float, int...), which tells find_value what type to search and " +
        "hints at how the game works (e.g. soup stored as a float count of cans).",
      input: z.object({ query: z.string().min(2).describe("One or more words, e.g. 'soup' or 'max health'") }),
      run({ query }) {
        const p = profile();
        if (!p.codeKind) return `${p.engine} games don't expose readable code; use find_value on memory instead.`;
        loadCode(p);
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (p.codeKind === "dotnet") {
          const hits = fields
            .filter((f) => !f.isConst)
            .filter((f) => words.every((w) => `${f.type}.${f.name}`.toLowerCase().includes(w)))
            .slice(0, 40)
            .map((f) => ({
              field: `${f.type}.${f.name}`,
              type: f.valueType,
              scan_as: scanTypeFor(f.valueType) ?? undefined,
              static: f.isStatic || undefined,
            }));
          return hits.length ? json({ matches: hits, total_fields: fields.length }) : `No variables mention "${query}" (${fields.length} searched). Try a synonym (food, ration, supplies...).`;
        }
        const hits = names.filter((n) => words.every((w) => n.toLowerCase().includes(w))).slice(0, 60);
        return hits.length ? json({ names: hits }) : `No names mention "${query}". Try a synonym.`;
      },
    }),

    defineTool({
      name: "list_game_files",
      readOnly: true,
      description: "List the game's save files, settings files or install folder, with sizes and dates.",
      input: z.object({
        where: z.enum(["saves", "settings", "install"]).default("saves"),
        filter: z.string().optional().describe("Only files whose name contains this"),
      }),
      run({ where, filter }) {
        const p = profile();
        const files: string[] = [];
        if (where === "saves") for (const d of p.saveDirs) walk(d, 3, files);
        else if (where === "settings") files.push(...p.configFiles);
        else walk(p.installDir, 1, files);
        const rows = files
          .filter((f) => !filter || path.basename(f).toLowerCase().includes(filter.toLowerCase()))
          .slice(0, MAX_FILES)
          .map((f) => {
            try {
              const st = fs.statSync(f);
              return { path: f, bytes: st.size, modified: st.mtime.toISOString().slice(0, 16).replace("T", " ") };
            } catch {
              return { path: f };
            }
          });
        return rows.length ? json(rows) : where === "saves" && !p.saveDirs.length ? "No save folder found for this game." : "No files found.";
      },
    }),

    defineTool({
      name: "read_game_file",
      readOnly: true,
      description:
        "Read one of the game's save, settings or data files. Text comes back as text (first 40 KB); binary files " +
        "come back as a hex preview plus readable strings.",
      input: z.object({ path: z.string().describe("Full path from list_game_files or game_info") }),
      run({ path: file }) {
        const resolved = checkPath(file);
        const buf = fs.readFileSync(resolved);
        if (looksText(buf)) {
          const text = buf.toString("utf8");
          return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n… (${text.length - MAX_READ} more characters)` : text;
        }
        const strings = (buf.toString("latin1").match(/[\x20-\x7e]{4,}/g) ?? []).slice(0, 80);
        return json({
          binary: true,
          bytes: buf.length,
          hex_preview: buf.subarray(0, 256).toString("hex").replace(/(.{32})/g, "$1\n").trim(),
          strings,
          note: "Binary files usually can't be edited safely; memory editing is the better route.",
        });
      },
    }),

    defineTool({
      name: "edit_game_file",
      description:
        "Edit a text save or settings file by replacing text (e.g. \"soup\": 4.75 → \"soup\": 99). The original is " +
        "backed up and the edit shows in the change list, so undo_change restores it. Games read saves when a save " +
        "is loaded: have the player save and quit to the menu first, then load the save after the edit.",
      input: z.object({
        path: z.string(),
        find: z.string().min(1).describe("Exact text to replace, copied from read_game_file"),
        replace: z.string(),
        replace_all: z.boolean().default(false),
        label: z.string().optional().describe("What this changes, e.g. 'Soup cans in save 1'"),
      }),
      run({ path: file, find, replace, replace_all, label }) {
        const session = games.requireSession();
        const p = profile();
        const resolved = checkPath(file);
        const buf = fs.readFileSync(resolved);
        if (!looksText(buf) && !TEXT_EXT.test(resolved)) throw new Error("Only text files can be edited.");
        if (!looksText(buf)) throw new Error("This file is binary; only text files can be edited.");
        const text = buf.toString("utf8");
        const count = text.split(find).length - 1;
        if (count === 0) throw new Error("That text isn't in the file. Copy it exactly from read_game_file.");
        const updated = replace_all ? text.split(find).join(replace) : text.replace(find, () => replace);
        const dir = path.join(backupDir, p.name.replace(/[^\w.-]+/g, "_"));
        fs.mkdirSync(dir, { recursive: true });
        const backup = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(resolved)}`);
        fs.copyFileSync(resolved, backup);
        fs.writeFileSync(resolved, updated);
        const change = session.recordFileEdit(label ?? path.basename(resolved), {
          path: resolved,
          backup,
          summary: `${replace_all ? count : 1} edit${replace_all && count > 1 ? "s" : ""} in ${path.basename(resolved)}`,
        });
        return (
          `Edited ${resolved} (${replace_all ? count : 1} replacement). Backup: ${backup}. change_id ${change.id}. ` +
          "The game picks this up when it loads the save/settings; confirm with the player before saying it worked."
        );
      },
    }),
  ];
}

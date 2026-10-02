import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { userDirs } from "../games/profile.ts";
import { defineTool, json, type HubTool } from "./tools.ts";

/**
 * Finding 3D models on the player's computer for the Unity bridge's load_model (merging games):
 * exports from FModel, AssetRipper or Blender usually land in Downloads, Desktop or Documents.
 * Names, sizes and paths only; the bridge reads the file itself.
 */

const EXTENSIONS = new Set([".glb", ".gltf", ".obj"]);
const MAX_DEPTH = 5;
const MAX_VISITED = 20_000;
/** Folders that are never model exports and are slow to walk. */
const SKIP = new Set(["node_modules", ".git", "AppData", "$RECYCLE.BIN", "Windows", "Program Files", "Program Files (x86)"]);

export interface FoundModel {
  path: string;
  name: string;
  kb: number;
  modified: string;
}

export function findModelFiles(roots: string[], query = "", limit = 30): FoundModel[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const found: (FoundModel & { at: number })[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > MAX_VISITED) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (!EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
      const hay = full.toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      try {
        const st = fs.statSync(full);
        found.push({ path: full, name: e.name, kb: Math.round(st.size / 1024), modified: st.mtime.toISOString().slice(0, 10), at: st.mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ at: _at, ...m }) => m);
}

export function modelFileTools(roots = defaultModelRoots()): HubTool[] {
  return [
    defineTool({
      name: "find_model_files",
      readOnly: true,
      description:
        "Find 3D model files (.glb, .gltf, .obj) on the player's computer, newest first: exports from FModel " +
        "(Unreal games), AssetRipper (Unity games) or Blender, for the Unity bridge's load_model. Searches Downloads, " +
        "Desktop and Documents.",
      input: z.object({
        query: z.string().optional().describe("Words in the file or folder name, e.g. 'zombie' or 'fmodel exports'"),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      run({ query, limit }) {
        const found = findModelFiles(roots, query ?? "", limit);
        if (found.length) return json(found);
        return (
          `No ${query ? `"${query}" ` : ""}models in ${roots.join(", ")}. Export one first: FModel (Unreal games) can save ` +
          "meshes as glTF, AssetRipper (Unity games) exports a game's models, and Blender turns most formats into .glb. " +
          "Or ask the player for the file's full path."
        );
      },
    }),
  ];
}

function defaultModelRoots(): string[] {
  const { home } = userDirs();
  return ["Downloads", "Desktop", "Documents", "Pictures/3D Objects", "3D Objects"].map((d) => path.join(home, d)).filter((d) => fs.existsSync(d));
}

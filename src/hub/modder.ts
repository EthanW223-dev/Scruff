import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GameProfile } from "../games/profile.ts";
import { defineTool, type HubTool } from "./tools.ts";

/**
 * universal-modder's know-how inside Telos: its engine playbooks (how each engine is modded:
 * loaders, routes, skeletons, pitfalls) and its knowledge base of field notes (how specific
 * games were actually modded, with exact versions and gotchas). Bundled under
 * vendor/universal-modder (MIT; `npm run update:modder` refreshes it). Telos's live tools
 * change the running game; this is for building real mods: new items, enemies, mechanics.
 */

export const MODDER_REPO = "https://github.com/rehan-remade/universal-modder";
/** Inside the bundle (forward slashes: they're also the paths results show). */
const ENGINES = "skills/mod-any-game/references/engines";

export interface FieldNote {
  path: string;
  kind: string;
  title: string;
  game?: string;
  games_also?: string[];
  engine?: string;
  route?: string;
  status?: string;
  tags?: string[];
  tools?: string[];
  game_version?: string;
}

/** Game names that tell the route better than Telos's engine detection can (big franchises, own engines). */
const BY_GAME: [RegExp, string][] = [
  [/minecraft/i, "minecraft.md"],
  [/skyrim|fallout|oblivion|morrowind|starfield/i, "bethesda.md"],
  [/age of (empires|mythology)|\baoe ?[234]?\b/i, "genie-aoe2.md"],
  [/terraria|stardew|celeste|\bxna\b|\bfna\b/i, "dotnet-xna.md"],
  [
    /grand theft auto|\bgta\b|red dead|cyberpunk|witcher|elden ring|dark souls|sekiro|armored core|nightreign|resident evil|monster hunter|devil may cry|street fighter|dragon's dogma|baldur|mass effect|dragon age|battlefield|\bfifa\b|crusader kings|europa universalis|hearts of iron|stellaris|victoria|total war|xcom/i,
    "big-frameworks.md",
  ],
  [/doom|quake|half-life|portal|counter-strike|garry/i, "source.md"],
];

/** Telos's engine names (src/games/profile.ts) → playbook. */
const BY_ENGINE: [RegExp, string][] = [
  [/^unity/i, "unity.md"],
  [/^unreal/i, "unreal.md"],
  [/^godot/i, "godot.md"],
  [/^source/i, "source.md"],
  [/gamemaker|rpg maker|ren'?py/i, "misc-engines.md"],
];

const STOP = new Set(["the", "and", "for", "with", "how", "can", "you", "mod", "mods", "modding", "game", "games", "make", "add", "new", "into", "this", "that", "what", "does", "from", "want"]);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

export class ModderKnowledge {
  private index: FieldNote[] | null = null;

  constructor(readonly dir: string) {}

  get available(): boolean {
    return fs.existsSync(path.join(this.dir, "skills", "mod-any-game", "SKILL.md"));
  }

  /** The version bundled (from VENDORED.md), for credits. */
  get source(): string {
    const m = /tree\/([0-9a-f]{7})/.exec(this.raw("VENDORED.md") ?? "");
    return m ? `${MODDER_REPO} (${m[1]})` : MODDER_REPO;
  }

  notes(): FieldNote[] {
    if (!this.index) {
      try {
        this.index = JSON.parse(fs.readFileSync(path.join(this.dir, "knowledge", "index.json"), "utf8")) as FieldNote[];
      } catch {
        this.index = [];
      }
    }
    return this.index;
  }

  playbooks(): string[] {
    try {
      return fs.readdirSync(path.join(this.dir, ENGINES)).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  }

  /** The playbook for a game: by its name first (franchises with their own frameworks), then its engine. */
  playbookFor(profile: Pick<GameProfile, "name" | "engine" | "installDir">): string {
    for (const [re, file] of BY_GAME) if (re.test(profile.name)) return file;
    for (const [re, file] of BY_ENGINE) if (re.test(profile.engine)) return file;
    // .NET games outside Unity (XNA/FNA/MonoGame) ship the framework next to the exe.
    try {
      const files = fs.readdirSync(profile.installDir).map((f) => f.toLowerCase());
      if (files.some((f) => /^(fna|monogame\.framework|microsoft\.xna\.framework.*)\.dll$/.test(f))) return "dotnet-xna.md";
      if (files.includes("package.nw") || files.includes("nw.dll") || files.some((f) => f.endsWith(".love"))) return "misc-engines.md";
    } catch {
      // can't list the folder: fall through
    }
    return "native.md";
  }

  /** Field notes about this game (or ones that list it as a second game). */
  notesFor(game: string): FieldNote[] {
    const want = words(game).join(" ");
    if (!want) return [];
    return this.notes().filter((n) => [n.game, ...(n.games_also ?? [])].some((g) => g && overlap(words(g).join(" "), want)));
  }

  /** Best matches for a question across field notes, playbooks and skills. */
  search(query: string, limit = 5): { path: string; title: string; score: number; meta?: FieldNote }[] {
    const q = words(query);
    if (!q.length) return [];
    const docs: { path: string; title: string; meta?: FieldNote; head: string }[] = [
      ...this.notes().map((n) => ({
        path: path.posix.join("knowledge", n.path),
        title: n.title,
        meta: n,
        head: [n.title, n.game, ...(n.games_also ?? []), n.engine, n.route, ...(n.tags ?? []), ...(n.tools ?? [])].join(" "),
      })),
      ...this.playbooks().map((f) => ({ path: `${ENGINES}/${f}`, title: `Engine playbook: ${f.replace(/\.md$/, "")}`, head: f })),
      ...this.skills().map((s) => ({ path: `skills/${s}/SKILL.md`, title: `Skill: ${s}`, head: s.replace(/-/g, " ") })),
    ];
    return docs
      .map((d) => {
        const body = (this.raw(d.path) ?? "").toLowerCase();
        const head = d.head.toLowerCase();
        let score = 0;
        for (const w of q) {
          if (head.includes(w)) score += 4;
          const hits = body.split(w).length - 1;
          score += Math.min(hits, 5);
        }
        return { path: d.path, title: d.title, score, meta: d.meta };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  skills(): string[] {
    try {
      return fs.readdirSync(path.join(this.dir, "skills")).filter((s) => fs.existsSync(path.join(this.dir, "skills", s, "SKILL.md")));
    } catch {
      return [];
    }
  }

  /** A Markdown file of the bundle, by its path inside it (or a short name: "unity", "fal-assets"). Null outside skills/ and knowledge/. */
  read(name: string): { path: string; text: string } | null {
    const clean = name.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const candidates = [
      clean,
      `knowledge/${clean}`,
      `${ENGINES}/${clean.replace(/\.md$/, "")}.md`,
      `skills/${clean.replace(/\/?SKILL\.md$/, "")}/SKILL.md`,
      `skills/mod-any-game/references/${clean.replace(/\.md$/, "")}.md`,
    ];
    for (const rel of candidates) {
      if (!/^(skills|knowledge)\//.test(rel) || !rel.endsWith(".md") || rel.includes("..")) continue;
      const text = this.raw(rel);
      if (text !== null) return { path: rel, text };
    }
    return null;
  }

  private raw(rel: string): string | null {
    const full = path.resolve(this.dir, rel);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) return null;
    try {
      return fs.readFileSync(full, "utf8");
    } catch {
      return null;
    }
  }
}

function overlap(a: string, b: string): boolean {
  const aw = new Set(a.split(" "));
  return b.split(" ").some((w) => aw.has(w));
}

/** The sections of a Markdown file that mention the question, or its start. */
export function relevant(text: string, query: string | undefined, max: number): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, ""); // frontmatter: the index already has it
  if (body.length <= max || !query) return clip(body, max);
  const q = words(query);
  const sections = body.split(/\n(?=#{2,3} )/);
  const scored = sections.map((s, i) => ({ s, i, score: q.reduce((n, w) => n + (s.toLowerCase().includes(w) ? 1 : 0), 0) }));
  // The most relevant sections that fit (the intro always competes), shown in the file's order.
  const chosen = new Set<number>();
  let size = 0;
  for (const x of scored.filter((x) => x.score > 0 || x.i === 0).sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (size + x.s.length > max) continue;
    chosen.add(x.i);
    size += x.s.length + 2;
  }
  const out = sections.filter((_, i) => chosen.has(i)).join("\n\n");
  return out || clip(body, max);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text.trim() : `${text.slice(0, max).trimEnd()}\n…`;
}

/** The modding_guide tool: any AI in Telos can plan a real mod with universal-modder's playbooks. */
export function moddingTools(knowledge: ModderKnowledge, profile: () => GameProfile | null, opts: { workshop: boolean }): HubTool[] {
  if (!knowledge.available) return [];
  return [
    defineTool({
      name: "modding_guide",
      description:
        "universal-modder's know-how for building REAL mods (new items, weapons, enemies, bosses, mechanics, UI, art, " +
        "sounds), beyond what Telos's live tools change in the running game. With no input: the playbook for the attached " +
        "game's engine (mod loaders, routes, code skeletons, pitfalls), field notes from other agents who modded this " +
        "game, and the safety rules. With query: the best matches for a question (an engine, a game, a technique like " +
        "'sprites' or 'harmony patch'). With open: one playbook, skill or field note by the path a result gave. " +
        "Use it to answer 'can this game be modded / how', and before proposing build_mod.",
      input: z.object({
        query: z.string().optional().describe("What to look up, e.g. 'tModLoader weapon', 'Unreal blueprint mod', 'pixel art sprites'"),
        open: z.string().optional().describe("A path from an earlier result, e.g. knowledge/games/terraria/fal-arsenal-tmodloader.md, or a short name like unity or fal-assets"),
      }),
      readOnly: true,
      run({ query, open }) {
        if (open) {
          const doc = knowledge.read(open);
          if (!doc) throw new Error(`No playbook, skill or field note called ${open}. Call modding_guide with a query to find one.`);
          return `${doc.path} (universal-modder)\n\n${relevant(doc.text, query, 14_000)}`;
        }
        const parts: string[] = [];
        const p = profile();
        if (p) {
          const file = knowledge.playbookFor(p);
          const doc = knowledge.read(`${ENGINES}/${file}`);
          parts.push(`# ${p.name} (${p.engine}): universal-modder's playbook, ${file.replace(/\.md$/, "")}\n\n${relevant(doc?.text ?? "", query ?? p.name, query ? 6_000 : 7_000)}`);
          const notes = knowledge.notesFor(p.name);
          if (notes.length) {
            parts.push(
              `# Field notes about ${p.name}\n` +
                notes.map((n) => `- ${n.title} (${n.status ?? "?"}; route: ${n.route ?? "?"}; ${n.game_version ?? ""}). open: knowledge/${n.path}`).join("\n"),
            );
          }
        }
        if (query) {
          const hits = knowledge.search(query);
          if (hits.length) {
            const best = knowledge.read(hits[0].path);
            parts.push(
              `# Matches for "${query}"\n` +
                hits.map((h) => `- ${h.title}${h.meta?.status ? ` (${h.meta.status})` : ""}. open: ${h.path}`).join("\n") +
                (best ? `\n\n## ${hits[0].title}\n${relevant(best.text, query, 5_000)}` : ""),
            );
          } else {
            parts.push(`Nothing in universal-modder's playbooks or field notes matches "${query}".`);
          }
        }
        if (!p && !query) {
          parts.push(
            "No game attached. Engine playbooks: " +
              knowledge.playbooks().map((f) => f.replace(/\.md$/, "")).join(", ") +
              `. Field notes: ${knowledge.notes().map((n) => n.game).filter(Boolean).join(", ") || "none yet"}. Pass query or open.`,
          );
        }
        parts.push(
          "Rules: only single-player games the player owns; never online clients with anti-cheat; back up saves before " +
            "modded launches; don't share game files or decompiled code." +
            (opts.workshop
              ? " To build the mod for real, propose it with build_mod: the Workshop builds, installs and tests it with these playbooks once the player approves it in the overlay."
              : ""),
        );
        parts.push(`(From universal-modder, ${knowledge.source}, MIT.)`);
        return parts.join("\n\n");
      },
    }),
  ];
}

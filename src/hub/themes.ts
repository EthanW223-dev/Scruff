import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GameManager } from "./game.ts";
import { defineTool, type HubTool } from "./tools.ts";

/**
 * How the overlay (and dashboard) look for each game: colors lifted from the game's own UI,
 * a font mood that matches its genre, and the corner it sits in. Saved per game, so Telos
 * looks at home the next time that game is attached.
 */

export const FONT_MOODS = ["clean", "fantasy", "scifi", "pixel", "horror", "western", "cartoon", "military"] as const;
export const CORNERS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;

export interface Theme {
  accent: string;
  background: string;
  text: string;
  font: (typeof FONT_MOODS)[number];
  corner: (typeof CORNERS)[number];
  /** "auto": picked from a screenshot; "ai" / "user": chosen on purpose and saved. */
  source: "default" | "auto" | "ai" | "user";
}

export const DEFAULT_THEME: Theme = {
  accent: "#f5f5f7",
  background: "#141417",
  text: "#f5f5f7",
  font: "clean",
  corner: "top-right",
  source: "default",
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb color");

export const ThemeInput = z.object({
  accent: hex.optional().describe("Highlight color, e.g. the game's gold/health/UI accent"),
  background: hex.optional().describe("Panel background; dark tones read best over a game"),
  text: hex.optional().describe("Text color; adjusted automatically if it would be hard to read"),
  font: z.enum(FONT_MOODS).optional().describe("Font mood matching the game's genre and UI"),
  corner: z.enum(CORNERS).optional().describe("Where the overlay sits; pick a corner the game's HUD leaves empty"),
});

/** Emits "change" when the active theme changes. */
export class ThemeStore extends EventEmitter {
  private saved: Record<string, Theme> = {};
  private auto: Record<string, Theme> = {};

  constructor(
    private file: string,
    private games: GameManager,
  ) {
    super();
    try {
      this.saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // none saved yet
    }
    games.on("update", () => this.emit("change"));
  }

  private key(): string {
    return this.games.session && !this.games.session.isClosed ? this.games.session.target.name.toLowerCase() : "_default";
  }

  current(): Theme {
    const key = this.key();
    return this.saved[key] ?? this.auto[key] ?? this.saved._default ?? DEFAULT_THEME;
  }

  hasSaved(): boolean {
    return Boolean(this.saved[this.key()]);
  }

  /** A deliberate choice (the AI or the player): applied and saved for this game. */
  set(input: z.infer<typeof ThemeInput>, source: "ai" | "user"): Theme {
    const theme = readable({ ...this.current(), ...stripUndefined(input), source });
    this.saved[this.key()] = theme;
    this.persist();
    this.emit("change");
    return theme;
  }

  /** Colors picked from a screenshot: only used while nothing has been chosen on purpose. */
  suggest(input: z.infer<typeof ThemeInput>): void {
    const key = this.key();
    if (this.saved[key] || key === "_default") return;
    this.auto[key] = readable({ ...DEFAULT_THEME, ...stripUndefined(input), source: "auto" });
    this.emit("change");
  }

  reset(): void {
    delete this.saved[this.key()];
    delete this.auto[this.key()];
    this.persist();
    this.emit("change");
  }

  tool(): HubTool {
    return defineTool({
      name: "style_overlay",
      description:
        "Restyle Telos's in-game overlay to fit the current game: colors taken from the game's own UI (look at the " +
        "screen first), a font mood matching its genre, and a corner the game's HUD leaves free. Saved per game. " +
        "Also use it when the player asks to change how Telos looks.",
      input: ThemeInput,
      run: (input) => {
        const theme = this.set(input, "ai");
        return `Overlay styled for ${this.key() === "_default" ? "all games" : this.games.session!.target.name}: ${JSON.stringify(theme)}`;
      },
    });
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 2));
    } catch {
      // not fatal
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// --- contrast: never let a theme make the overlay unreadable ---------------------------------

function luminance(hexColor: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hexColor.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function readable(theme: Theme): Theme {
  const out = { ...theme };
  if (contrast(out.text, out.background) < 4.5) {
    out.text = contrast("#f5f5f7", out.background) >= contrast("#111318", out.background) ? "#f5f5f7" : "#111318";
  }
  // The accent is a fill (buttons, highlights, shadows) with its own ink, so it only has to
  // stand apart from the background, not carry text on it. Fallbacks stay
  // monochrome: the default theme is black & white, never pink.
  if (contrast(out.accent, out.background) < 1.6) {
    out.accent = luminance(out.background) < 0.2 ? "#f5f5f7" : "#1e1e1e";
  }
  return out;
}

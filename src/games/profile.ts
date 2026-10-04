import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMinecraft, minecraftProfile } from "./minecraft.ts";

/**
 * What Telos can learn about a game from its files: the engine, where it keeps saves and
 * settings, and where its code is, so the AI knows how the game works before touching it.
 */

export interface GameProfile {
  exe: string;
  installDir: string;
  name: string;
  engine: string;
  /** .NET assemblies (Unity Mono) or IL2CPP metadata that name the game's variables. */
  codeFiles: string[];
  codeKind: "dotnet" | "il2cpp" | null;
  saveDirs: string[];
  configFiles: string[];
  notes: string[];
}

/**
 * What the running process says about itself, beyond its exe: games whose exe is a shared
 * runtime (Minecraft: Java Edition runs as javaw.exe) are known by their window and launch.
 */
export interface GameLaunch {
  /** Window title. */
  title?: string;
  /** The process's arguments (read once at attach; never kept). */
  args?: string[];
  /** The folder it runs in, when the OS tells us. */
  cwd?: string;
}

export interface UserDirs {
  home: string;
  appData: string; // Roaming
  localAppData: string;
}

export function userDirs(env = process.env): UserDirs {
  const home = env.USERPROFILE ?? os.homedir();
  return {
    home,
    appData: env.APPDATA ?? path.join(home, "AppData", "Roaming"),
    localAppData: env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
  };
}

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const list = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
/** "60 Seconds! Reatomized" and "60SecondsReatomized" should match. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function buildProfile(exe: string, dirs: UserDirs = userDirs(), launch: GameLaunch = {}): GameProfile {
  // --- Minecraft: Java Edition (the exe is Java; the game lives in its game directory) ---
  const minecraft = detectMinecraft(exe, launch, dirs);
  if (minecraft) return minecraftProfile(exe, minecraft);

  let installDir = path.dirname(exe);
  const base = path.basename(exe).replace(/\.exe$/i, "");
  const names = new Set<string>([base.replace(/-Win64-Shipping$/i, ""), path.basename(installDir)]);
  const profile: GameProfile = {
    exe,
    installDir,
    name: base,
    engine: "Unknown",
    codeFiles: [],
    codeKind: null,
    saveDirs: [],
    configFiles: [],
    notes: [],
  };
  const extraSaveDirs: string[] = [];

  // --- Unity ---
  const dataDir = [path.join(installDir, `${base}_Data`), ...list(installDir).filter((f) => f.endsWith("_Data")).map((f) => path.join(installDir, f))].find(isDir);
  if (dataDir || exists(path.join(installDir, "UnityPlayer.dll"))) {
    const managed = dataDir ? path.join(dataDir, "Managed") : "";
    const metadata = dataDir ? path.join(dataDir, "il2cpp_data", "Metadata", "global-metadata.dat") : "";
    if (managed && exists(path.join(managed, "Assembly-CSharp.dll"))) {
      profile.engine = "Unity (Mono)";
      profile.codeKind = "dotnet";
      profile.codeFiles = ["Assembly-CSharp.dll", "Assembly-CSharp-firstpass.dll"].map((f) => path.join(managed, f)).filter(exists);
    } else if (metadata && exists(metadata)) {
      profile.engine = "Unity (IL2CPP)";
      profile.codeKind = "il2cpp";
      profile.codeFiles = [metadata];
    } else {
      profile.engine = "Unity";
    }
    if (isDir(path.join(installDir, "MelonLoader"))) {
      profile.notes.push("This game has MelonLoader (mods in its Mods folder); Telos won't add BepInEx next to it.");
    }
    // app.info holds the company and product names Unity uses for its save folder.
    const [company, product] = dataDir ? readLines(path.join(dataDir, "app.info")) : [];
    if (product) {
      names.add(product);
      profile.name = product;
      if (company) {
        extraSaveDirs.push(path.join(dirs.home, "AppData", "LocalLow", company, product));
        profile.notes.push(
          `Unity keeps settings (PlayerPrefs) in the registry under HKEY_CURRENT_USER\\Software\\${company}\\${product}.`,
        );
      }
    }
  }

  // --- Unreal Engine: <Root>/<Project>/Binaries/Win64/<Project>-Win64-Shipping.exe ---
  const parts = installDir.split(/[\\/]/);
  const bin = parts.lastIndexOf("Binaries");
  if (/-Win64-Shipping$/i.test(base) || bin > 0) {
    profile.engine = "Unreal Engine";
    const project = bin > 0 ? parts[bin - 1] : base.replace(/-Win64-Shipping$/i, "");
    names.add(project);
    profile.name = project;
    if (bin > 1) installDir = parts.slice(0, bin - 1).join(path.sep) || installDir;
    const saved = path.join(dirs.localAppData, project, "Saved");
    extraSaveDirs.push(path.join(saved, "SaveGames"));
    for (const cfgDir of [path.join(saved, "Config", "Windows"), path.join(saved, "Config", "WindowsNoEditor")]) {
      for (const f of list(cfgDir)) if (f.endsWith(".ini")) profile.configFiles.push(path.join(cfgDir, f));
    }
    profile.notes.push("Unreal games often honor console variables in Saved/Config/.../Engine.ini; UE4SS can add Lua mods.");
  }

  // --- smaller engines ---
  if (profile.engine === "Unknown") {
    const files = list(installDir);
    if (files.some((f) => f.endsWith(".pck"))) profile.engine = "Godot";
    else if (files.includes("data.win")) profile.engine = "GameMaker";
    else if (exists(path.join(installDir, "www", "data", "System.json")) || exists(path.join(installDir, "data", "System.json"))) {
      profile.engine = "RPG Maker MV/MZ";
      const www = exists(path.join(installDir, "www")) ? path.join(installDir, "www") : installDir;
      // Every RPG Maker game's exe is Game.exe: the real name is in its database.
      try {
        const title = JSON.parse(fs.readFileSync(path.join(www, "data", "System.json"), "utf8")).gameTitle;
        if (typeof title === "string" && title.trim()) {
          profile.name = title.trim();
          names.add(profile.name);
        }
      } catch {
        // unreadable or encrypted: keep the exe's name
      }
      extraSaveDirs.push(path.join(www, "save"));
      profile.notes.push("RPG Maker keeps items, actors and prices in plain JSON under data/ (edit_game_file works on them).");
    } else if (isDir(path.join(installDir, "renpy"))) {
      profile.engine = "Ren'Py";
      extraSaveDirs.push(path.join(installDir, "game", "saves"));
    } else if (files.some((f) => isDir(path.join(installDir, f)) && exists(path.join(installDir, f, "gameinfo.txt")))) {
      profile.engine = "Source";
      profile.notes.push("Source games have a developer console (sv_cheats 1) that's often easier than memory editing.");
    }
  }
  profile.installDir = installDir;

  // --- save folders: the usual places, under any of the game's names ---
  const candidates = [...extraSaveDirs];
  for (const name of names) {
    candidates.push(
      path.join(dirs.appData, name),
      path.join(dirs.localAppData, name),
      path.join(dirs.home, "Documents", "My Games", name),
      path.join(dirs.home, "Documents", name),
      path.join(dirs.home, "Saved Games", name),
    );
  }
  for (const sub of ["save", "saves", "Save", "Saves", "SaveGames", "savedata"]) candidates.push(path.join(installDir, sub));
  // LocalLow/<any company>/<game>, matched loosely (punctuation differs between app.info and folders).
  const localLow = path.join(dirs.home, "AppData", "LocalLow");
  const wanted = new Set([...names].map(norm).filter((n) => n.length > 2));
  for (const company of list(localLow)) {
    for (const game of list(path.join(localLow, company))) {
      if (wanted.has(norm(game))) candidates.push(path.join(localLow, company, game));
    }
  }
  const found = [...new Set(candidates.map((c) => path.resolve(c)))].filter(isDir);
  // Prefer Local/Game/Saved/SaveGames over Local/Game when both exist.
  profile.saveDirs = found.filter((d) => !found.some((o) => o !== d && o.startsWith(d + path.sep)));

  for (const f of list(installDir)) {
    if (/\.(ini|cfg|json|xml|yaml|yml|txt)$/i.test(f) && !/^(readme|license|eula|credits)/i.test(f)) {
      profile.configFiles.push(path.join(installDir, f));
    }
  }
  return profile;
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The folders Telos may read (and, for saves and settings, edit) for this game. */
export function allowedRoots(profile: GameProfile): string[] {
  return [profile.installDir, ...profile.saveDirs, ...profile.configFiles.map((f) => path.dirname(f))];
}

export function isInside(file: string, roots: string[]): boolean {
  const resolved = path.resolve(file);
  return roots.some((r) => {
    const rel = path.relative(path.resolve(r), resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

export function describeProfile(p: GameProfile): string {
  const lines = [`Game files: ${p.name}, ${p.engine}, installed at ${p.installDir}.`];
  if (p.codeKind === "dotnet") {
    lines.push(
      "Its code is readable: search_game_code shows variable names and types. It can also take Telos's Unity bridge " +
        "(unity_bridge_status): full live control of objects, fields, methods, colors, sizes, spawning, gravity and levels.",
    );
  }
  if (p.codeKind === "il2cpp") lines.push("Its code names are searchable with search_game_code (names only, no types).");
  lines.push(p.saveDirs.length ? `Saves/settings found in: ${p.saveDirs.join("; ")}.` : "No save folder found yet.");
  // Minecraft's game folder, version and loader decide how anything gets modded: say them.
  if (p.engine === "Minecraft (Java)") lines.push(...p.notes);
  return lines.join(" ");
}

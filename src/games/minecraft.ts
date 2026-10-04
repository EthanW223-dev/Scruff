import fs from "node:fs";
import path from "node:path";
import type { GameLaunch, GameProfile, UserDirs } from "./profile.ts";

/**
 * Minecraft: Java Edition. Its process is the Java runtime (javaw.exe from the launcher's own
 * runtime, or a system java), so the exe's folder says nothing about the game. The game lives
 * in its game directory (.minecraft, or a launcher instance's folder): worlds in saves/, mods
 * in mods/, settings in options.txt. The launch command names it (--gameDir), along with the
 * version and the mod loader. The command line also carries the player's session token
 * (--accessToken): only the flags below are read from it, and it's never kept.
 */

const JAVA_EXE = /^javaw?(\.exe)?$/i;

/** Main classes of the official launcher's game and the mod loaders and launchers that wrap it. */
const MAIN_CLASSES: [RegExp, Loader | null][] = [
  [/^net\.minecraft\.client\.main\.Main$/, null],
  [/^net\.minecraft\.launchwrapper\.Launch$/, null],
  [/^net\.fabricmc\.loader\.(impl\.)?launch\.knot\.KnotClient$/, "Fabric"],
  [/^org\.quiltmc\.loader\.impl\.launch\.knot\.KnotClient$/, "Quilt"],
  [/^cpw\.mods\.(bootstraplauncher\.BootstrapLauncher|modlauncher\.Launcher)$/, "Forge"],
  [/^net\.minecraftforge\./, "Forge"],
  [/^net\.neoforged\./, "NeoForge"],
  // Prism Launcher / MultiMC pass the game's arguments on stdin; the loader isn't in the command line.
  [/^org\.(prismlauncher|multimc)\.EntryPoint$/, null],
];

/** "Minecraft 1.21.4", "Minecraft* 26.3", "Minecraft* 1.20.1 - Singleplayer"; not "Minecraft Launcher". */
const TITLE = /^Minecraft\*?(?:\s+(\d[\w.-]*))?(?:\s+-\s.*)?$/i;

/** The launcher's sign-in files: the player's Microsoft account tokens. Never read, listed or sent. */
const PRIVATE_FILES = /^(launcher_accounts.*\.json|launcher_msa_credentials.*|launcher_entitlements.*\.json)$/i;

export type Loader = "Fabric" | "Quilt" | "Forge" | "NeoForge";

export interface MinecraftLaunch {
  gameDir: string;
  /** The game version, when the title or the launch says it ("26.3", "1.21.4"). */
  version?: string;
  loader?: Loader;
  loaderVersion?: string;
}

export function isJavaExe(exe: string | undefined): boolean {
  return Boolean(exe && JAVA_EXE.test(path.basename(exe.replace(/\\/g, "/"))));
}

/** A file the player's AI must never see (account sign-ins), wherever it sits in a game folder. */
export function isPrivateFile(file: string): boolean {
  return PRIVATE_FILES.test(path.basename(file.replace(/\\/g, "/")));
}

/** The value after a flag ("--gameDir X") or in it ("-Dkey=X"). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

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
/** A folder that looks like a game directory (it has worlds or settings in it). */
const looksLikeGameDir = (dir: string) => isDir(path.join(dir, "saves")) || fs.existsSync(path.join(dir, "options.txt"));

/**
 * Whether this process is Minecraft: Java Edition, and where its game lives. Null for any other
 * process (Java or not).
 */
export function detectMinecraft(exe: string, launch: GameLaunch, dirs: UserDirs): MinecraftLaunch | null {
  if (!isJavaExe(exe)) return null;
  const args = launch.args ?? [];
  const title = launch.title?.trim() ?? "";
  const main = args.map((a) => MAIN_CLASSES.find(([re]) => re.test(a))).find(Boolean);
  const gameArgs = args.includes("--gameDir") && (args.includes("--assetIndex") || args.includes("--version"));
  const titled = TITLE.test(title);
  if (!main && !gameArgs && !titled) return null;

  // The loader: the main class, the version id ("fabric-loader-0.16.10-1.21.4", "1.20.1-forge-47.3.0",
  // "neoforge-21.1.77", "quilt-loader-0.26.4-1.21.1") or Forge's own flags.
  const versionId = flag(args, "--version");
  let loader: Loader | undefined = main?.[1] ?? undefined;
  let loaderVersion: string | undefined;
  let version: string | undefined = TITLE.exec(title)?.[1];
  const knot = versionId && /^(fabric|quilt)-loader-([\d.]+)-(.+)$/i.exec(versionId);
  if (knot) {
    loader = knot[1].toLowerCase() === "fabric" ? "Fabric" : "Quilt";
    loaderVersion = knot[2];
    version ??= knot[3];
  }
  const neo = flag(args, "--fml.neoForgeVersion") ?? (versionId && /^neoforge-([\d.]+)/i.exec(versionId)?.[1]);
  const forge = flag(args, "--fml.forgeVersion") ?? (versionId && /-forge-([\d.]+)/i.exec(versionId)?.[1]);
  if (neo) {
    loader = "NeoForge";
    loaderVersion = neo;
  } else if (forge) {
    loader = "Forge";
    loaderVersion = forge;
  }
  version ??= flag(args, "--fml.mcVersion") ?? (versionId && /^\d+\.\d+[\w.-]*$/.test(versionId) ? versionId : undefined);

  const gameDir = findGameDir(args, launch.cwd, dirs);
  // No launch to read (Windows wouldn't say), but the title's asterisk says it's modded: if the
  // launcher has one kind of loader for this version, that's the one running.
  if (!loader && version && /^Minecraft\*/i.test(title)) {
    const found = installedLoaders(gameDir, version);
    if (found.length && found.every((f) => f.loader === found[0].loader)) {
      loader = found[0].loader;
      loaderVersion = found.map((f) => f.version).sort(newer)[0];
    }
  }
  return { gameDir, version, loader, loaderVersion };
}

/** The loader versions the launcher has for a game version (versions/fabric-loader-0.16.10-26.3, …). */
function installedLoaders(gameDir: string, version: string): { loader: Loader; version: string }[] {
  const out: { loader: Loader; version: string }[] = [];
  for (const v of list(path.join(gameDir, "versions"))) {
    const knot = /^(fabric|quilt)-loader-([\d.]+)-(.+)$/i.exec(v);
    if (knot && knot[3] === version) out.push({ loader: knot[1].toLowerCase() === "fabric" ? "Fabric" : "Quilt", version: knot[2] });
    const forge = /^(.+)-forge-([\d.]+)$/i.exec(v);
    if (forge && forge[1] === version) out.push({ loader: "Forge", version: forge[2] });
  }
  return out;
}

/** Sorts dotted versions newest first. */
function newer(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/**
 * The game directory: --gameDir when the launcher passes it (the official launcher, CurseForge,
 * Modrinth, ATLauncher); else next to the natives folder (Prism Launcher and MultiMC instances:
 * instances/<name>/natives beside instances/<name>/minecraft); else the folder the game runs in;
 * else the default .minecraft.
 */
function findGameDir(args: string[], cwd: string | undefined, dirs: UserDirs): string {
  const given = flag(args, "--gameDir");
  if (given && isDir(given)) return path.resolve(given);
  const natives = flag(args, "-Djava.library.path")?.split(path.delimiter)[0];
  if (natives) {
    let dir = path.resolve(natives);
    for (let up = 0; up < 3; up++) {
      if (/^\.?minecraft$/i.test(path.basename(dir)) && looksLikeGameDir(dir)) return dir;
      for (const sub of [".minecraft", "minecraft"]) if (looksLikeGameDir(path.join(dir, sub))) return path.join(dir, sub);
      dir = path.dirname(dir);
    }
  }
  if (cwd && looksLikeGameDir(cwd)) return path.resolve(cwd);
  const defaults = [
    path.join(dirs.appData, ".minecraft"),
    path.join(dirs.home, ".minecraft"),
    path.join(dirs.home, "Library", "Application Support", "minecraft"),
  ];
  return defaults.find(isDir) ?? defaults[0];
}

const SETTINGS = /^options(of|shaders)?\.txt$/i;
const CONFIG_EXT = /\.(json|json5|toml|properties|cfg|txt|yaml|yml)$/i;

export function minecraftProfile(exe: string, mc: MinecraftLaunch): GameProfile {
  const { gameDir } = mc;
  const saves = path.join(gameDir, "saves");
  const config = path.join(gameDir, "config");
  const configFiles = [
    ...list(gameDir).filter((f) => SETTINGS.test(f)).map((f) => path.join(gameDir, f)),
    ...list(config).filter((f) => CONFIG_EXT.test(f)).slice(0, 40).map((f) => path.join(config, f)),
  ].filter((f) => !isPrivateFile(f));
  const mods = list(path.join(gameDir, "mods")).filter((f) => f.endsWith(".jar"));
  // Loaders installed through the launcher show up as their own version folders.
  const installed = list(path.join(gameDir, "versions"))
    .filter((v) => /fabric-loader|quilt-loader|forge|neoforge/i.test(v))
    .slice(0, 6);

  const notes: string[] = [];
  const edition = `Minecraft: Java Edition${mc.version ? ` ${mc.version}` : ""}`;
  if (mc.loader) {
    notes.push(
      `${edition} running ${mc.loader}${mc.loaderVersion ? ` ${mc.loaderVersion}` : ""}: mods go in ${path.join(gameDir, "mods")} ` +
        `(${mods.length} there now) and must match this exact game and loader version.`,
    );
  } else {
    notes.push(
      `${edition}, no mod loader running${mods.length ? ` (though ${mods.length === 1 ? "1 mod sits" : `${mods.length} mods sit`} in mods/)` : ""}. ` +
        "A code mod needs Fabric (or NeoForge) for this exact game version first, installed as its own launcher profile.",
    );
  }
  if (installed.length) notes.push(`Loader versions installed in the launcher: ${installed.join(", ")}.`);
  notes.push(
    `Worlds are in ${saves}; each world's level.dat and region files are binary (NBT), so edit them only with an NBT tool, ` +
      "after a backup, with the world closed.",
    "Java moves values around in memory as it runs (garbage collection), so memory edits rarely stick. In a single-player " +
      "world with cheats on, the game's own commands (/give, /effect, /gamerule, /time) change things live.",
    "Mods are for single-player worlds and servers the player runs, never other people's servers.",
    "launcher_accounts.json holds the player's sign-in: Telos never reads it.",
  );

  return {
    exe,
    installDir: gameDir,
    name: "Minecraft",
    engine: "Minecraft (Java)",
    codeFiles: [],
    codeKind: null,
    saveDirs: isDir(saves) ? [saves] : [],
    configFiles,
    notes,
    minecraft: { version: mc.version, loader: mc.loader, loaderVersion: mc.loaderVersion },
  };
}

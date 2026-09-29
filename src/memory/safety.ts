import type { ProcessInfo } from "./types.ts";

/**
 * Scruff is for single-player games. Editing memory while an anti-cheat is running gets
 * accounts banned (and cheating in multiplayer ruins it for everyone else), so the hub
 * refuses to attach when it spots one. This is a best-effort name check, not a guarantee.
 */
const ANTI_CHEAT_PROCESSES: Record<string, string> = {
  "easyanticheat.exe": "Easy Anti-Cheat",
  "easyanticheat_eos.exe": "Easy Anti-Cheat",
  "easyanticheat_eos_setup.exe": "Easy Anti-Cheat",
  "beservice.exe": "BattlEye",
  "beservice_x64.exe": "BattlEye",
  "vgc.exe": "Riot Vanguard",
  "vgtray.exe": "Riot Vanguard",
  "faceit.exe": "FACEIT",
  "faceitservice.exe": "FACEIT",
  "eaanticheat.gameservice.exe": "EA Javelin",
  "gamemon.des": "nProtect GameGuard",
  "gamemon64.des": "nProtect GameGuard",
  "pnkbstra.exe": "PunkBuster",
  "pnkbstrb.exe": "PunkBuster",
  "xigncode.exe": "XIGNCODE3",
  "zakynthos.exe": "Zakynthos",
  "acesvc.exe": "ACE",
};

/** Online games whose anti-cheat lives inside the game process itself (e.g. VAC). */
const ONLINE_GAMES: Record<string, string> = {
  "cs2.exe": "Counter-Strike 2",
  "csgo.exe": "CS:GO",
  "dota2.exe": "Dota 2",
  "tf_win64.exe": "Team Fortress 2",
  "project8.exe": "Deadlock",
  "valorant.exe": "Valorant",
  "valorant-win64-shipping.exe": "Valorant",
  "fortniteclient-win64-shipping.exe": "Fortnite",
  "r5apex.exe": "Apex Legends",
  "r5apex_dx12.exe": "Apex Legends",
  "overwatch.exe": "Overwatch",
  "rainbowsix.exe": "Rainbow Six Siege",
  "rustclient.exe": "Rust",
  "eft.exe": "Escape from Tarkov",
  "escapefromtarkov.exe": "Escape from Tarkov",
  "cod.exe": "Call of Duty",
  "robloxplayerbeta.exe": "Roblox",
  "leagueoflegends.exe": "League of Legends",
  "league of legends.exe": "League of Legends",
  "pubg.exe": "PUBG",
  "tslgame.exe": "PUBG",
  "destiny2.exe": "Destiny 2",
  "gta5.exe": "GTA V (GTA Online shares the executable)",
  "gta5_enhanced.exe": "GTA V (GTA Online shares the executable)",
  "marvel-win64-shipping.exe": "Marvel Rivals",
  "thefinals.exe": "The Finals",
};

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
}

/** Windows reports "Game" or "Game.exe" depending on the source; compare without ".exe". */
function normalize(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

const antiCheat = new Map(Object.entries(ANTI_CHEAT_PROCESSES).map(([k, v]) => [normalize(k), v]));
const onlineGames = new Map(Object.entries(ONLINE_GAMES).map(([k, v]) => [normalize(k), v]));

export function checkAttachSafety(target: ProcessInfo, running: ProcessInfo[]): SafetyVerdict {
  const game = onlineGames.get(normalize(target.name));
  if (game) {
    return {
      ok: false,
      reason: `${game} is an online game with anti-cheat. Scruff only mods single-player games, so it won't touch it.`,
    };
  }
  for (const p of running) {
    const ac = antiCheat.get(normalize(p.name));
    if (ac) {
      return {
        ok: false,
        reason:
          `${ac} is running (${p.name}). Editing memory while an anti-cheat is active can get your account banned, ` +
          "so Scruff won't attach. If this is a single-player game, launch it in offline mode without the anti-cheat.",
      };
    }
  }
  return { ok: true };
}

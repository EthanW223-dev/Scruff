import type { GameProfile } from "../games/profile.ts";
import { norm, type AdapterRegistry } from "./adapters.ts";

/**
 * Which bridge family serves a game engine: the tool prefix its adapter registers with.
 * Unity bridges are "unity", Unreal ones (native or UE4SS) "unreal", RPG Maker's "rpgmaker".
 */
export function bridgeFamily(engine: string): string | null {
  if (engine.startsWith("Unity")) return "unity";
  if (engine === "Unreal Engine") return "unreal";
  if (engine.startsWith("RPG Maker")) return "rpgmaker";
  return null;
}

/**
 * The tool prefix of the bridge connected for this game, or null. With several games connected
 * at once (game links), "a Unity bridge is connected" isn't enough: it has to be this game's.
 * Adapters name their game ("Unity bridge: 60 Seconds! Reatomized"); one that doesn't say
 * which game it's in counts for any game of its engine.
 */
export function connectedBridge(profile: GameProfile, adapters: AdapterRegistry): string | null {
  const family = bridgeFamily(profile.engine);
  if (!family) return null;
  const mine = adapters.state().filter((a) => a.prefix.startsWith(family));
  const names = [profile.name, profile.exe.split(/[/\\]/).pop()!.replace(/\.exe$/i, "").replace(/-Win64-Shipping$/i, "")].map(norm);
  const hit = mine.find((a) => {
    const game = norm(a.name.includes(":") ? a.name.slice(a.name.indexOf(":") + 1) : "");
    if (!game) return false;
    return names.some((n) => n === game || (n.length > 2 && game.length > 2 && (n.includes(game) || game.includes(n))));
  });
  return (hit ?? mine.find((a) => !a.name.includes(":")))?.prefix ?? null;
}

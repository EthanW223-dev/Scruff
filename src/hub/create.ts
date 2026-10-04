import path from "node:path";
import { AdapterRegistry } from "./adapters.ts";
import { Agent, type Brain } from "./agent.ts";
import { GameManager, exeRunning, memoryTools } from "./game.ts";
import { gameFileTools } from "./gamefiles.ts";
import { describeProfile } from "../games/profile.ts";
import { JevService, JevSettings, type Jev } from "./jev.ts";
import { LinkManager, linkTools } from "./links.ts";
import { modelFileTools } from "./modelfiles.ts";
import { Ue4ssRelays } from "./ue4ssrelay.ts";
import { ue4ssModDir } from "../games/ue4ss.ts";
import fs from "node:fs";
import { McpEndpoint } from "./mcp.ts";
import { ModderKnowledge, moddingTools } from "./modder.ts";
import { Marketplace, Thunderstore, marketplaceTools } from "./marketplace.ts";
import { CurseForge, CurseForgeKey, Modrinth, type McStore } from "./minecraftmods.ts";
import { Workshop, workshopTools, type BuilderChoice } from "./workshop.ts";
import { engineModSupport } from "./mods.ts";
import { quickPath } from "./quick.ts";
import type { ModelRouter } from "./models.ts";
import { ScreenBridge } from "./screen.ts";
import { startServer } from "./server.ts";
import { ThemeStore } from "./themes.ts";
import { codeVersion } from "./version.ts";
import { unityBridgeTools } from "./unitybridge.ts";
import { unrealBridgeTools } from "./unrealbridge.ts";
import { rpgMakerBridgeTools } from "./rpgmakerbridge.ts";
import { connectedBridge } from "./bridges.ts";
import { visionFromBrain, type VisionClient } from "./vision.ts";

export interface HubOptions {
  root: string;
  port: number;
  lan: boolean;
  token: string;
  /** Picks and switches models. Tests can pass a fixed brain instead. */
  router?: ModelRouter;
  brain?: Brain;
  /** Where per-game themes and downloaded models live. Defaults to <root>/.scruff. */
  dataDir?: string;
  /** Replaces the Jev client built from the TypeSafe key (tests); null turns the fast path off. */
  jev?: Jev | null;
  /** Which AI builds Workshop mods (tests); defaults to the chat's AI from the AI menu. */
  workshopBuilder?: () => BuilderChoice;
  /** The marketplace's mod store (tests point it at a stand-in). */
  thunderstore?: Thunderstore;
  /** Minecraft's mod stores (tests point them at stand-ins); default Modrinth and CurseForge. */
  minecraftStores?: McStore[];
}

/** Telos tools the chat AI keeps while it builds a Workshop mod. */
const WORKSHOP_EXTRAS = new Set(["modding_guide", "game_status", "game_info", "search_game_code", "list_game_files", "read_game_file", "look_at_screen", "verify_visual_change"]);

export async function createHub(opts: HubOptions) {
  const games = new GameManager();
  games.bridgeDll = path.join(opts.root, "bridge", "ScruffBridge.dll");
  games.il2cppBridgeDll = path.join(opts.root, "bridge", "TelosBridge.IL2CPP.dll");
  games.unrealBridgeDll = path.join(opts.root, "bridge-unreal", "TelosBridgeUE.dll");
  games.rpgMakerBridgeJs = path.join(opts.root, "bridge-rpgmaker", "TelosBridge.js");
  games.ue4ssBridgeMain = path.join(opts.root, "bridge-ue4ss", "TelosBridge", "Scripts", "main.lua");
  const adapters = new AdapterRegistry();
  const screen = new ScreenBridge();
  const dataDir = opts.dataDir ?? path.join(opts.root, ".scruff");
  const themes = new ThemeStore(path.join(dataDir, "themes.json"), games);
  const links = new LinkManager({ file: path.join(dataDir, "links.json"), adapters, games });
  // Unreal games with Telos's UE4SS mod talk through files: a relay per game shows each as an adapter.
  const ue4ssRelays = new Ue4ssRelays(adapters);
  games.on("update", () => {
    const p = games.profile;
    const modDir = p && p.engine === "Unreal Engine" ? ue4ssModDir(p) : null;
    if (p && modDir && fs.existsSync(path.join(modDir, "Scripts", "main.lua"))) ue4ssRelays.ensure(modDir, p.name);
  });

  // universal-modder (bundled): its playbooks for every AI, and the Workshop that builds real mods with it.
  const knowledge = new ModderKnowledge(path.join(opts.root, "vendor", "universal-modder"));
  // The Workshop builds with the chat's own AI: Claude Code as itself, any other AI through Telos's builder tools.
  const chatAi = () => {
    const d = opts.router?.describe();
    if (!d) return { label: brain!.model, ready: true, problem: undefined as string | undefined, claudeCode: false };
    return {
      label: d.model && d.model !== "default" ? `${d.providerLabel} · ${d.model}` : d.providerLabel,
      ready: d.ready,
      problem: d.problem,
      claudeCode: d.provider === "claude-code",
    };
  };
  const workshop = new Workshop({
    dataDir,
    pluginDir: knowledge.dir,
    mcpUrl: `http://127.0.0.1:${opts.port}/mcp`,
    env: process.env,
    builder:
      opts.workshopBuilder ??
      ((): BuilderChoice => {
        const ai = chatAi();
        if (ai.claudeCode && opts.router) return { kind: "claude-code", label: ai.label, launch: opts.router.claudeCodeLaunch() };
        // brain is checked right below; builds only start long after.
        return { kind: "chat", label: ai.label, brain: opts.router?.brain() ?? brain!, ready: ai.ready, problem: ai.problem };
      }),
    describeBuilder: () => {
      if (opts.workshopBuilder) {
        const b = opts.workshopBuilder();
        return { label: b.label, ready: b.kind === "claude-code" || b.ready };
      }
      const { label, ready, problem } = chatAi();
      return { label, ready, problem };
    },
    // While building, the chat AI also gets Telos's game tools that help it check its work.
    extraTools: () => tools.filter((t) => WORKSHOP_EXTRAS.has(t.name)),
  });

  // Other players' mods, ready to add: Thunderstore, and Modrinth and CurseForge for Minecraft.
  const curseforgeKey = new CurseForgeKey(path.join(dataDir, "curseforge.json"));
  const market = new Marketplace({
    store: opts.thunderstore ?? new Thunderstore({ cacheDir: path.join(dataDir, "market") }),
    profile: () => games.profile,
    isRunning: exeRunning,
    minecraft: {
      stores: opts.minecraftStores ?? [
        new Modrinth({ cacheDir: path.join(dataDir, "market") }),
        new CurseForge({ key: () => curseforgeKey.get(), cacheDir: path.join(dataDir, "market") }),
      ],
      curseforgeKey,
    },
  });

  // Claude Code as the brain calls Telos's tools over this hub's own MCP endpoint.
  opts.router?.useHub({ mcpUrl: `http://127.0.0.1:${opts.port}/mcp`, cwd: path.join(dataDir, "claude-code") });
  const brain = opts.brain ?? opts.router?.brain();
  if (!brain) throw new Error("createHub needs a router or a brain.");
  /**
   * A fresh vision client per call, built from a fresh Brain: if the chat model is a
   * text-only local one, its blindness must not poison the agent's own provider state.
   */
  const vision = (): VisionClient | null => {
    try {
      return visionFromBrain(() => opts.router?.brain() ?? brain);
    } catch {
      return null;
    }
  };

  /** The mod builder, for the chat AI: working on what, or how the last build ended. */
  const buildNote = (): string => {
    const j = workshop.latest;
    if (!j) return "";
    if (j.status === "running") return `Your mod builder is working on "${j.request}" for ${j.game} (${j.steps.length} steps so far).`;
    const how = j.status === "done" ? `finished: ${(j.summary ?? "").slice(0, 300)}` : j.status === "failed" ? `stopped with a problem: ${j.error ?? ""}` : "was stopped by the player";
    return `Your mod builder's last build ("${j.request}" for ${j.game}) ${how}`;
  };

  const statusNote = (): string => {
    const game = games.state();
    const attached = game.attached;
    return [
      attached
        ? `Attached to ${attached.name} (pid ${attached.pid}${attached.title ? `, "${attached.title}"` : ""}).`
        : game.supported.ok
          ? "Not attached to a game."
          : game.supported.reason!,
      screen.active ? "The player is sharing their screen; look_at_screen works." : "Screen sharing is off.",
      attached && games.profile ? describeProfile(games.profile) : "",
      attached ? (themes.hasSaved() ? "The overlay is already styled for this game." : "The overlay isn't styled for this game yet.") : "",
      adapters.describe(),
      links.describe(),
      buildNote(),
      attached && games.profile
        ? `Mod support: ${engineModSupport(games.profile.engine, connectedBridge(games.profile, adapters) !== null).note}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const tools = [
    ...memoryTools(games, () => ({
      screen_shared: screen.active,
      overlay_styled_for_this_game: themes.hasSaved(),
      adapters: adapters.describe(),
    })),
    ...gameFileTools(games, path.join(dataDir, "backups")),
    ...unityBridgeTools(games, adapters, {
      bridgeDll: path.join(opts.root, "bridge", "ScruffBridge.dll"),
      il2cppBridgeDll: path.join(opts.root, "bridge", "TelosBridge.IL2CPP.dll"),
      port: opts.port,
    }),
    ...unrealBridgeTools(games, adapters, {
      bridgeDll: path.join(opts.root, "bridge-unreal", "TelosBridgeUE.dll"),
      ue4ssMod: path.join(opts.root, "bridge-ue4ss", "TelosBridge"),
      port: opts.port,
    }),
    ...rpgMakerBridgeTools(games, adapters, {
      pluginJs: path.join(opts.root, "bridge-rpgmaker", "TelosBridge.js"),
      port: opts.port,
    }),
    ...screen.tools(vision),
    themes.tool(),
    adapters.dispatchTool(),
    ...linkTools(links, games, adapters),
    ...modelFileTools(),
    ...moddingTools(knowledge, () => games.profile, { workshop: workshop.pluginReady }),
    ...workshopTools(workshop, () => games.profile),
    ...marketplaceTools(market, () => games.profile),
  ];

  const jev = new JevService(new JevSettings(path.join(dataDir, "typesafe.json")), opts.jev);
  const agent = new Agent({
    brain,
    tools,
    status: () => ({ note: statusNote(), events: adapters.drainEvents().map((e) => `${e.adapter}: ${e.text}`) }),
    quick: quickPath({
      jev: () => jev.current,
      games,
      tools,
      chatReady: () => opts.router?.describe().ready ?? true,
      report: (err) => jev.report(err),
      capture: () => screen.capture(),
      vision,
    }),
  });

  const dashboardUrl = `http://localhost:${opts.port}`;
  const mcp = new McpEndpoint({ tools, dashboardUrl });

  const server = await startServer({
    port: opts.port,
    host: opts.lan ? "0.0.0.0" : "127.0.0.1",
    token: opts.token,
    root: opts.root,
    dashboardDir: path.join(opts.root, "dashboard"),
    router: opts.router,
    dataDir,
    themes,
    jev,
    agent,
    games,
    adapters,
    links,
    screen,
    mcp,
    workshop,
    market,
    version: codeVersion(opts.root),
  });

  return {
    agent,
    jev,
    themes,
    games,
    adapters,
    links,
    screen,
    workshop,
    market,
    server,
    close() {
      agent.stop();
      workshop.close();
      links.close();
      ue4ssRelays.close();
      games.detach();
      server.closeAllConnections();
      server.close();
    },
  };
}

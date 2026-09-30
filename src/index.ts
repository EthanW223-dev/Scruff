import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "./hub/create.ts";
import { ModelRouter } from "./hub/models.ts";
import type { Effort } from "./hub/providers/anthropic.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

/** Starts the hub. Logs go to stderr so the MCP stdio bridge can run it in-process. */
export async function startTelos(options: { lan?: boolean; quiet?: boolean } = {}) {
  const port = Number(process.env.SCRUFF_PORT ?? 7777);
  const log = (line = "") => {
    if (!options.quiet) console.error(line);
  };
  const router = new ModelRouter(process.env, path.join(root, ".scruff", "settings.json"), (process.env.SCRUFF_EFFORT ?? "medium") as Effort);
  await router.init(process.env);
  const token = crypto.randomBytes(12).toString("base64url");

  const hub = await createHub({ root, port, lan: Boolean(options.lan), token, router });

  // Pidfile so the overlay can retire a stale hub after a code update instead
  // of silently reusing it (new dashboard talking to old hub = dead features).
  try {
    fs.mkdirSync(path.join(root, ".scruff"), { recursive: true });
    fs.writeFileSync(path.join(root, ".scruff", "hub.pid"), String(process.pid));
  } catch {
    // Best effort; the overlay just won't be able to retire us.
  }

  const ai = router.describe();
  log(`\n  Telos is running → http://localhost:${port}\n`);
  if (options.lan) {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i!.address);
    for (const ip of ips) log(`  From your phone:   http://${ip}:${port}/?token=${token}`);
    log();
  }
  log(`  AI: ${ai.providerLabel} · ${ai.model || "(no model picked)"}${ai.problem ? `  ⚠ ${ai.problem}` : ""}`);
  log("  Change it in the dashboard's AI menu (local models via Ollama / LM Studio work too).");
  log(`  Use your Claude subscription instead: claude mcp add --transport http scruff http://localhost:${port}/mcp\n`);
  return hub;
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

// Run directly (npm start), not when imported by the MCP bridge.
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const hub = await startTelos({ lan: process.argv.includes("--lan") }).catch((err: NodeJS.ErrnoException) => {
    const port = process.env.SCRUFF_PORT ?? 7777;
    console.error(
      err.code === "EADDRINUSE"
        ? `Port ${port} is busy. Telos may already be running (Claude Desktop starts it too): open http://localhost:${port}`
        : err,
    );
    process.exit(1);
  });
  const shutdown = () => {
    // Frozen values stop being held; one-off changes stay in the game.
    hub.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

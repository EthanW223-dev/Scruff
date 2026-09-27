import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sdkStreamFactory, type AgentOptions } from "./hub/agent.ts";
import { createHub } from "./hub/create.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const lan = process.argv.includes("--lan");
const port = Number(process.env.SCRUFF_PORT ?? 7777);
const model = process.env.SCRUFF_MODEL ?? "claude-opus-5";
const effort = (process.env.SCRUFF_EFFORT ?? "medium") as AgentOptions["effort"];
const keyFound = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const token = crypto.randomBytes(12).toString("base64url");

const hub = await createHub({
  root,
  port,
  lan,
  token,
  model,
  effort,
  keyFound,
  createStream: sdkStreamFactory(new Anthropic()),
}).catch((err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is busy. Is Scruff already running? (Set SCRUFF_PORT to use another.)` : err);
  process.exit(1);
});

console.log(`\n  Scruff is running → http://localhost:${port}\n`);
if (lan) {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  for (const ip of ips) console.log(`  From your phone:   http://${ip}:${port}/?token=${token}`);
  console.log();
}
if (!keyFound) {
  console.log("  No ANTHROPIC_API_KEY found. Put it in a .env file next to package.json (see .env.example).\n");
}
console.log(`  Model: ${model} (effort ${effort}). Game adapters connect to ws://localhost:${port}/ws/adapter\n`);

const shutdown = () => {
  // Frozen values stop being held; one-off changes stay in the game.
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

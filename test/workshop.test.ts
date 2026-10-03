import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { buildProfile } from "../src/games/profile.ts";
import type { AgentEvent } from "../src/hub/agent.ts";
import { createHub } from "../src/hub/create.ts";
import { ModderKnowledge, moddingTools } from "../src/hub/modder.ts";
import { Workshop, describeTool, workshopTools, type BuilderChoice, type WorkshopJob } from "../src/hub/workshop.ts";
import { builderTools } from "../src/hub/buildtools.ts";
import { fakeModel, lastToolResult, text, toolUse } from "./fake-model.ts";
// @ts-ignore: plain JS test fixture
import { startMockApi } from "./fixtures/claude-code/mock-api.mjs";

// universal-modder inside Telos: its playbooks for every AI (modding_guide), and the Workshop,
// where Claude Code with universal-modder loaded builds real mods once the player says so.

const root = path.resolve(import.meta.dirname, "..");
const PLUGIN = path.join(root, "vendor", "universal-modder");
const FAKE = path.join(root, "test", "fixtures", "claude-code", "fake-claude.mjs");
const ctx = { signal: new AbortController().signal, progress() {} };

function fakeCommand(dir: string): string {
  if (process.platform !== "win32") return FAKE;
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, `@"${process.execPath}" "${FAKE}" %*\r\n`);
  return shim;
}

/** A fake Unity game on disk, and its profile. */
function game(name = "Test Game", exe = `${name}.exe`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-ws-test-"));
  const install = path.join(dir, name);
  fs.mkdirSync(path.join(install, `${path.parse(exe).name}_Data`, "Managed"), { recursive: true });
  fs.writeFileSync(path.join(install, "UnityPlayer.dll"), "");
  fs.writeFileSync(path.join(install, `${path.parse(exe).name}_Data`, "Managed", "Assembly-CSharp.dll"), "");
  fs.writeFileSync(path.join(install, exe), "MZ");
  return { dir, profile: buildProfile(path.join(install, exe), { home: dir, appData: dir, localAppData: dir }) };
}

function workshop(mode = "ok", stepMs = 5) {
  const { dir, profile } = game();
  const log = path.join(dir, "calls.jsonl");
  const ws = new Workshop({
    dataDir: dir,
    pluginDir: PLUGIN,
    mcpUrl: "http://127.0.0.1:7777/mcp",
    home: dir,
    builder: () => ({
      kind: "claude-code",
      label: "Claude Code",
      launch: { command: fakeCommand(dir), env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STEP_MS: String(stepMs) } },
    }),
  });
  const notices: string[] = [];
  ws.on("notice", (t: string) => notices.push(t));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { ws, profile, dir, notices, calls };
}

const settled = (job: WorkshopJob, timeout = 20_000) =>
  new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (job.status !== "running" && job.status !== "proposed") {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(iv);
        reject(new Error(`still ${job.status}`));
      }
    }, 20);
  });
const argAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("universal-modder is bundled with its license and the version it came from", () => {
  for (const f of ["LICENSE", "VENDORED.md", "skills/mod-any-game/SKILL.md", "knowledge/index.json", "bin/um", ".claude-plugin/plugin.json"]) {
    assert.ok(fs.existsSync(path.join(PLUGIN, f)), f);
  }
  assert.match(fs.readFileSync(path.join(PLUGIN, "LICENSE"), "utf8"), /MIT License/);
  assert.match(new ModderKnowledge(PLUGIN).source, /universal-modder \([0-9a-f]{7}\)/);
});

test("modding_guide: the attached game's engine playbook, its field notes, searches, and nothing outside the bundle", async () => {
  const knowledge = new ModderKnowledge(PLUGIN);
  let profile: any = { name: "Terraria", engine: "Unknown", installDir: "/nowhere" };
  const [tool] = moddingTools(knowledge, () => profile, { workshop: true });

  const guide = String(await tool.run({}, ctx));
  assert.match(guide, /Terraria \(Unknown\): universal-modder's playbook, dotnet-xna/);
  assert.match(guide, /tModLoader/);
  assert.match(guide, /Field notes about Terraria[\s\S]*Fal Arsenal[\s\S]*open: knowledge\/games\/terraria\/fal-arsenal-tmodloader\.md/);
  assert.match(guide, /build_mod/);

  // Engines Telos detects map to their playbooks; big franchises by name.
  assert.equal(knowledge.playbookFor({ name: "Schedule I", engine: "Unity (IL2CPP)", installDir: "/x" }), "unity.md");
  assert.equal(knowledge.playbookFor({ name: "Hollow Game", engine: "Unreal Engine", installDir: "/x" }), "unreal.md");
  assert.equal(knowledge.playbookFor({ name: "Some RPG", engine: "RPG Maker MV/MZ", installDir: "/x" }), "misc-engines.md");
  assert.equal(knowledge.playbookFor({ name: "Grand Theft Auto V", engine: "Unknown", installDir: "/x" }), "big-frameworks.md");
  assert.equal(knowledge.playbookFor({ name: "Skyrim Special Edition", engine: "Unknown", installDir: "/x" }), "bethesda.md");
  assert.equal(knowledge.playbookFor({ name: "Mystery", engine: "Unknown", installDir: "/x" }), "native.md");

  const q = String(await tool.run({ query: "homing missile sprites" }, ctx));
  assert.match(q, /Matches for "homing missile sprites"[\s\S]*fal-arsenal-tmodloader\.md/);
  const opened = String(await tool.run({ open: "fal-assets" }, ctx));
  assert.match(opened, /^skills\/fal-assets\/SKILL\.md/);
  assert.match(String(await tool.run({ open: "unity" }, ctx)), /BepInEx/);
  await assert.rejects(async () => tool.run({ open: "../../package.json" }, ctx), /No playbook/);
  await assert.rejects(async () => tool.run({ open: "../LICENSE" }, ctx), /No playbook/);

  profile = null;
  assert.match(String(await tool.run({}, ctx)), /No game attached\. Engine playbooks: .*unity.*unreal/);
});

test("the AI can only propose a build; it starts when the player says so, with universal-modder loaded", async () => {
  const { ws, profile, notices, calls } = workshop();
  const job = ws.propose(profile, "Add a homing missile launcher", { by: "ai" });
  assert.equal(job.status, "proposed");
  assert.match(notices[0], /wants to build a mod for Test Game.*Workshop window/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls().length, 0, "nothing runs before the player's OK");

  ws.approve(job.id);
  assert.equal(job.status, "running");
  await settled(job);
  assert.equal(job.status, "done", job.error);
  assert.match(job.summary ?? "", /Built MissileLauncher/);
  assert.deepEqual(
    job.steps.filter((s) => s.kind === "tool").map((s) => s.text),
    ["skill universal-modder:mod-any-game", '$ um scan "Test Game"', "write Plugin.cs", "$ dotnet build MissileLauncher -c Release", "telos look at screen"],
  );
  assert.ok(notices.some((n) => /the Test Game mod is built\. Built MissileLauncher/.test(n)));
  assert.ok(fs.existsSync(path.join(job.folder, `telos-build-${job.id}.log`)), "a log of the build next to it");

  const [call] = calls();
  assert.equal(argAfter(call.args, "--plugin-dir"), PLUGIN);
  assert.equal(argAfter(call.args, "--permission-mode"), "acceptEdits");
  assert.match(argAfter(call.args, "--allowedTools") ?? "", /Bash.*Write.*Edit.*Skill.*mcp__telos/);
  assert.ok(call.args.includes("--strict-mcp-config"));
  const addDirs = call.args.flatMap((a: string, i: number) => (call.args[i - 1] === "--add-dir" ? [a] : []));
  assert.ok(addDirs.includes(profile.installDir), "it can work in the game's folder");
  assert.match(argAfter(call.args, "--append-system-prompt") ?? "", /mod workshop of Telos.*approved this build/);
  const config = JSON.parse(fs.readFileSync(argAfter(call.args, "--mcp-config")!, "utf8"));
  assert.deepEqual(config.mcpServers.telos.headers, { "x-telos-chat": "workshop" });
  assert.equal(call.cwd, job.folder);
  const prompt = JSON.parse(call.stdin).message.content as string;
  assert.match(prompt, /Mod request from the player: Add a homing missile launcher/);
  assert.match(prompt, /Game: Test Game \(Unity \(Mono\)\)/);

  // "Make it bigger" carries on in the same Claude Code session.
  const more = ws.propose(profile, "Make the missiles faster", { by: "player", continues: true });
  assert.equal(more.status, "running", "the player's own request is their go-ahead");
  await settled(more);
  assert.match(argAfter(calls()[1].args, "--resume") ?? "", /^sess-\d+$/);
  assert.match(JSON.parse(calls()[1].stdin).message.content, /continues your earlier work/);
});

test("one build at a time, a new proposal replaces a waiting one, online games are refused", async () => {
  const { ws, profile } = workshop("ok", 400);
  const first = ws.propose(profile, "mod one", { by: "ai" });
  const second = ws.propose(profile, "mod two", { by: "ai" });
  assert.equal(first.status, "declined");
  assert.equal(ws.current, second);
  ws.approve(second.id);
  assert.throws(() => ws.propose(profile, "mod three", { by: "player" }), /still building "mod two"/);
  ws.stop(second.id);
  await settled(second);
  assert.equal(second.status, "stopped");

  const online = game("Grand Theft Auto V", "GTA5.exe").profile;
  assert.throws(() => ws.propose(online, "flying cars", { by: "player" }), /online game with anti-cheat/);
  assert.throws(() => ws.propose(profile, "   ", { by: "player" }), /Say what the mod should do/);
});

test("a failed build says why", async () => {
  const { ws, profile, notices } = workshop("build-fails");
  const job = ws.propose(profile, "a nuke", { by: "player" });
  await settled(job);
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /dotnet: command not found/);
  assert.ok(notices.some((n) => /stopped with a problem/.test(n)));
});

test("the chat AI's Workshop tools", async () => {
  const { ws, profile } = workshop("ok", 300);
  let attached: any = null;
  const tools = Object.fromEntries(workshopTools(ws, () => attached).map((t) => [t.name, t]));
  await assert.rejects(async () => tools.build_mod.run({ request: "a sword" }, ctx), /Attach to the game first/);
  attached = profile;
  const proposed = JSON.parse(String(await tools.build_mod.run({ request: "a laser sword" }, ctx)));
  assert.equal(proposed.proposed.status, "proposed");
  assert.match(proposed.next, /press Build in the Workshop window/);
  assert.match(String(await tools.workshop_status.run({}, ctx)), /"status": "proposed"/);
  assert.match(String(await tools.stop_mod_build.run({}, ctx)), /Dropped the proposed build/);
  assert.match(String(await tools.stop_mod_build.run({}, ctx)), /Nothing is being built/);
});

test("Claude Code's steps read as plain lines in the overlay", () => {
  assert.equal(describeTool("Bash", { command: "dotnet build\nmore" }), "$ dotnet build");
  assert.equal(describeTool("Edit", { file_path: "C:\\mods\\Weapons.cs" }).replace(/.*[\\/]/, "edit "), "edit Weapons.cs");
  assert.equal(describeTool("mcp__telos__look_at_screen", {}), "telos look at screen");
  assert.equal(describeTool("mcp__fal__run_model", {}), "fal run model");
  assert.equal(describeTool("TodoWrite", { todos: [{ status: "in_progress", activeForm: "Drawing sprites" }] }), "plan: Drawing sprites");
});

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return p;
}

test("in the hub: the overlay's Build button runs it, its state reaches the overlay, and its tool calls stay out of the chat", async () => {
  const { dir, profile } = game();
  const port = await freePort();
  const brain = { model: "unused", createStream: () => { throw new Error("unused"); } } as any;
  const hub = await createHub({
    root, port, lan: false, token: "t", brain, dataDir: dir, jev: null,
    workshopBuilder: () => ({ kind: "claude-code", label: "Claude Code", launch: { command: fakeCommand(dir), env: { ...process.env, FAKE_CLAUDE_STEP_MS: "5" } } }),
  });
  const clients: Client[] = [];
  try {
    hub.games.profile = profile;
    const names = (hub.agent as any).toolsByName as Map<string, unknown>;
    for (const t of ["modding_guide", "build_mod", "workshop_status", "stop_mod_build"]) assert.ok(names.has(t), t);

    const dash = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    const states: any[] = [];
    dash.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "state") states.push(m);
    });
    await new Promise((r) => dash.once("open", r));
    dash.send(JSON.stringify({ type: "workshop_build", request: "Add a homing missile launcher" }));
    const deadline = Date.now() + 20_000;
    while (!states.some((s) => s.workshop?.job?.status === "done") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const done = states.find((s) => s.workshop?.job?.status === "done");
    assert.ok(done, `states: ${JSON.stringify(states.map((s) => s.workshop?.job?.status))}`);
    assert.equal(done.workshop.available, true);
    assert.match(done.workshop.job.summary, /Built MissileLauncher/);
    dash.close();

    // MCP calls from the Workshop's builder aren't the chat's; the chat's own aren't "your Claude app".
    const events: AgentEvent[] = [];
    const call = async (header: string) => {
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { "x-telos-chat": header } } }));
      clients.push(client);
      await client.callTool({ name: "game_status", arguments: {} });
    };
    const dash2 = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    dash2.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "agent") events.push(m.event);
    });
    await new Promise((r) => dash2.once("open", r));
    await call("workshop");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events.length, 0, "the builder's own calls stay in its log");
    await call("1");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.some((e) => e.type === "tool_call" && e.name === "game_status"));
    assert.ok(!events.some((e) => e.type === "notice"));
    dash2.close();
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    hub.close();
  }
});

function realClaude(): boolean {
  try {
    return /Claude Code/.test(execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

test("with the real claude: universal-modder loads as a plugin and the builder works without stopping to ask", { skip: !realClaude() && "claude isn't installed here", timeout: 120_000 }, async () => {
  const api = await startMockApi();
  const { dir, profile } = game();
  const ws = new Workshop({
    dataDir: dir,
    pluginDir: PLUGIN,
    mcpUrl: "http://127.0.0.1:9/mcp",
    home: dir,
    builder: () => ({
      kind: "claude-code",
      label: "Claude Code",
      launch: {
        command: "claude",
        // A stand-in API and a throwaway config: no real model, no real account touched.
        env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "sk-test-key", CLAUDE_CONFIG_DIR: path.join(dir, "cfg"), DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      },
    }),
  });
  try {
    const job = ws.propose(profile, "Add a homing missile launcher", { by: "player" });
    await settled(job, 90_000);
    assert.equal(job.status, "done", job.error);
    assert.ok(fs.existsSync(path.join(job.folder, "built-mod.txt")), "its command ran, in the Workshop folder, without a permission prompt");
    assert.deepEqual(job.steps.map((s) => s.text)[0], "$ echo built > built-mod.txt");
    assert.match(job.summary ?? "", /Built a test mod/);
    const sent = api.requests.find((r: any) => r.method === "POST" && r.body.tools);
    assert.match(JSON.stringify(sent.body), /mod-any-game/, "universal-modder's skills are offered");
    assert.match(JSON.stringify(sent.body.system), /mod workshop of Telos/);
  } finally {
    ws.close();
    api.server.close();
  }
});

// ---- the chat's own AI as the builder (any provider other than Claude Code) ----

function chatWorkshop(policy: Parameters<typeof fakeModel>[0], extra: Partial<Extract<BuilderChoice, { kind: "chat" }>> = {}) {
  const { dir, profile } = game();
  const model = fakeModel(policy);
  const ws = new Workshop({
    dataDir: dir,
    pluginDir: PLUGIN,
    mcpUrl: "http://127.0.0.1:9/mcp",
    home: dir,
    builder: () => ({ kind: "chat", label: "Ollama · qwen3:8b", brain: { model: "qwen3:8b", createStream: model.factory }, ready: true, ...extra }),
    describeBuilder: () => ({ label: "Ollama · qwen3:8b", ready: true }),
    extraTools: () => moddingTools(new ModderKnowledge(PLUGIN), () => profile, { workshop: true }),
  });
  return { ws, profile, dir, model };
}

test("the chat AI builds with Telos's builder tools and universal-modder's loop, inside the build's folders", async () => {
  const outside = path.join(os.tmpdir(), `telos-outside-${process.pid}.txt`);
  const { ws, profile, model } = chatWorkshop((params) => {
    const last = lastToolResult(params);
    if (!last) return { content: [text("Reading the playbook first."), toolUse("modding_guide", {})] };
    if (last.name === "modding_guide") return { content: [toolUse("run_command", { command: "echo built > built.txt" })] };
    if (last.name === "run_command") return { content: [toolUse("write_file", { path: "MissileMod/Plugin.cs", content: "class MissileMod {}" })] };
    if (last.name === "write_file" && !last.isError) return { content: [toolUse("write_file", { path: outside, content: "nope" })] };
    return { content: [text("Built MissileMod in the workshop folder. Copy it into BepInEx/plugins and start the game.")] };
  });
  const job = ws.propose(profile, "Add a homing missile launcher", { by: "player" });
  await settled(job);
  assert.equal(job.status, "done", job.error);
  assert.equal(job.builder, "Ollama · qwen3:8b");
  assert.match(job.summary ?? "", /^Built MissileMod/);
  assert.ok(fs.existsSync(path.join(job.folder, "built.txt")), "its command ran in the build folder");
  assert.equal(fs.readFileSync(path.join(job.folder, "MissileMod", "Plugin.cs"), "utf8"), "class MissileMod {}");
  assert.ok(!fs.existsSync(outside), "nothing written outside the build's folders");
  const steps = job.steps.map((s) => s.text);
  assert.ok(steps.includes("Reading the playbook first."));
  assert.ok(steps.includes("guide"));
  assert.ok(steps.includes("$ echo built > built.txt"));
  assert.ok(steps.includes("write Plugin.cs"));
  assert.ok(steps.some((t) => /↳ .*outside the folders this build may change/.test(t)), "the refusal shows in the log");

  const first = model.calls[0];
  const system = String(first.system);
  assert.match(system, /mod workshop of Telos/);
  assert.match(system, /universal-modder's loop \(mod-any-game\)[\s\S]*## The loop/);
  assert.match(system, /python -m um/);
  const names = (first.tools ?? []).map((t: any) => t.name);
  for (const n of ["run_command", "read_file", "write_file", "edit_file", "list_files", "search_files", "fetch_url", "download_file", "modding_guide"]) assert.ok(names.includes(n), n);
  assert.match(JSON.stringify(first.messages[0]), /Mod request from the player: Add a homing missile launcher/);

  // "Now make them faster" continues the same conversation.
  const more = ws.propose(profile, "Make the missiles faster", { by: "player", continues: true });
  await settled(more);
  assert.equal(more.status, "done");
  const resumed = model.calls.find((c) => JSON.stringify(c.messages.at(-1)).includes("Make the missiles faster"))!;
  assert.ok(resumed.messages.length > 2, "it remembers the first build");
  assert.match(JSON.stringify(resumed.messages.at(-1)), /continues your earlier work/);
});

test("the chat AI's build stops on Stop, and won't start without a working AI", async () => {
  const { ws, profile } = chatWorkshop(() => ({ content: [toolUse("run_command", { command: process.platform === "win32" ? "Start-Sleep 30" : "sleep 30" })] }));
  const job = ws.propose(profile, "a nuke", { by: "player" });
  await new Promise((r) => setTimeout(r, 400));
  ws.stop(job.id);
  await settled(job, 10_000);
  assert.equal(job.status, "stopped");

  const broken = chatWorkshop(() => ({ content: [text("unused")] }), { ready: false, problem: "Ollama isn't running" });
  const j2 = broken.ws.propose(broken.profile, "a sword", { by: "player" });
  await settled(j2);
  assert.equal(j2.status, "failed");
  assert.match(j2.error ?? "", /Ollama isn't running.*AI menu/);
});

test("builder tools: files only inside the build's folders, universal-modder readable, careful edits, commands with a time limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telos-bt-"));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  const tools = Object.fromEntries(builderTools({ cwd: work, roots: [work], readOnlyRoots: [PLUGIN], env: process.env, pluginDir: PLUGIN }).map((t) => [t.name, t]));
  const run = (name: string, input: unknown) => tools[name].run(input, ctx).then(String);

  assert.match(await run("write_file", { path: "src/a.txt", content: "one\ntwo\ntwo\n" }), /Wrote .*a\.txt/);
  assert.match(await run("read_file", { path: "src/a.txt" }), /lines 1-4 of 4\)\n {4}1  one\n {4}2  two/);
  await assert.rejects(run("edit_file", { path: "src/a.txt", old_text: "two", new_text: "2" }), /appears 2 times/);
  assert.match(await run("edit_file", { path: "src/a.txt", old_text: "one", new_text: "1" }), /1 place/);
  assert.match(await run("edit_file", { path: "src/a.txt", old_text: "two", new_text: "2", replace_all: true }), /2 places/);
  assert.equal(fs.readFileSync(path.join(work, "src", "a.txt"), "utf8"), "1\n2\n2\n");
  assert.match(await run("list_files", {}), /src\/\nsrc\/a\.txt/);
  assert.match(await run("search_files", { pattern: "^2$", file_glob: "*.txt" }), /src\/a\.txt:2: 2/);

  // universal-modder can be read, not changed; the rest of the disk neither.
  assert.match(await run("read_file", { path: path.join(PLUGIN, "skills", "mod-any-game", "SKILL.md"), max_lines: 3 }), /name: mod-any-game/);
  await assert.rejects(run("write_file", { path: path.join(PLUGIN, "x.txt"), content: "x" }), /outside the folders this build may change/);
  await assert.rejects(run("read_file", { path: path.join(root, "..", "elsewhere.txt") }), /outside the folders this build may read/);
  await assert.rejects(run("write_file", { path: "../escape.txt", content: "x" }), /outside/);

  assert.match(await run("run_command", { command: "echo hi" }), /^exit code 0\nhi/);
  assert.match(await run("run_command", { command: "exit 3" }), /^exit code 3/);
  if (process.platform !== "win32") {
    const started = Date.now();
    assert.match(await run("run_command", { command: "sleep 20", timeout_seconds: 5 }), /^timed out after 5 s/);
    assert.ok(Date.now() - started < 12_000);
    // universal-modder's CLI is importable as `python -m um` from the build's commands.
    if (/exit code 0/.test(await run("run_command", { command: "command -v python3" }))) {
      assert.match(await run("run_command", { command: "python3 -c 'import um; print(\"um-ok\")'" }), /^exit code 0\num-ok/);
    }
  }
});

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, type HubTool } from "./tools.ts";

/**
 * The Workshop's hands when the chat AI builds a mod (any AI in the AI menu other than Claude
 * Code, which brings its own): a shell, files and the web. Files can only be written inside the
 * build's folders (its workshop folder and the game's folders) and read there or in
 * universal-modder. Commands run as the player, like any build tool; the player approved the
 * build before any of this runs.
 */

export interface BuilderToolOptions {
  /** The build's working folder. */
  cwd: string;
  /** Folders the builder may write in (and read). */
  roots: string[];
  /** Folders it may only read (universal-modder). */
  readOnlyRoots: string[];
  /** Commands' environment. */
  env: NodeJS.ProcessEnv;
  /** universal-modder: its CLI runs as `python -m um` from here. */
  pluginDir: string;
}

const OUTPUT_TAIL = 14_000;
const READ_LINES = 400;
const FETCH_CHARS = 30_000;
const MAX_DOWNLOAD = 500 * 1024 * 1024;

const win = process.platform === "win32";
const same = (a: string) => (win ? a.toLowerCase() : a);

/** The shell commands run in, and how the builder is told about it. */
export const SHELL = win ? "PowerShell" : fs.existsSync("/bin/bash") ? "bash" : "sh";

export function builderTools(o: BuilderToolOptions): HubTool[] {
  const inside = (full: string, roots: string[]) =>
    roots.some((r) => {
      const root = same(path.resolve(r));
      const f = same(full);
      return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    });
  const resolve = (p: string, write: boolean) => {
    const full = path.resolve(o.cwd, p);
    if (inside(full, o.roots)) return full;
    if (!write && inside(full, o.readOnlyRoots)) return full;
    throw new Error(
      `${full} is outside the folders this build may ${write ? "change" : "read"}: ${[...o.roots, ...(write ? [] : o.readOnlyRoots)].join(", ")}.`,
    );
  };
  const env = () => ({
    ...o.env,
    PATH: [path.join(o.pluginDir, "bin"), o.env.PATH ?? o.env.Path ?? ""].join(path.delimiter),
    PYTHONPATH: [o.pluginDir, o.env.PYTHONPATH ?? ""].filter(Boolean).join(path.delimiter),
    // universal-modder is bundled read-only: no bytecode caches written into it.
    PYTHONDONTWRITEBYTECODE: "1",
  });

  return [
    defineTool({
      name: "run_command",
      description:
        `Run a ${SHELL} command and get its exit code and output (the last ${OUTPUT_TAIL / 1000}k characters). ` +
        `Starts in the build folder (${o.cwd}). Use it to build (dotnet build, gradle, …), unzip, run universal-modder's CLI ` +
        "(python -m um scan \"<game>\", python -m um kb search \"<game>\", python -m um backup …; needs Python 3.10+), and check " +
        "your work. Not for launching the game or anything that waits for input.",
      input: z.object({
        command: z.string().describe(`The ${SHELL} command`),
        timeout_seconds: z.number().int().min(5).max(1800).optional().describe("Default 180; builds can take longer"),
        cwd: z.string().optional().describe("Where to run it (inside the build's folders)"),
      }),
      run({ command, timeout_seconds, cwd }, ctx) {
        const dir = cwd ? resolve(cwd, true) : o.cwd;
        fs.mkdirSync(dir, { recursive: true });
        const [exe, args] = win
          ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]]
          : [SHELL === "bash" ? "/bin/bash" : "/bin/sh", ["-c", command]];
        return new Promise((done) => {
          let out = "";
          const child = spawn(exe, args, { cwd: dir, env: env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          const keep = (c: Buffer) => {
            out = (out + c.toString("utf8")).slice(-OUTPUT_TAIL * 2);
            ctx.progress(out.trimEnd().split(/\r?\n/).pop()?.slice(0, 120) ?? "");
          };
          child.stdout.on("data", keep);
          child.stderr.on("data", keep);
          let why = "";
          const kill = (reason: string) => {
            why = reason;
            if (win && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
            else child.kill("SIGKILL");
          };
          const timer = setTimeout(() => kill(`timed out after ${timeout_seconds ?? 180} s`), (timeout_seconds ?? 180) * 1000);
          const onAbort = () => kill("stopped");
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          const finish = (head: string) => {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
            const tail = out.length > OUTPUT_TAIL ? `…${out.slice(-OUTPUT_TAIL)}` : out;
            done(`${head}\n${tail.trimEnd() || "(no output)"}`);
          };
          child.on("error", (err) => finish(`couldn't run it: ${err.message}`));
          child.on("close", (code) => finish(why ? `${why}` : `exit code ${code}`));
        });
      },
    }),
    defineTool({
      name: "read_file",
      description: `Read a text file (${READ_LINES} lines at a time, numbered). Works in the build's folders and in universal-modder's.`,
      input: z.object({
        path: z.string(),
        start_line: z.number().int().min(1).optional(),
        max_lines: z.number().int().min(1).max(2000).optional(),
      }),
      readOnly: true,
      run({ path: p, start_line, max_lines }) {
        const full = resolve(p, false);
        const buf = fs.readFileSync(full);
        if (buf.subarray(0, 8000).includes(0)) return `${full} is a binary file (${buf.length.toLocaleString()} bytes).`;
        const lines = buf.toString("utf8").split(/\r?\n/);
        const from = (start_line ?? 1) - 1;
        const slice = lines.slice(from, from + (max_lines ?? READ_LINES));
        const body = slice.map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join("\n");
        const more = from + slice.length < lines.length ? `\n… ${lines.length - from - slice.length} more lines (start_line ${from + slice.length + 1})` : "";
        return `${full} (lines ${from + 1}-${from + slice.length} of ${lines.length})\n${body}${more}`;
      },
    }),
    defineTool({
      name: "write_file",
      description: "Create or overwrite a file (folders are made as needed). Only inside the build's folders.",
      input: z.object({ path: z.string(), content: z.string() }),
      run({ path: p, content }) {
        const full = resolve(p, true);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return `Wrote ${full} (${Buffer.byteLength(content)} bytes).`;
      },
    }),
    defineTool({
      name: "edit_file",
      description: "Replace exact text in a file. old_text must appear exactly once (or set replace_all).",
      input: z.object({ path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional() }),
      run({ path: p, old_text, new_text, replace_all }) {
        const full = resolve(p, true);
        const text = fs.readFileSync(full, "utf8");
        const count = old_text ? text.split(old_text).length - 1 : 0;
        if (!count) throw new Error(`old_text isn't in ${full}. Read the file again and copy the text exactly.`);
        if (count > 1 && !replace_all) throw new Error(`old_text appears ${count} times in ${full}: include more of the surrounding text, or set replace_all.`);
        fs.writeFileSync(full, replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text));
        return `Edited ${full} (${replace_all ? count : 1} place${(replace_all ? count : 1) === 1 ? "" : "s"}).`;
      },
    }),
    defineTool({
      name: "list_files",
      description: "List a folder (and its subfolders, to a depth). Folders end with /.",
      input: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(4).optional() }),
      readOnly: true,
      run({ path: p, depth }) {
        const full = resolve(p ?? ".", false);
        const out: string[] = [];
        const walk = (dir: string, level: number) => {
          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          } catch (err) {
            out.push(`${path.relative(full, dir) || "."}: ${(err as Error).message}`);
            return;
          }
          for (const e of entries) {
            if (out.length >= 400) return;
            const rel = path.relative(full, path.join(dir, e.name)).replace(/\\/g, "/");
            if (e.isDirectory()) {
              out.push(`${rel}/`);
              if (level < (depth ?? 2)) walk(path.join(dir, e.name), level + 1);
            } else {
              out.push(rel);
            }
          }
        };
        walk(full, 1);
        return `${full}\n${out.join("\n") || "(empty)"}${out.length >= 400 ? "\n… (more)" : ""}`;
      },
    }),
    defineTool({
      name: "search_files",
      description: "Find lines matching a regular expression in a folder's text files (file:line: text, up to 100 hits).",
      input: z.object({
        pattern: z.string().describe("A regular expression"),
        path: z.string().optional(),
        file_glob: z.string().optional().describe("Only files like this, e.g. *.cs or *.json"),
      }),
      readOnly: true,
      run({ pattern, path: p, file_glob }) {
        const full = resolve(p ?? ".", false);
        const re = new RegExp(pattern, "i");
        const glob = file_glob ? new RegExp(`^${file_glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i") : null;
        const hits: string[] = [];
        let files = 0;
        const walk = (dir: string, depth: number) => {
          if (depth > 8 || hits.length >= 100 || files > 5000) return;
          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (!/^(\.git|node_modules|obj|bin|\.venv)$/.test(e.name)) walk(f, depth + 1);
              continue;
            }
            if (glob && !glob.test(e.name)) continue;
            files++;
            let buf: Buffer;
            try {
              if (fs.statSync(f).size > 2_000_000) continue;
              buf = fs.readFileSync(f);
            } catch {
              continue;
            }
            if (buf.subarray(0, 8000).includes(0)) continue;
            buf
              .toString("utf8")
              .split(/\r?\n/)
              .forEach((line, i) => {
                if (hits.length < 100 && re.test(line)) hits.push(`${path.relative(full, f).replace(/\\/g, "/")}:${i + 1}: ${line.trim().slice(0, 200)}`);
              });
          }
        };
        walk(full, 0);
        return hits.length ? hits.join("\n") + (hits.length >= 100 ? "\n… (more)" : "") : `No matches for /${pattern}/ in ${full}.`;
      },
    }),
    defineTool({
      name: "fetch_url",
      description: "Read a web page or API (text, HTML turned into text, up to 30k characters): mod loader docs, release pages, wikis.",
      input: z.object({ url: z.string().url() }),
      readOnly: true,
      async run({ url }, ctx) {
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) pages.");
        const res = await fetch(url, { headers: { "User-Agent": "Telos Workshop" }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
        let text = await res.text();
        if (/html/i.test(res.headers.get("content-type") ?? "")) {
          text = text
            .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s*\n+/g, "\n\n");
        }
        return `${res.status} ${url}\n${text.trim().slice(0, FETCH_CHARS)}${text.length > FETCH_CHARS ? "\n…" : ""}`;
      },
    }),
    defineTool({
      name: "download_file",
      description: "Download a file (a mod loader zip, a library, a release) into the build's folders.",
      input: z.object({ url: z.string().url(), to: z.string().describe("Where to save it, e.g. downloads/BepInEx.zip") }),
      async run({ url, to }, ctx) {
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) downloads.");
        const full = resolve(to, true);
        const res = await fetch(url, { headers: { "User-Agent": "Telos Workshop" }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15 * 60_000)]) });
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_DOWNLOAD) throw new Error("That download is too big (over 500 MB).");
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buf);
        return `Saved ${full} (${buf.length.toLocaleString()} bytes).`;
      },
    }),
  ];
}

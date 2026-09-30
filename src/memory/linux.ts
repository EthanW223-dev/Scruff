import fs from "node:fs";
import type { ProcessBackend, ProcessInfo, Region } from "./types.ts";

/** Pseudo-mappings that can't or shouldn't be touched. */
const SKIP_PATHS = ["[vvar]", "[vvar_vclock]", "[vsyscall]", "[vdso]"];

export class LinuxBackend implements ProcessBackend {
  private fd: number;

  constructor(readonly pid: number) {
    try {
      this.fd = fs.openSync(`/proc/${pid}/mem`, "r+");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Permission denied opening process ${pid}. Run Telos with sudo, or allow it with ` +
            "`echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope`.",
        );
      }
      throw new Error(`Could not open process ${pid}: ${(err as Error).message}`);
    }
  }

  regions(): Region[] {
    const maps = fs.readFileSync(`/proc/${this.pid}/maps`, "utf8");
    const regions: Region[] = [];
    for (const line of maps.split("\n")) {
      if (!line) continue;
      const [range, perms, , , , ...rest] = line.split(/\s+/);
      const path = rest.join(" ");
      // Private, readable and writable: heap, stack, anonymous allocations, .data/.bss.
      if (perms[0] !== "r" || perms[1] !== "w" || perms[3] !== "p") continue;
      if (SKIP_PATHS.includes(path) || path.startsWith("/dev/")) continue;
      const [start, end] = range.split("-").map((h) => parseInt(h, 16));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue;
      regions.push({ base: start, size: end - start });
    }
    return regions.sort((a, b) => a.base - b.base);
  }

  read(address: number, buf: Buffer): number {
    try {
      return fs.readSync(this.fd, buf, 0, buf.length, address);
    } catch {
      return 0;
    }
  }

  write(address: number, buf: Buffer): boolean {
    try {
      return fs.writeSync(this.fd, buf, 0, buf.length, address) === buf.length;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}

export function listLinuxProcesses(): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  const myUid = process.getuid?.();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      if (myUid !== 0 && uid !== myUid) continue;
      const name = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (cmdline.length === 0) continue; // kernel threads
      // Some programs rewrite argv[0] to their whole command line ("chrome --type=renderer ...").
      const first = cmdline[0].split(" --")[0];
      const exe = first.split(/[\\/]/).pop()?.slice(0, 60) || name;
      let exePath: string | undefined;
      try {
        exePath = fs.readlinkSync(`/proc/${pid}/exe`);
      } catch {
        // not ours to read
      }
      out.push({ pid, name: exe, command: cmdline.join(" ").slice(0, 160), exe: exePath });
    } catch {
      // process exited or is not readable
    }
  }
  // Newest first: the game was probably started recently.
  return out.sort((a, b) => b.pid - a.pid);
}

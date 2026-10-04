import { splitWindowsCommandLine } from "./cmdline.ts";
import { LinuxBackend, linuxLaunch, listLinuxProcesses } from "./linux.ts";
import type { ProcessBackend, ProcessInfo } from "./types.ts";
import { WindowsBackend, listWindowsProcesses, windowsCommandLine } from "./windows.ts";

export function memorySupported(): { ok: boolean; reason?: string } {
  if (process.platform === "win32" || process.platform === "linux") return { ok: true };
  return { ok: false, reason: `Memory editing isn't supported on ${process.platform} yet (Windows and Linux only).` };
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") return listWindowsProcesses();
  if (process.platform === "linux") return listLinuxProcesses();
  return [];
}

/**
 * One process's arguments (and, on Linux, its working folder), for games whose exe is a shared
 * runtime. The arguments can hold secrets (a session token): read what's needed, never keep them.
 */
export async function processLaunch(pid: number): Promise<{ args?: string[]; cwd?: string }> {
  if (process.platform === "win32") {
    const line = await windowsCommandLine(pid);
    return line ? { args: splitWindowsCommandLine(line) } : {};
  }
  if (process.platform === "linux") return linuxLaunch(pid);
  return {};
}

export function openBackend(pid: number): ProcessBackend {
  if (process.platform === "win32") return new WindowsBackend(pid);
  if (process.platform === "linux") return new LinuxBackend(pid);
  throw new Error(memorySupported().reason);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

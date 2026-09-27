import { LinuxBackend, listLinuxProcesses } from "./linux.ts";
import type { ProcessBackend, ProcessInfo } from "./types.ts";
import { WindowsBackend, listWindowsProcesses } from "./windows.ts";

export function memorySupported(): { ok: boolean; reason?: string } {
  if (process.platform === "win32" || process.platform === "linux") return { ok: true };
  return { ok: false, reason: `Memory editing isn't supported on ${process.platform} yet (Windows and Linux only).` };
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") return listWindowsProcesses();
  if (process.platform === "linux") return listLinuxProcesses();
  return [];
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

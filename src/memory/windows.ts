import { execFile } from "node:child_process";
import { promisify } from "node:util";
import koffi from "koffi";
import type { ProcessBackend, ProcessInfo, Region } from "./types.ts";

const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_READ = 0x0010;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_QUERY_INFORMATION = 0x0400;

const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const MEM_IMAGE = 0x1000000;

const PAGE_GUARD = 0x100;
const PAGE_WRITABLE = 0x04 | 0x08 | 0x40 | 0x80; // READWRITE | WRITECOPY | EXECUTE_READWRITE | EXECUTE_WRITECOPY

/** sizeof(MEMORY_BASIC_INFORMATION) on 64-bit Windows. */
const MBI_SIZE = 48;
const USER_SPACE_END = 0x7fff_ffff_0000;

type Fn = (...args: unknown[]) => unknown;
interface Kernel32 {
  OpenProcess: Fn;
  CloseHandle: Fn;
  ReadProcessMemory: Fn;
  WriteProcessMemory: Fn;
  VirtualQueryEx: Fn;
}

let kernel32: Kernel32 | null = null;
function api(): Kernel32 {
  if (kernel32) return kernel32;
  const lib = koffi.load("kernel32.dll");
  kernel32 = {
    OpenProcess: lib.func("void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)"),
    CloseHandle: lib.func("int __stdcall CloseHandle(void *hObject)"),
    ReadProcessMemory: lib.func(
      "int __stdcall ReadProcessMemory(void *hProcess, uintptr_t lpBaseAddress, _Out_ uint8_t *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)",
    ),
    WriteProcessMemory: lib.func(
      "int __stdcall WriteProcessMemory(void *hProcess, uintptr_t lpBaseAddress, const uint8_t *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesWritten)",
    ),
    VirtualQueryEx: lib.func(
      "size_t __stdcall VirtualQueryEx(void *hProcess, uintptr_t lpAddress, _Out_ uint8_t *lpBuffer, size_t dwLength)",
    ),
  };
  return kernel32;
}

export class WindowsBackend implements ProcessBackend {
  private handle: unknown;

  constructor(readonly pid: number) {
    const k = api();
    this.handle = k.OpenProcess(
      PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
      0,
      pid,
    );
    if (!this.handle) {
      throw new Error(
        `Windows refused access to process ${pid}. Try running Telos as administrator; ` +
          "games protected by anti-cheat can't be opened at all.",
      );
    }
  }

  regions(): Region[] {
    const k = api();
    const mbi = Buffer.alloc(MBI_SIZE);
    const regions: Region[] = [];
    let address = 0;
    while (address < USER_SPACE_END) {
      if (!k.VirtualQueryEx(this.handle, address, mbi, MBI_SIZE)) break;
      const base = Number(mbi.readBigUInt64LE(0));
      const size = Number(mbi.readBigUInt64LE(24));
      const state = mbi.readUInt32LE(32);
      const protect = mbi.readUInt32LE(36);
      const type = mbi.readUInt32LE(40);
      if (size <= 0) break;
      if (
        state === MEM_COMMIT &&
        (type === MEM_PRIVATE || type === MEM_IMAGE) &&
        (protect & PAGE_WRITABLE) !== 0 &&
        (protect & PAGE_GUARD) === 0
      ) {
        regions.push({ base, size });
      }
      address = base + size;
    }
    return regions;
  }

  read(address: number, buf: Buffer): number {
    const done: (number | null)[] = [null];
    api().ReadProcessMemory(this.handle, address, buf, buf.length, done);
    // On a partial copy the call fails but still reports how much it read.
    return Number(done[0] ?? 0);
  }

  write(address: number, buf: Buffer): boolean {
    const done: (number | null)[] = [null];
    const ok = api().WriteProcessMemory(this.handle, address, buf, buf.length, done);
    return Boolean(ok) && Number(done[0]) === buf.length;
  }

  close(): void {
    if (this.handle) api().CloseHandle(this.handle);
    this.handle = null;
  }
}

const run = promisify(execFile);

export async function listWindowsProcesses(): Promise<ProcessInfo[]> {
  const script =
    "Get-Process | Select-Object Id, ProcessName, MainWindowTitle, Path | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout || "[]");
  const rows: { Id: number; ProcessName: string; MainWindowTitle?: string; Path?: string }[] = Array.isArray(parsed)
    ? parsed
    : [parsed];
  return rows.map((r) => ({
    pid: r.Id,
    name: `${r.ProcessName}.exe`,
    title: r.MainWindowTitle || undefined,
    exe: r.Path || undefined,
  }));
}

/** One process's full command line (Get-Process doesn't have it), or undefined if Windows won't say. */
export async function windowsCommandLine(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  // UTF-8 out, so a game folder under a non-English user name comes through intact.
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    timeout: 15_000,
  });
  return stdout.trim() || undefined;
}

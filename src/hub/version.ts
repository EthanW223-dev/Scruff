import { execSync } from "node:child_process";

let cached: string | null = null;

/**
 * Short git commit of the running code, so the overlay can tell whether the
 * hub already on the port matches the code on disk. "unknown" when git isn't
 * available (result is cached per process).
 */
export function codeVersion(root: string): string {
  if (cached) return cached;
  try {
    cached =
      execSync("git rev-parse --short HEAD", {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      })
        .toString()
        .trim() || "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}

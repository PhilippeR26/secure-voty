import { spawnSync } from "node:child_process";

// Pids whose full command line matches the pattern (`pgrep -f`), this process excluded.
export function pgrepF(pattern: string): number[] {
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(Number)
    .filter((pid) => pid !== process.pid);
}

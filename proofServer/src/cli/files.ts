import fs from "fs";

// The last `count` non-empty lines of a text file; none when it cannot be read.
export function lastLines(file: string, count: number): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-count);
  } catch {
    return [];
  }
}

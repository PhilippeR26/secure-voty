import fs from "fs";
import net from "net";
import path from "path";

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

// A process group id is the pid of its leader. 0, 1 and negative values must never reach kill(2):
// -1 would signal every process of the user.
function validGroup(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM"; // it exists, but belongs to someone else
  }
}

export function isGroupAlive(pgid: number): boolean {
  if (!validGroup(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

export function killGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!validGroup(pgid)) return;
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if (errorCode(err) !== "ESRCH") throw err;
  }
}

// Start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat), null where /proc is
// missing. A pid reused later by another program has another start time.
export function processStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is between parentheses and may hold spaces: count after the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return true;
}

export type RunState = "running" | "stopped" | "crashed";

// A pid file holds the pid, then (second line) the start time of the process when /proc can tell it. After a
// crash or a reboot, the pid may belong to another program: its start time is not the recorded one, and the file
// is not taken for the server (which `stop` would otherwise signal).
export function writePidFile(file: string, pid: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = processStartTime(pid);
  fs.writeFileSync(file, started === null ? `${pid}\n` : `${pid}\n${started}\n`);
}

// No file: stopped. A file whose process is gone or is another program: crashed. Else running.
export function pidFileState(file: string): { state: RunState; pid: number | null } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "stopped", pid: null };
  }
  const [first, started] = text.split("\n");
  const pid = Number(first);
  if (!Number.isInteger(pid) || pid <= 0) return { state: "crashed", pid: null };
  if (!isProcessAlive(pid)) return { state: "crashed", pid };
  if (started && processStartTime(pid) !== started) return { state: "crashed", pid };
  return { state: "running", pid };
}

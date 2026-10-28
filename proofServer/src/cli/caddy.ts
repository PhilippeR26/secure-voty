import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { Layout } from "../layout";
import { RunState, isProcessAlive, pidFileState, waitUntil, writePidFile } from "../proc";
import { lastLines } from "./files";
import type { Out } from "./main";

const STARTUP_CHECK_MS = 2000;
const STOP_TIMEOUT_MS = 10_000;

const pidFile = (layout: Layout): string => path.join(layout.stateDir, "caddy.pid");
const outputFile = (layout: Layout): string => path.join(layout.logsDir, "caddy.stdout");

export function caddyState(layout: Layout): { state: RunState; pid: number | null } {
  return pidFileState(pidFile(layout));
}

// Caddy runs in a session of its own, as the regular user: closing the terminal does not stop it.
export async function startCaddy(layout: Layout, out: Out): Promise<boolean> {
  fs.mkdirSync(layout.logsDir, { recursive: true });
  const fd = fs.openSync(outputFile(layout), "w"); // emptied at each start
  const binary = process.env.CADDY_BINARY ?? "caddy";
  const child = spawn(binary, ["run", "--config", layout.caddyfile, "--adapter", "caddyfile"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: layout.root,
  });
  fs.closeSync(fd);
  const failed = new Promise<NodeJS.ErrnoException>((resolve) => child.on("error", resolve));
  child.unref();
  if (child.pid !== undefined) writePidFile(pidFile(layout), child.pid);

  const early = await Promise.race([failed, new Promise<null>((resolve) => setTimeout(() => resolve(null), STARTUP_CHECK_MS))]);
  if (early) {
    out(early.code === "ENOENT" ? "caddy not found: install it (see INSTALL.md)" : `caddy: ${early.message}`);
    return false;
  }
  if (child.pid !== undefined && isProcessAlive(child.pid)) {
    out(`caddy: running (pid ${child.pid})`);
    return true;
  }
  out("caddy: failed to start:");
  for (const line of lastLines(outputFile(layout), 20)) out(`  ${line}`);
  return false;
}

export async function stopCaddy(layout: Layout, out: Out): Promise<void> {
  const { state, pid } = caddyState(layout);
  if (state === "running" && pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    if (!(await waitUntil(() => !isProcessAlive(pid), STOP_TIMEOUT_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    out("caddy: stopped");
  } else if (state === "crashed") {
    out("caddy: was crashed (stale pid file removed)");
  }
  fs.rmSync(pidFile(layout), { force: true });
}

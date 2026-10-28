import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { InstanceConfig, listInstances, loadInstance } from "../instance";
import { Layout, instanceFiles, layoutEnv } from "../layout";
import { RunState, isProcessAlive, pidFileState, waitUntil, writePidFile } from "../proc";
import type { StatusPayload } from "../service";
import { killOrphanProofs } from "../slots";
import { caddyState, startCaddy, stopCaddy } from "./caddy";
import { lastLines } from "./files";
import type { Command, Out } from "./main";

export type { RunState };

export const START_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 75_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function instanceState(layout: Layout, name: string): { state: RunState; pid: number | null } {
  return pidFileState(instanceFiles(layout, name).pidFile);
}

// The instances with an instance file, and those that only have a pid file left (to be able to stop them).
function knownNames(layout: Layout): string[] {
  const names = new Set(listInstances(layout));
  try {
    for (const file of fs.readdirSync(layout.stateDir)) {
      if (file.endsWith(".pid") && file !== "caddy.pid") names.add(file.slice(0, -".pid".length));
    }
  } catch {
    // no state directory yet
  }
  return [...names].sort();
}

function anyPublicRunning(layout: Layout): boolean {
  return listInstances(layout).some((name) => {
    try {
      return loadInstance(layout, name).publicEnabled && instanceState(layout, name).state === "running";
    } catch {
      return false;
    }
  });
}

function lanAddress(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function describeUnknown(target: string, names: string[]): string {
  const known = names.length > 0 ? `known: ${names.join(", ")}` : "none yet: copy instances/example.env to instances/<name>.env";
  return `unknown instance "${target}"; ${known}`;
}

async function healthOk(inst: InstanceConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${inst.lanPort}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const health = (await response.json()) as { ok?: boolean; network?: string };
    return health.ok === true && health.network === inst.network; // not another server on that port
  } catch {
    return false;
  }
}

// Starts the server of an instance in the background, in a session of its own, and waits until it answers.
export async function startInstance(
  layout: Layout,
  name: string,
  out: Out,
  timeoutMs = START_TIMEOUT_MS,
): Promise<"started" | "already" | "failed"> {
  let inst: InstanceConfig;
  try {
    inst = loadInstance(layout, name);
  } catch (err) {
    out((err as Error).message);
    return "failed";
  }
  const files = instanceFiles(layout, name);
  const current = instanceState(layout, name);
  if (current.state === "running") {
    out(`${name}: already running (pid ${current.pid})`);
    return "already";
  }

  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.writeFileSync(files.stdoutFile, ""); // startup messages and crashes only: emptied at each start
  const fd = fs.openSync(files.stdoutFile, "a");
  const entry =
    process.env.PROOF_SERVER_DEV === "1"
      ? ["--import", "tsx", path.join(layout.packageDir, "src", "index.ts")]
      : [path.join(layout.packageDir, "dist", "index.js")];
  const child = spawn(process.execPath, [...entry, name], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: layout.packageDir,
    env: { ...process.env, ...layoutEnv(layout) },
  });
  fs.closeSync(fd);
  child.on("error", () => {});
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    out(`${name}: failed to start (node could not be run)`);
    return "failed";
  }
  writePidFile(files.pidFile, pid);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      out(`${name}: failed to start:`);
      for (const line of lastLines(files.stdoutFile, 20)) out(`  ${line}`);
      return "failed";
    }
    if (await healthOk(inst)) {
      const publicPart = inst.publicEnabled ? `127.0.0.1:${inst.publicPort}` : "off";
      out(`${name}: running (pid ${pid}) — LAN http://${lanAddress()}:${inst.lanPort}, public ${publicPart}`);
      return "started";
    }
    await sleep(500);
  }
  out(`${name}: still not answering after ${timeoutMs / 1000} s (pid ${pid}): see logs/${name}.stdout`);
  return "failed";
}

// SIGTERM lets a running proof finish; SIGKILL only when the server does not stop in time.
export async function stopInstance(layout: Layout, name: string, out: Out, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  const { pidFile } = instanceFiles(layout, name);
  const { state, pid } = instanceState(layout, name);
  if (state === "stopped") {
    out(`${name}: not running`);
    return;
  }
  if (state === "crashed" || pid === null) {
    fs.rmSync(pidFile, { force: true });
    await killOrphanProofs(layout); // a proof may have outlived the crashed server
    out(`${name}: was crashed (stale pid file removed)`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // gone in the meantime
  }
  let message = `${name}: stopped`;
  if (!(await waitUntil(() => !isProcessAlive(pid), timeoutMs, 100))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone in the meantime
    }
    await waitUntil(() => !isProcessAlive(pid), 5000, 100);
    message = `${name}: killed after ${timeoutMs / 1000} s`;
  }
  await killOrphanProofs(layout);
  fs.rmSync(pidFile, { force: true });
  out(message);
}

// Caddy runs while at least one public instance runs.
async function ensureCaddy(layout: Layout, out: Out): Promise<boolean> {
  if (!anyPublicRunning(layout) || caddyState(layout).state === "running") return true;
  if (!fs.existsSync(layout.caddyfile)) {
    out("No deploy/Caddyfile: run ./proof-server.sh caddyfile --domain <your-name>.duckdns.org");
    return false;
  }
  return startCaddy(layout, out);
}

export const startCommand: Command = async (layout, args, out) => {
  const target = args[0] ?? "all";
  const names = listInstances(layout);
  let code = 0;
  if (target === "all") {
    if (names.length === 0) {
      out("No instance: copy instances/example.env to instances/<name>.env");
      return 1;
    }
    for (const name of names) {
      if ((await startInstance(layout, name, out)) === "failed") code = 1;
    }
  } else {
    if (!names.includes(target)) {
      out(describeUnknown(target, names));
      return 1;
    }
    if ((await startInstance(layout, target, out)) !== "started") code = 1;
  }
  if (!(await ensureCaddy(layout, out))) code = 1;
  return code;
};

export const stopCommand: Command = async (layout, args, out) => {
  const target = args[0] ?? "all";
  const names = knownNames(layout);
  if (target !== "all" && !names.includes(target)) {
    out(describeUnknown(target, names));
    return 1;
  }
  const targets = target === "all" ? names : [target];
  if (targets.length === 0) out("No instance to stop.");
  for (const name of targets) await stopInstance(layout, name, out);
  if (caddyState(layout).state !== "stopped" && !anyPublicRunning(layout)) await stopCaddy(layout, out);
  return 0;
};

export const restartCommand: Command = async (layout, args, out) => {
  const stopped = await stopCommand(layout, args, out);
  return stopped !== 0 ? stopped : startCommand(layout, args, out);
};

async function printStatus(layout: Layout, name: string, out: Out): Promise<void> {
  const { state, pid } = instanceState(layout, name);
  let inst: InstanceConfig;
  try {
    inst = loadInstance(layout, name);
  } catch (err) {
    out(`${name}: ${state} — ${(err as Error).message}`);
    return;
  }
  const publicPart = inst.publicEnabled ? `127.0.0.1:${inst.publicPort}` : "off";
  if (state === "crashed") {
    out(`${name} (${inst.network}): crashed — last output:`);
    for (const line of lastLines(instanceFiles(layout, name).stdoutFile, 10)) out(`  ${line}`);
    return;
  }
  out(`${name} (${inst.network}): ${state}${pid ? `, pid ${pid}` : ""} — LAN port ${inst.lanPort}, public ${publicPart}`);
  if (state !== "running") return;

  try {
    const response = await fetch(`http://127.0.0.1:${inst.lanPort}/status`, { signal: AbortSignal.timeout(2000) });
    const status = (await response.json()) as StatusPayload;
    out(`  proofs running: ${status.running.length}, queue: ${status.queue.length}`);
    const usage = status.sites
      .filter((site) => site.perDay[status.network] !== undefined)
      .map((site) => `${site.name} ${status.usage.used[site.name] ?? 0}/${site.perDay[status.network]}`);
    if (usage.length > 0) out(`  today (UTC): ${usage.join(", ")}`);
  } catch {
    out("  (no answer on /status)");
  }
}

export const statusCommand: Command = async (layout, _args, out) => {
  const names = knownNames(layout);
  if (names.length === 0) out("No instance: copy instances/example.env to instances/<name>.env");
  for (const name of names) await printStatus(layout, name, out);
  const caddy = caddyState(layout);
  out(`caddy: ${caddy.state}${caddy.pid ? ` (pid ${caddy.pid})` : ""}`);
  return 0;
};

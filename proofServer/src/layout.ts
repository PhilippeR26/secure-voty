import path from "path";

export interface Layout {
  packageDir: string; // where the code lives
  root: string; // data home: env PROOF_SERVER_HOME, else packageDir
  instancesDir: string;
  sitesFile: string;
  stateDir: string;
  slotsDir: string;
  logsDir: string;
  tmpDir: string;
  caddyfile: string;
  repoDir: string; // snip-36-prover-backend checkout: env SNIP36_REPO_DIR, else <root>/snip-36-prover-backend
  slotLockBasePort: number; // env SLOT_LOCK_BASE_PORT, default 9800
  runnerBasePort: number; // env RUNNER_BASE_PORT, default 9900
}

export interface InstanceFiles {
  envFile: string;
  pidFile: string;
  usageFile: string;
  logFile: string;
  stdoutFile: string;
  workDir: string;
}

function basePort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }
  return port;
}

export function resolveLayout(env: NodeJS.ProcessEnv = process.env): Layout {
  const packageDir = path.resolve(__dirname, "..");
  const root = path.resolve(env.PROOF_SERVER_HOME || packageDir);
  return {
    packageDir,
    root,
    instancesDir: path.join(root, "instances"),
    sitesFile: path.join(root, "config", "sites.json"),
    stateDir: path.join(root, "state"),
    slotsDir: path.join(root, "state", "slots"),
    logsDir: path.join(root, "logs"),
    tmpDir: path.join(root, "tmp"),
    caddyfile: path.join(root, "deploy", "Caddyfile"),
    repoDir: path.resolve(env.SNIP36_REPO_DIR || path.join(root, "snip-36-prover-backend")),
    slotLockBasePort: basePort(env, "SLOT_LOCK_BASE_PORT", 9800),
    runnerBasePort: basePort(env, "RUNNER_BASE_PORT", 9900),
  };
}

export function layoutEnv(layout: Layout): Record<string, string> {
  return {
    PROOF_SERVER_HOME: layout.root,
    SNIP36_REPO_DIR: layout.repoDir,
    SLOT_LOCK_BASE_PORT: String(layout.slotLockBasePort),
    RUNNER_BASE_PORT: String(layout.runnerBasePort),
  };
}

export function instanceFiles(layout: Layout, inst: string): InstanceFiles {
  return {
    envFile: path.join(layout.instancesDir, `${inst}.env`),
    pidFile: path.join(layout.stateDir, `${inst}.pid`),
    usageFile: path.join(layout.stateDir, inst, "usage.json"),
    logFile: path.join(layout.logsDir, `${inst}.log`),
    stdoutFile: path.join(layout.logsDir, `${inst}.stdout`),
    workDir: path.join(layout.tmpDir, inst),
  };
}

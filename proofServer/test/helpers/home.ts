import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { Layout, instanceFiles, resolveLayout } from "../../src/layout";

export interface TestHome {
  root: string;
  layout: Layout;
  env: Record<string, string>;
  writeInstance(name: string, vars: Record<string, string | number | boolean>): void;
  writeSites(config: object): void;
  readLog(inst: string): Array<Record<string, unknown>>;
  cleanup(): void;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export async function makeHome(): Promise<TestHome> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-home-"));
  const env = {
    PROOF_SERVER_HOME: root,
    SLOT_LOCK_BASE_PORT: String(await freePort()),
    RUNNER_BASE_PORT: String(await freePort()),
  };
  const layout = resolveLayout(env);

  return {
    root,
    layout,
    env,
    writeInstance(name, vars) {
      const { envFile } = instanceFiles(layout, name);
      fs.mkdirSync(path.dirname(envFile), { recursive: true });
      const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
      fs.writeFileSync(envFile, lines.join("\n") + "\n");
    },
    writeSites(config) {
      fs.mkdirSync(path.dirname(layout.sitesFile), { recursive: true });
      fs.writeFileSync(layout.sitesFile, JSON.stringify(config, null, 2) + "\n");
    },
    readLog(inst) {
      const { logFile } = instanceFiles(layout, inst);
      if (!fs.existsSync(logFile)) return [];
      return fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

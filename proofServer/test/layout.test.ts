import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import { instanceFiles, layoutEnv, resolveLayout } from "../src/layout";

test("defaults: data home is the package dir, ports 9800/9900", () => {
  const l = resolveLayout({});
  assert.equal(path.basename(l.packageDir), "proofServer");
  assert.equal(l.root, l.packageDir);
  assert.equal(l.sitesFile, path.join(l.root, "config", "sites.json"));
  assert.equal(l.caddyfile, path.join(l.root, "deploy", "Caddyfile"));
  assert.equal(l.repoDir, path.join(l.root, "snip-36-prover-backend"));
  assert.equal(l.slotLockBasePort, 9800);
  assert.equal(l.runnerBasePort, 9900);
});

test("env overrides; layoutEnv recreates the same layout", () => {
  const l = resolveLayout({
    PROOF_SERVER_HOME: "/tmp/h",
    SNIP36_REPO_DIR: "/opt/p",
    SLOT_LOCK_BASE_PORT: "21000",
    RUNNER_BASE_PORT: "22000",
  });
  assert.equal(l.logsDir, "/tmp/h/logs");
  assert.equal(l.repoDir, "/opt/p");
  assert.deepEqual(resolveLayout(layoutEnv(l)), l);
});

test("instanceFiles", () => {
  assert.deepEqual(instanceFiles(resolveLayout({ PROOF_SERVER_HOME: "/h" }), "sepolia"), {
    envFile: "/h/instances/sepolia.env",
    pidFile: "/h/state/sepolia.pid",
    usageFile: "/h/state/sepolia/usage.json",
    logFile: "/h/logs/sepolia.log",
    stdoutFile: "/h/logs/sepolia.stdout",
    workDir: "/h/tmp/sepolia",
  });
});

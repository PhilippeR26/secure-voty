import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { Command, Out } from "./main";

const REPO_URL = "https://github.com/starknet-innovation/snip-36-prover-backend";

// Runs a command with its output on the terminal; resolves with its exit code (1 when it cannot be run).
function run(command: string, args: string[], cwd: string, out: Out): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (err: NodeJS.ErrnoException) => {
      out(err.code === "ENOENT" ? `${command} not found: install it (see INSTALL.md)` : `${command}: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// snip36 setup is complete when it has produced the prover and the runner.
function depsComplete(repo: string): boolean {
  return ["deps/bin/stwo-run-and-prove", "deps/sequencer/target/release/starknet_transaction_prover"].every((file) =>
    fs.existsSync(path.join(repo, file)),
  );
}

export const setupCommand: Command = async (layout, _args, out) => {
  const repo = layout.repoDir;
  const binary = path.join(repo, "target", "release", "snip36");

  if (fs.existsSync(repo)) {
    out("[1/4] snip-36-prover-backend: already cloned");
  } else {
    out(`[1/4] Cloning snip-36-prover-backend into ${repo}...`);
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    const code = await run("git", ["clone", REPO_URL, repo], path.dirname(repo), out);
    if (code !== 0) return code;
  }

  if (fs.existsSync(binary)) {
    out("[2/4] snip36: already built");
  } else {
    out("[2/4] Building snip36 (cargo build --release -p snip36-cli)...");
    const code = await run("cargo", ["build", "--release", "-p", "snip36-cli"], repo, out);
    if (code !== 0) return code;
  }

  if (depsComplete(repo)) {
    out("[3/4] prover and runner: already installed");
  } else {
    out("[3/4] Running snip36 setup (about 10 GB of disk, 20 to 30 minutes)...");
    // A setup that stopped half-way leaves the lock file of the sequencer rewritten by cargo, and the next run
    // refuses it: put it back first.
    const sequencer = path.join(repo, "deps", "sequencer");
    if (fs.existsSync(path.join(sequencer, ".git"))) {
      await run("git", ["-C", sequencer, "checkout", "--quiet", "--", "Cargo.lock"], repo, () => {});
    }
    const code = await run(binary, ["setup"], repo, out);
    if (code !== 0) {
      out("snip36 setup failed. Leads:");
      out("  - an error about 'stdarg.h' not found: sudo apt install -y libclang-dev, then run this command again");
      out("  - not enough memory or disk: free some and run this command again, it resumes where it stopped");
      out("See INSTALL.md (troubleshooting).");
      return code;
    }
  }

  out("[4/4] Checking the installation (snip36 doctor)...");
  return run(binary, ["doctor"], repo, out);
};

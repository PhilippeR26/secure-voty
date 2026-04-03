import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const REPO_DIR = path.resolve(process.env.SNIP36_REPO_DIR ?? "./snip-36-prover-backend");
export const BINARY = path.join(REPO_DIR, "target/release/snip36");
export const REPO_CWD = REPO_DIR;

export function ensureBuilt(): void {
  if (!fs.existsSync(REPO_DIR)) {
    console.log("📦 Cloning snip-36-prover-backend...");
    execSync(
      `git clone https://github.com/starknet-innovation/snip-36-prover-backend ${REPO_DIR}`,
      { stdio: "inherit" }
    );
  }

  if (!fs.existsSync(BINARY)) {
    console.log("🔨 Building snip36-cli (release)...");
    execSync("cargo build --release -p snip36-cli", {
      cwd: REPO_DIR,
      stdio: "inherit",
    });
  }
// /D/Starknet/secure-voty/proofServer/deps/sequencer/target/release/starknet_transaction_prover

//                         proofServer/snip-36-prover-backend/deps/sequencer/target/release/starknet_transaction_prover

  // const REPO_DEPS = path.resolve( "./");
  const REPO_DEPS = REPO_DIR;
    console.log("Processing deps in",REPO_DEPS+"/deps...");
  if (!fs.existsSync(path.join(REPO_DEPS, "deps"))) {
    console.log("⚙️  Running snip36 setup (~10 GB storage, takes about 20 minutes)...");
    execSync(`${BINARY} setup`, {
      cwd: REPO_DEPS,
      stdio: "inherit",
      env: { ...process.env },
    });
  }

  console.log(`✅ snip36 binary ready: ${BINARY}`);
}
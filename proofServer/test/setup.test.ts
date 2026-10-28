import assert from "node:assert/strict";
import test, { TestContext, afterEach } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { main } from "../src/cli/main";
import { TestHome, makeHome } from "./helpers/home";

afterEach(() => {
  for (const key of ["FAKE_SETUP_CODE", "FAKE_DOCTOR_CODE"]) delete process.env[key];
});

// A snip36 that records the commands it is given in calls.log, and fails when the environment says so.
const FAKE_SNIP36 = `#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/calls.log"
case "$1" in
  setup) exit "\${FAKE_SETUP_CODE:-0}" ;;
  doctor) exit "\${FAKE_DOCTOR_CODE:-0}" ;;
esac
`;

async function rig(t: TestContext): Promise<{ home: TestHome; run(): Promise<{ code: number; text: string }>; calls(): string[] }> {
  const home = await makeHome();
  t.after(() => home.cleanup());
  const callsFile = path.join(home.layout.repoDir, "target", "release", "calls.log");
  return {
    home,
    async run() {
      const lines: string[] = [];
      const code = await main(["setup"], home.layout, (line) => lines.push(line));
      return { code, text: lines.join("\n") };
    },
    calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean) : []),
  };
}

// A checkout of the prover that is already there and built; `complete` tells whether snip36 setup went to its end.
function installCheckout(home: TestHome, complete: boolean): void {
  const binary = path.join(home.layout.repoDir, "target", "release", "snip36");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, FAKE_SNIP36, { mode: 0o755 });
  fs.mkdirSync(path.join(home.layout.repoDir, "deps"), { recursive: true });
  if (complete) {
    for (const file of ["deps/bin/stwo-run-and-prove", "deps/sequencer/target/release/starknet_transaction_prover"]) {
      const full = path.join(home.layout.repoDir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "");
    }
  }
}

test("setup skips what is done and ends with doctor", async (t) => {
  const r = await rig(t);
  installCheckout(r.home, true);
  const { code, text } = await r.run();
  assert.equal(code, 0);
  assert.deepEqual(r.calls(), ["doctor"]);
  assert.match(text, /already cloned/);
  assert.match(text, /already built/);
  assert.match(text, /already installed/);
});

test("setup finishes an incomplete installation", async (t) => {
  const r = await rig(t);
  installCheckout(r.home, false); // the runner is missing: a previous snip36 setup stopped half-way
  const { code } = await r.run();
  assert.equal(code, 0);
  assert.deepEqual(r.calls(), ["setup", "doctor"]);
});

test("setup returns the code of the first failing command and gives leads", async (t) => {
  process.env.FAKE_SETUP_CODE = "3";
  const r = await rig(t);
  installCheckout(r.home, false);
  const { code, text } = await r.run();
  assert.equal(code, 3);
  assert.deepEqual(r.calls(), ["setup"]); // doctor is not run
  assert.match(text, /libclang-dev/);
  assert.match(text, /INSTALL\.md/);
});

test("a failing doctor gives its code", async (t) => {
  process.env.FAKE_DOCTOR_CODE = "2";
  const r = await rig(t);
  installCheckout(r.home, true);
  assert.equal((await r.run()).code, 2);
});

test("setup says when git is missing", async (t) => {
  const r = await rig(t); // no checkout: git is needed
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "proof-nopath-"));
  t.after(() => fs.rmSync(emptyBin, { recursive: true, force: true }));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const { code, text } = await r.run();
    assert.equal(code, 1);
    assert.match(text, /git not found/);
    assert.match(text, /INSTALL\.md/);
  } finally {
    process.env.PATH = savedPath;
  }
});

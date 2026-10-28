import assert from "node:assert/strict";
import test, { TestContext, afterEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "fs";
import os from "os";
import path from "path";
import { isGroupAlive, isPortFree } from "../src/proc";
import { ProofSpec, ProverResult, redactTxValues, sanitizeReason, startProof } from "../src/prover";
import { FAKE_OUT, FAKE_SNIP36 } from "./helpers/fake";
import { freePort, waitFor } from "./helpers/home";
import { pgrepF } from "./helpers/procs";

const tx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));

afterEach(() => {
  for (const key of ["FAKE_MODE", "FAKE_SLEEP", "FAKE_TRACE", "FAKE_TRACE_ARGS", "FAKE_LEAK"]) {
    delete process.env[key];
  }
});

async function makeSpec(t: TestContext, overrides: Partial<ProofSpec> = {}): Promise<ProofSpec> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proof-run-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, "work");
  const repoDir = path.join(dir, "repo");
  fs.mkdirSync(workDir, { mode: 0o700 });
  fs.mkdirSync(repoDir);
  return {
    binary: FAKE_SNIP36,
    repoDir,
    workDir,
    jobId: "job1",
    network: "sepolia",
    rpcUrl: "http://127.0.0.1:1/rpc",
    blockNumber: 123,
    tx,
    runnerPort: await freePort(),
    timeoutMs: 10000,
    ...overrides,
  };
}

function expectKind<K extends ProverResult["kind"]>(result: ProverResult, kind: K): Extract<ProverResult, { kind: K }> {
  assert.equal(result.kind, kind, JSON.stringify(result).slice(0, 300));
  return result as Extract<ProverResult, { kind: K }>;
}

test("ok: returns the outputs and deletes the job files", async (t) => {
  const lines: Array<[string, string]> = [];
  const spec = await makeSpec(t, { onLine: (stream, line) => lines.push([stream, line]) });
  const result = expectKind(await startProof(spec).result, "done");
  assert.deepEqual(result.output, FAKE_OUT);
  assert.ok(result.durMs >= 0);
  assert.deepEqual(fs.readdirSync(spec.workDir), []);
  assert.ok(lines.some(([stream, line]) => stream === "stdout" && line === "Running virtual OS..."));
  assert.ok(lines.some(([stream, line]) => stream === "stderr" && line === "progress: step 1/2"));
});

test("passes port, chain, dummy account and project dir; the tx file is private", async (t) => {
  const spec = await makeSpec(t, { network: "mainnet" });
  const trace = path.join(path.dirname(spec.workDir), "trace.log");
  process.env.FAKE_TRACE = trace;
  expectKind(await startProof(spec).result, "done");
  const text = fs.readFileSync(trace, "utf8");
  assert.ok(text.includes(`port=${spec.runnerPort}`));
  assert.ok(text.includes(`env chain=SN_MAIN account=0x1 project=${spec.repoDir} txmode=600 cwd=${spec.repoDir}`));
});

test("runs snip36 with the options of `prove virtual-os`", async (t) => {
  const spec = await makeSpec(t);
  const trace = path.join(path.dirname(spec.workDir), "trace.log");
  process.env.FAKE_TRACE = trace;
  process.env.FAKE_TRACE_ARGS = "1";
  expectKind(await startProof(spec).result, "done");
  const base = path.join(spec.workDir, "job1");
  assert.ok(
    fs.readFileSync(trace, "utf8").includes(
      `args prove virtual-os --block-number 123 --tx-json ${base}.tx.json --rpc-url http://127.0.0.1:1/rpc --output ${base}.proof --port ${spec.runnerPort}`,
    ),
  );
});

test("fail: a non-zero exit gives a sanitized reason", async (t) => {
  process.env.FAKE_MODE = "fail";
  const spec = await makeSpec(t);
  const result = expectKind(await startProof(spec).result, "fail");
  assert.equal(result.exitCode, 3);
  assert.equal(result.reason, "Error: Transaction execution failed: Vote is not open");
  assert.ok(result.stderrTail.includes("progress: step 1/2"));
  assert.deepEqual(fs.readdirSync(spec.workDir), []);
});

test("fail: values of the transaction are masked in the reason, not in the stderr tail", async (t) => {
  process.env.FAKE_MODE = "fail";
  process.env.FAKE_LEAK = tx.calldata[6];
  const spec = await makeSpec(t);
  const result = expectKind(await startProof(spec).result, "fail");
  assert.equal(result.reason, "Error: Transaction execution failed: Vote is not open (<redacted>)");
  assert.ok(result.stderrTail.includes(tx.calldata[6]));
});

test("a clean exit without output files is a failure", async (t) => {
  process.env.FAKE_MODE = "nooutput";
  const spec = await makeSpec(t);
  const result = expectKind(await startProof(spec).result, "fail");
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "prover output missing: job1.proof");
  assert.deepEqual(fs.readdirSync(spec.workDir), []);
});

test("timeout kills the whole group and frees the runner port", async (t) => {
  process.env.FAKE_MODE = "hang";
  const spec = await makeSpec(t, { timeoutMs: 1500 });
  const run = startProof(spec);
  await waitFor(async () => !(await isPortFree(spec.runnerPort)), 3000); // the fake runner listens
  const result = expectKind(await run.result, "killed");
  assert.equal(result.reason, "timeout");
  assert.equal(isGroupAlive(run.pgid!), false);
  assert.equal(await isPortFree(spec.runnerPort), true);
  assert.deepEqual(pgrepF(`${spec.runnerPort} fake-runner`), []);
  assert.deepEqual(fs.readdirSync(spec.workDir), []);
});

test("what snip36 leaves running after its exit is killed", async (t) => {
  process.env.FAKE_MODE = "leftover";
  const spec = await makeSpec(t);
  const run = startProof(spec);
  expectKind(await run.result, "done");
  assert.equal(isGroupAlive(run.pgid!), false);
  assert.equal(await isPortFree(spec.runnerPort), true);
  assert.deepEqual(pgrepF(`${spec.runnerPort} fake-runner`), []);
});

test("kill('abort') stops a running proof; the first reason wins", async (t) => {
  process.env.FAKE_SLEEP = "30";
  const spec = await makeSpec(t);
  const run = startProof(spec);
  await sleep(300);
  run.kill("abort");
  run.kill("timeout");
  const result = expectKind(await run.result, "killed");
  assert.equal(result.reason, "abort");
  assert.ok(result.durMs < 10000);
  assert.equal(isGroupAlive(run.pgid!), false);
  assert.deepEqual(fs.readdirSync(spec.workDir), []);
});

test("a missing binary fails cleanly", async (t) => {
  const spec = await makeSpec(t, { binary: "/nonexistent/snip36" });
  const run = startProof(spec);
  assert.equal(run.pgid, null);
  const result = expectKind(await run.result, "fail");
  assert.match(result.reason, /ENOENT/);
  assert.deepEqual(fs.readdirSync(spec.workDir), []);
});

test("an unusable work directory fails cleanly, without its path in the reason", async (t) => {
  const spec = await makeSpec(t);
  const missing = path.join(spec.workDir, "missing", "deeper");
  const run = startProof({ ...spec, workDir: missing });
  assert.equal(run.pgid, null);
  const result = expectKind(await run.result, "fail");
  assert.match(result.reason, /ENOENT/);
  assert.ok(!result.reason.includes(missing));
});

test("lines are rebuilt from pieces; CRLF is dropped; the last line needs no newline", async (t) => {
  process.env.FAKE_MODE = "partial";
  const stdout: string[] = [];
  const spec = await makeSpec(t, { onLine: (stream, line) => stream === "stdout" && stdout.push(line) });
  expectKind(await startProof(spec).result, "done");
  assert.deepEqual(stdout, ["Running virtual OS...", "abcdef", "last"]);
});

test("sanitizeReason", () => {
  assert.equal(
    sanitizeReason("\x1b[31mError\x1b[0m at /home/u/proofServer/x.rs:12: Vote is not open\n\n"),
    "Error at <path>:12: Vote is not open",
  );
  assert.equal(sanitizeReason("x".repeat(400)).length, 300);
  assert.equal(sanitizeReason(""), "");
  assert.equal(sanitizeReason("Error:   too   many\tspaces"), "Error: too many spaces");
});

test("sanitizeReason reads the error report of snip36", () => {
  // Report printed by snip36 v1.3.1 for a refused transaction (stale nonce), as observed with the sample of the
  // old README on the local Sepolia node: colored, felts padded to 64 digits.
  const padded = (hex: string) => `0x${hex.padStart(64, "0")}`;
  const report = [
    "Error: ",
    `   0: \x1b[91mstarknet_proveTransaction failed: {"code":-32603,"data":"Transaction execution failed: Invalid transaction nonce of contract at address ${padded("304c822792da45bf6f8e6957aa9515bd7b365f05b5c1678f61ae0c46213251c")}. Account nonce: ${padded("1ce")}; got: ${padded("1c6")}.","message":"Internal error"}\x1b[0m`,
    "",
    "Location:",
    "   crates/snip36-cli/src/commands/prove.rs:347",
    "",
    "Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.",
    "Run with RUST_BACKTRACE=full to include source snippets.",
    "",
  ].join("\n");
  assert.equal(
    sanitizeReason(report),
    "Transaction execution failed: Invalid transaction nonce of contract at address 0x0304c822792da45bf6f8e6957aa9515bd7b365f05b5c1678f61ae0c46213251c. Account nonce: 0x1ce; got: 0x1c6.",
  );

  // the deepest cause of a chain is the last numbered line
  assert.equal(sanitizeReason("Error: \n   0: outer context\n   1: inner cause\n\nLocation:\n   a/b/c.rs:1\n"), "inner cause");
  // a JSON error without `data` gives its `message`; text that is not JSON is kept
  assert.equal(sanitizeReason('   0: failed: {"message":"boom"}'), "boom");
  assert.equal(sanitizeReason("   0: failed: {not json"), "failed: {not json");
  // without a numbered report, the last line that is not a backtrace hint
  assert.equal(sanitizeReason("panic message\nRun with RUST_BACKTRACE=full to include source snippets.\n"), "panic message");
});

test("redactTxValues", () => {
  const secret = tx.calldata[6];
  const text = `bad ${secret.toUpperCase().replace("0X", "0x0")}, sig ${tx.signature[0]}, flag 0x1, other 0xdeadbeef`;
  assert.equal(redactTxValues(text, tx), "bad <redacted>, sig <redacted>, flag 0x1, other 0xdeadbeef");
  assert.equal(redactTxValues("nothing 0xabc", tx), "nothing 0xabc");
  assert.equal(redactTxValues("0xabc", null), "0xabc");
});

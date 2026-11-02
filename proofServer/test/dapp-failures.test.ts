import assert from "node:assert/strict";
import test, { TestContext, afterEach } from "node:test";
import fs from "fs";
import http from "http";
import path from "path";
import { checkProofServer } from "../../src/app/server/checkProofServer";
import { requestProof } from "../../src/app/server/RequestProof";
import type { ProofFailure, ProofProgress } from "../../src/app/types";
import { ProofFailureError } from "../../src/app/utils/proofFailure";
import { freePort } from "./helpers/home";
import { TEST_KEY, TestServer, startTestServer } from "./helpers/server";

// What the DAPP tells the voter when no proof comes, against the real proof server and the fake prover.
const tx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));

const ENV_NAMES = ["PROOF_SERVER_URL", "PROOF_SERVER_API_KEY", "STARKNET_CHAIN_ID", "FAKE_MODE", "FAKE_SLEEP"];
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// The clients print their progress: keep the test output clean.
function quiet(t: TestContext): void {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
}

async function serve(t: TestContext, opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(opts);
  t.after(() => s.close());
  return s;
}

// The failure the promise ends with, and the technical message of the error.
async function failureOf(promise: Promise<unknown>): Promise<{ failure: ProofFailure; message: string }> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ProofFailureError, `expected a ProofFailureError, got: ${String(err)}`);
    return { failure: err.failure, message: err.message };
  }
  return assert.fail("expected the call to fail");
}

test("a refused key is told as refused", async (t) => {
  quiet(t);
  const s = await serve(t);
  setEnv({ PROOF_SERVER_URL: s.publicUrl, PROOF_SERVER_API_KEY: "wrong" });
  const { failure } = await failureOf(requestProof(123, tx as never));
  assert.equal(failure.kind, "refused");
  assert.match(failure.message, /401 unknown_key/);
  assert.match(failure.message, /PROOF_SERVER_API_KEY/);
});

test("an exhausted quota says when it resets", async (t) => {
  quiet(t);
  const s = await serve(t, { perDay: 1 });
  setEnv({ PROOF_SERVER_URL: s.publicUrl, PROOF_SERVER_API_KEY: TEST_KEY });
  await requestProof(123, tx as never);
  const { failure } = await failureOf(requestProof(123, tx as never));
  assert.equal(failure.kind, "quota");
  assert.ok(failure.retryAfterSec !== undefined && failure.retryAfterSec >= 1 && failure.retryAfterSec <= 86400);
  assert.match(failure.message, /Daily proof quota of this DAPP reached; try again in .*\(00:00 UTC\)\./);
});

test("a site that already has a request running is told the server is busy", async (t) => {
  quiet(t);
  const s = await serve(t, { limits: { perSiteQueueMax: 1 } });
  setEnv({ PROOF_SERVER_URL: s.publicUrl, PROOF_SERVER_API_KEY: TEST_KEY, FAKE_SLEEP: "1" });
  let firstStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => (firstStarted = resolve));
  const first = requestProof(123, tx as never, {
    onProgress: (progress: ProofProgress) => {
      if (progress.event === "started") firstStarted();
    },
  });
  await started;
  const { failure } = await failureOf(requestProof(123, tx as never));
  assert.equal(failure.kind, "busy");
  assert.match(failure.message, /The proof server is busy; try again/);
  await first;
});

test("a failed proof gives the reason of the prover", async (t) => {
  quiet(t);
  const s = await serve(t);
  setEnv({ PROOF_SERVER_URL: s.lanUrl, FAKE_MODE: "fail" });
  const { failure } = await failureOf(requestProof(123, tx as never));
  assert.equal(failure.kind, "proof_failed");
  assert.match(failure.message, /Vote is not open/);
});

test("a proof server that does not answer is told without its address", async (t) => {
  quiet(t);
  const url = `http://127.0.0.1:${await freePort()}`;
  setEnv({ PROOF_SERVER_URL: url });
  const { failure, message } = await failureOf(requestProof(123, tx as never));
  assert.equal(failure.kind, "unreachable");
  assert.equal(failure.message, "The proof server does not answer.");
  assert.ok(message.includes(url), "the technical message names the address, for the logs");
  assert.ok(!failure.message.includes("127.0.0.1"));
});

test("checkProofServer accepts a server on the network of the DAPP", async (t) => {
  const s = await serve(t);
  setEnv({ PROOF_SERVER_URL: s.lanUrl, STARKNET_CHAIN_ID: "SN_SEPOLIA" });
  await checkProofServer();
  setEnv({ STARKNET_CHAIN_ID: undefined }); // unknown network of the DAPP: nothing to compare
  await checkProofServer();
});

test("checkProofServer refuses a server on another network", async (t) => {
  const s = await serve(t);
  setEnv({ PROOF_SERVER_URL: s.lanUrl, STARKNET_CHAIN_ID: "SN_MAIN" });
  const { failure } = await failureOf(checkProofServer());
  assert.equal(failure.kind, "network_mismatch");
  assert.equal(failure.message, "The proof server proves sepolia, but this DAPP runs on mainnet.");
});

test("checkProofServer refuses an address that is not a proof server", async (t) => {
  const notAProofServer = http.createServer((_req, res) => res.end("<html>not json</html>"));
  await new Promise<void>((resolve) => notAProofServer.listen(0, "127.0.0.1", resolve));
  t.after(() => notAProofServer.close());
  const { port } = notAProofServer.address() as { port: number };
  setEnv({ PROOF_SERVER_URL: `http://127.0.0.1:${port}` });
  const { failure } = await failureOf(checkProofServer());
  assert.equal(failure.kind, "unreachable");
});

import assert from "node:assert/strict";
import test, { TestContext, afterEach } from "node:test";
import fs from "fs";
import path from "path";
import { requestProof as scriptsRequestProof } from "../../scripts/src/RequestProof";
import { requestProof as dappRequestProof } from "../../src/app/server/RequestProof";
import { FAKE_OUT } from "./helpers/fake";
import { TEST_KEY, TestServer, startTestServer } from "./helpers/server";

// The real clients of the DAPP and of the scripts, run against the real server. They have no import that runs:
// their only imports are types.
const tx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));
type Client = (block: number, tx: never) => Promise<unknown>;
const clients: Array<[string, Client]> = [
  ["DAPP", dappRequestProof as unknown as Client],
  ["scripts", scriptsRequestProof as unknown as Client],
];

const saved = { url: process.env.PROOF_SERVER_URL, key: process.env.PROOF_SERVER_API_KEY };

function setEnv(url: string | undefined, key?: string): void {
  for (const [name, value] of [["PROOF_SERVER_URL", url], ["PROOF_SERVER_API_KEY", key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => setEnv(saved.url, saved.key));

// The clients print their progress: keep the test output clean, and return console.log to look at it.
function quiet(t: TestContext) {
  t.mock.method(console, "error", () => {});
  return t.mock.method(console, "log", () => {});
}

async function serve(t: TestContext, opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(opts);
  t.after(() => s.close());
  return s;
}

test("DAPP client gets a proof from the LAN listener", async (t) => {
  quiet(t);
  const s = await serve(t);
  setEnv(s.lanUrl);
  assert.deepEqual(await dappRequestProof(123, tx), FAKE_OUT);
});

test("DAPP client sends the key to the public listener", async (t) => {
  quiet(t);
  const s = await serve(t);
  setEnv(s.publicUrl, TEST_KEY);
  assert.deepEqual(await dappRequestProof(123, tx), FAKE_OUT);
});

test("DAPP client reports a refusal", async (t) => {
  quiet(t);
  const s = await serve(t);
  setEnv(s.publicUrl, "wrong");
  await assert.rejects(dappRequestProof(123, tx), (err: Error) => /401/.test(err.message) && /unknown_key/.test(err.message));
});

test("scripts client behaves the same", async (t) => {
  quiet(t);
  const s = await serve(t);
  setEnv(s.lanUrl);
  assert.deepEqual(await scriptsRequestProof(123, tx), FAKE_OUT);
  setEnv(s.publicUrl, TEST_KEY);
  assert.deepEqual(await scriptsRequestProof(123, tx), FAKE_OUT);
  setEnv(s.publicUrl, "wrong");
  await assert.rejects(scriptsRequestProof(123, tx), (err: Error) => /401/.test(err.message) && /unknown_key/.test(err.message));
});

for (const [name, requestProof] of clients) {
  test(`${name} client builds its request from the environment`, async (t) => {
    quiet(t);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      throw new Error("stop here");
    });
    for (const [url, key] of [
      [undefined, undefined], // the default: the proof server of this machine
      ["", ""], // empty variables count as unset
      ["https://myproof.duckdns.org/sepolia///", "K"], // trailing slashes are dropped
    ] as const) {
      setEnv(url, key);
      await assert.rejects(requestProof(1, tx as never), /stop here/);
    }
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://localhost:3030/prove", "http://localhost:3030/prove", "https://myproof.duckdns.org/sepolia/prove"],
    );
    assert.equal("Authorization" in calls[0].headers, false);
    assert.equal("Authorization" in calls[1].headers, false);
    assert.equal(calls[2].headers.Authorization, "Bearer K");
    assert.equal(calls[2].headers["Content-Type"], "application/json");
  });

  test(`${name} client says when to retry after a quota refusal`, async (t) => {
    quiet(t);
    const s = await serve(t, { perDay: 1 });
    setEnv(s.publicUrl, TEST_KEY);
    assert.deepEqual(await requestProof(123, tx as never), FAKE_OUT);
    await assert.rejects(
      requestProof(123, tx as never),
      (err: Error) =>
        /refused the request: 429 quota_exceeded/.test(err.message) && /; retry after \d+ s$/.test(err.message),
    );
  });

  test(`${name} client shows the queue position and the start of the proof`, async (t) => {
    const log = quiet(t);
    const s = await serve(t);
    setEnv(s.lanUrl);
    await requestProof(123, tx as never);
    const printed = log.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.match(printed, /queued: position 1/);
    assert.match(printed, /proof started/);
  });
}

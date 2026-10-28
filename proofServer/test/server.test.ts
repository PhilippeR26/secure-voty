import assert from "node:assert/strict";
import http from "node:http";
import test, { TestContext, afterEach } from "node:test";
import fs from "fs";
import net from "net";
import path from "path";
import { BanList } from "../src/auth";
import { AppDeps, createLanApp } from "../src/app";
import { CHAIN_IDS } from "../src/instance";
import { hashKey } from "../src/keys";
import { isPortFree } from "../src/proc";
import { secondsUntilUtcMidnight } from "../src/quota";
import { StartupError, startServer } from "../src/server";
import { FAKE_OUT, FAKE_SNIP36 } from "./helpers/fake";
import { TestHome, freePort, makeHome, waitFor } from "./helpers/home";
import { pgrepF } from "./helpers/procs";
import { startFakeRpc } from "./helpers/rpc";
import { TEST_KEY, TestServer, startTestServer } from "./helpers/server";
import { ProveResponse, SseRec, prove } from "./helpers/sse";

const tx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));
const body = { blockNumber: 123, tx };

afterEach(() => {
  for (const key of ["FAKE_MODE", "FAKE_SLEEP", "FAKE_TRACE", "FAKE_TRACE_ARGS", "FAKE_LEAK"]) {
    delete process.env[key];
  }
});

async function serve(t: TestContext, opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(opts);
  t.after(() => s.close());
  return s;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const last = (events: SseRec[]): SseRec => events[events.length - 1];
const names = (events: SseRec[]): string[] => events.map((e) => e.event);
const positions = (r: ProveResponse): number[] => r.events.filter((e) => e.event === "queued").map((e) => e.data.position);
const logOf = (s: TestServer) => s.home.readLog("sepolia");
const traceMarks = (file: string): string[] =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => /^(start|end) /.test(line))
    .map((line) => line.split(" ")[0]);

async function statusOf(s: TestServer): Promise<any> {
  return (await fetch(`${s.lanUrl}/status`)).json();
}

test("LAN: full proof flow", async (t) => {
  const s = await serve(t);
  const r = await prove(s.lanUrl, body);
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.events).slice(0, 2), ["queued", "started"]);
  assert.ok(names(r.events).includes("log"));
  assert.deepEqual(last(r.events), { event: "done", data: FAKE_OUT });
});

test("public: key required, no prover lines", async (t) => {
  const s = await serve(t);
  const none = await prove(s.publicUrl, body);
  assert.equal(none.status, 401);
  assert.equal(none.json.reason, "missing_key");

  const wrong = await prove(s.publicUrl, body, { key: "wrong" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.reason, "unknown_key");

  const ok = await prove(s.publicUrl, body, { key: TEST_KEY });
  assert.equal(ok.status, 200);
  assert.ok(!names(ok.events).includes("log"));
  assert.deepEqual(last(ok.events), { event: "done", data: FAKE_OUT });
});

test("public: daily quota", async (t) => {
  const s = await serve(t, { perDay: 2 });
  for (let i = 0; i < 2; i++) {
    const ok = await prove(s.publicUrl, body, { key: TEST_KEY });
    assert.equal(ok.status, 200);
    assert.equal(last(ok.events).event, "done");
  }
  const refused = await prove(s.publicUrl, body, { key: TEST_KEY });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.reason, "quota_exceeded");
  assert.ok(Math.abs(Number(refused.retryAfter) - secondsUntilUtcMidnight(new Date())) <= 5);
});

test("one proof at a time; others wait their turn", async (t) => {
  process.env.FAKE_SLEEP = "1";
  const s = await serve(t);
  const trace = path.join(s.home.root, "trace.log");
  process.env.FAKE_TRACE = trace;

  const aStarted = deferred();
  const bQueued = deferred();
  const pa = prove(s.lanUrl, body, { onEvent: (e) => e.event === "started" && aStarted.resolve() });
  await aStarted.promise;
  const pb = prove(s.lanUrl, body, { onEvent: (e) => e.event === "queued" && bQueued.resolve() });
  await bQueued.promise;
  const pc = prove(s.lanUrl, body);

  const [a, b, c] = await Promise.all([pa, pb, pc]);
  for (const r of [a, b, c]) assert.equal(last(r.events).event, "done");
  assert.deepEqual(positions(a), [1]);
  assert.deepEqual(positions(b), [1]);
  assert.deepEqual(positions(c), [2, 1]);
  assert.deepEqual(traceMarks(trace), ["start", "end", "start", "end", "start", "end"]);
});

test("timeout kills the proof group and frees the runner port", async (t) => {
  process.env.FAKE_MODE = "hang";
  const s = await serve(t, { limits: { proofTimeoutSec: 1 } });
  const r = await prove(s.lanUrl, body);
  assert.equal(last(r.events).event, "error");
  assert.match(last(r.events).data.message, /timed out/);
  assert.ok(logOf(s).some((e) => e.ev === "timeout"));
  const { runnerBasePort } = s.home.layout;
  assert.equal(await isPortFree(runnerBasePort), true);
  assert.deepEqual(pgrepF(`${runnerBasePort} fake-runner`), []);
});

test("limits change while the server runs", async (t) => {
  const s = await serve(t, { perDay: 1 });
  assert.equal((await prove(s.publicUrl, body, { key: TEST_KEY })).status, 200);
  assert.equal((await prove(s.publicUrl, body, { key: TEST_KEY })).status, 429);

  s.home.writeSites({
    limits: {},
    sites: { voty: { keySha256: hashKey(TEST_KEY), enabled: true, perDay: { sepolia: 3 } } },
  });
  await waitFor(() => logOf(s).some((e) => e.ev === "config_reload"), 7000);
  assert.equal((await prove(s.publicUrl, body, { key: TEST_KEY })).status, 200);
});

test("bad keys get the IP banned", async (t) => {
  const s = await serve(t, { limits: { badKey: { maxFailures: 3, windowMin: 10, banMin: 60 } } });
  for (let i = 0; i < 3; i++) assert.equal((await prove(s.publicUrl, body, { key: "wrong" })).status, 401);
  const banned = await prove(s.publicUrl, body, { key: TEST_KEY });
  assert.equal(banned.status, 403);
  assert.equal(banned.json.reason, "banned");
  assert.ok(logOf(s).some((e) => e.ev === "ban"));
});

test("bans are per client address (X-Forwarded-For)", async (t) => {
  const s = await serve(t, { limits: { badKey: { maxFailures: 3, windowMin: 10, banMin: 60 } } });
  const post = (key: string, forwardedFor: string) =>
    fetch(`${s.publicUrl}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Forwarded-For": forwardedFor },
      body: JSON.stringify(body),
    });

  for (let i = 0; i < 3; i++) assert.equal((await post("wrong", "6.6.6.6")).status, 401);
  assert.equal((await post(TEST_KEY, "6.6.6.6")).status, 403); // the banned client
  const other = await post(TEST_KEY, "7.7.7.7");
  assert.equal(other.status, 200); // another client behind the same proxy
  await other.text();
});

test("disconnect while queued: removed and not counted", async (t) => {
  process.env.FAKE_SLEEP = "2";
  const s = await serve(t);
  const trace = path.join(s.home.root, "trace.log");
  process.env.FAKE_TRACE = trace;

  const aStarted = deferred();
  const pa = prove(s.lanUrl, body, { onEvent: (e) => e.event === "started" && aStarted.resolve() });
  await aStarted.promise;

  const controller = new AbortController();
  const queued = deferred();
  const pb = prove(s.publicUrl, body, {
    key: TEST_KEY,
    signal: controller.signal,
    onEvent: (e) => e.event === "queued" && queued.resolve(),
  });
  await queued.promise;
  controller.abort();
  await pb;
  await waitFor(() =>
    logOf(s).some((e) => e.ev === "abort" && e.site === "voty" && e.reason === "client_disconnected"),
  );

  await pa; // the LAN proof ends
  assert.equal((await statusOf(s)).usage.used.voty ?? 0, 0);
  assert.equal(traceMarks(trace).filter((mark) => mark === "start").length, 1);
});

test("disconnect while running: proof killed and counted", async (t) => {
  process.env.FAKE_SLEEP = "30";
  const s = await serve(t);
  const controller = new AbortController();
  const started = deferred();
  const p = prove(s.publicUrl, body, {
    key: TEST_KEY,
    signal: controller.signal,
    onEvent: (e) => e.event === "started" && started.resolve(),
  });
  await started.promise;
  controller.abort();
  await p;

  await waitFor(() => logOf(s).some((e) => e.ev === "abort" && e.site === "voty"), 7000);
  assert.equal((await statusOf(s)).usage.used.voty, 1);
  await waitFor(() => pgrepF(s.home.root).length === 0, 7000);
});

test("privacy: log holds no tx data or key", async (t) => {
  const s = await serve(t, { perDay: 10 });
  await prove(s.lanUrl, body);
  await prove(s.publicUrl, body, { key: TEST_KEY });

  process.env.FAKE_MODE = "fail";
  process.env.FAKE_LEAK = tx.calldata[6]; // the prover repeats a value of the calldata in its message
  const failed = await prove(s.publicUrl, body, { key: TEST_KEY });
  assert.equal(last(failed.events).event, "error");
  await prove(s.publicUrl, body, { key: "wrong" });

  const text = fs.readFileSync(path.join(s.home.layout.logsDir, "sepolia.log"), "utf8");
  for (const secret of [TEST_KEY, "wrong", tx.calldata[6], tx.signature[0]]) {
    assert.ok(!text.includes(secret), `the log contains ${secret.slice(0, 12)}…`);
  }
  assert.ok(text.includes("Vote is not open")); // the reason is logged, without the value
});

test("body checks", async (t) => {
  const s = await serve(t, { limits: { maxBodyKB: 2 } });
  assert.ok(JSON.stringify(body).length < 2048); // the reference transaction fits

  const big = await prove(s.lanUrl, null, { rawBody: JSON.stringify({ pad: "x".repeat(4096) }) });
  assert.equal(big.status, 413);
  assert.equal(big.json.reason, "body_too_large");

  const broken = await prove(s.lanUrl, null, { rawBody: "{bad" });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.reason, "invalid_json");

  const wrongVersion = await prove(s.lanUrl, { blockNumber: 123, tx: { ...tx, version: "0x1" } });
  assert.equal(wrongVersion.status, 400);
  assert.equal(wrongVersion.json.reason, "invalid_body");
  assert.match(wrongVersion.json.error, /tx\.version/);
});

test("a JSON body sent with another content type is refused", async (t) => {
  const s = await serve(t);
  // What a web page could send to the key-less LAN listener without a CORS preflight.
  const response = await fetch(`${s.lanUrl}/prove`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).reason, "invalid_body");
  assert.equal((await statusOf(s)).running.length, 0);
});

test("health and status", async (t) => {
  const s = await serve(t);
  const lanHealth = await fetch(`${s.lanUrl}/health`);
  assert.equal(lanHealth.status, 200);
  assert.deepEqual(await lanHealth.json(), { ok: true, network: "sepolia", queueLength: 0, running: 0 });

  assert.equal((await fetch(`${s.publicUrl}/health`)).status, 200);
  const publicStatus = await fetch(`${s.publicUrl}/status`);
  assert.equal(publicStatus.status, 404);
  assert.deepEqual(await publicStatus.json(), { error: "Not found" });

  const lanStatus = await fetch(`${s.lanUrl}/status`);
  assert.equal(lanStatus.status, 200);
  assert.equal((await lanStatus.json()).inst, "sepolia");
  assert.equal((await fetch(`${s.lanUrl}/nothing`)).status, 404);
});

test("the LAN app refuses a source outside the private ranges", async (t) => {
  const written: Array<[string, any]> = [];
  const deps = {
    inst: { network: "sepolia" },
    service: { health: () => ({ ok: true, network: "sepolia", queueLength: 0, running: 0 }) },
    bans: new BanList(),
    log: { write: (ev: string, fields: any) => written.push([ev, fields]) },
  } as unknown as AppDeps;
  const app = createLanApp(deps);
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "8.8.8.8", configurable: true });
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as net.AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, "not_private");
  assert.deepEqual(
    written.map(([ev, fields]) => [ev, fields.reason, fields.ip]),
    [["reject", "not_private", "8.8.8.8"]],
  );
});

test("LAN listener answers on ::1", async (t) => {
  const hasIpv6 = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
  if (!hasIpv6) {
    t.skip("no IPv6 loopback on this machine");
    return;
  }
  const s = await serve(t);
  const { port } = new URL(s.lanUrl);
  const response = await fetch(`http://[::1]:${port}/health`);
  assert.equal(response.status, 200);
});

test("failure reason reaches the site; stderr only the LAN", async (t) => {
  process.env.FAKE_MODE = "fail";
  const s = await serve(t, { perDay: 10 });
  const forSite = last((await prove(s.publicUrl, body, { key: TEST_KEY })).events);
  assert.equal(forSite.event, "error");
  assert.match(forSite.data.message, /Vote is not open/);
  assert.equal("stderr" in forSite.data, false);

  const forLan = last((await prove(s.lanUrl, body)).events);
  assert.equal(forLan.event, "error");
  assert.match(forLan.data.stderr, /progress: step 1\/2/);
});

// ---- startup ----

async function prepared(
  t: TestContext,
  opts: { chainId?: string; binary?: string; lanPort?: number; rpcUrl?: string } = {},
): Promise<TestHome> {
  const home = await makeHome();
  const rpc = await startFakeRpc(opts.chainId ?? CHAIN_IDS.sepolia);
  t.after(async () => {
    await rpc.close();
    home.cleanup();
  });
  fs.mkdirSync(home.layout.repoDir, { recursive: true });
  home.writeInstance("sepolia", {
    NETWORK: "sepolia",
    STARKNET_RPC_URL: opts.rpcUrl ?? rpc.url,
    LAN_PORT: opts.lanPort ?? (await freePort()),
    PUBLIC_ENABLED: false,
    SNIP36_BINARY: opts.binary ?? FAKE_SNIP36,
  });
  home.writeSites({});
  return home;
}

async function startupError(home: TestHome, name = "sepolia"): Promise<StartupError> {
  try {
    await startServer(home.layout, name);
  } catch (err) {
    assert.ok(err instanceof StartupError, String(err));
    return err;
  }
  throw new assert.AssertionError({ message: "startServer should have failed" });
}

test("startup failures explain what to do", async (t) => {
  const wrongNetwork = await startupError(await prepared(t, { chainId: CHAIN_IDS.mainnet }));
  assert.match(wrongNetwork.message, /SN_MAIN/);
  assert.match(wrongNetwork.message, /NETWORK=sepolia/);

  const noBinary = await startupError(await prepared(t, { binary: "/nonexistent/snip36" }));
  assert.match(noBinary.message, /proof-server\.sh setup/);

  const brokenSites = await prepared(t);
  fs.writeFileSync(brokenSites.layout.sitesFile, "{ bad");
  assert.match((await startupError(brokenSites)).message, /sites\.json/);

  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", resolve));
  t.after(() => blocker.close());
  const taken = (blocker.address() as net.AddressInfo).port;
  assert.match((await startupError(await prepared(t, { lanPort: taken }))).message, /already in use/);

  const closedPort = await freePort();
  const unreachable = await startupError(await prepared(t, { rpcUrl: `http://127.0.0.1:${closedPort}` }));
  assert.match(unreachable.message, /unreachable: .*ECONNREFUSED/);

  const home = await prepared(t);
  assert.match((await startupError(home, "nope")).message, /example\.env/);
});

import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "fs";
import path from "path";
import { ConfigStore, Limits } from "../src/config";
import { InstanceConfig } from "../src/instance";
import { hashKey } from "../src/keys";
import { instanceFiles } from "../src/layout";
import { JsonlLogger } from "../src/log";
import { ProofRun, ProofSpec, ProverResult } from "../src/prover";
import { QuotaStore } from "../src/quota";
import { Admission, ProofService, ProveJob } from "../src/service";
import { tryAcquireSlot } from "../src/slots";
import { FAKE_OUT } from "./helpers/fake";
import { FakeProver, RecordingSink, fakeProver } from "./helpers/fake-run";
import { TestHome, makeHome, waitFor } from "./helpers/home";

const NOW = Date.parse("2026-10-28T23:00:00Z"); // 3600 s before midnight UTC
const tx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));

const INST: InstanceConfig = {
  name: "sepolia",
  network: "sepolia",
  rpcUrl: "http://127.0.0.1:1/rpc",
  lanPort: 3030,
  publicEnabled: true,
  publicPort: 4030,
  logMaxBytes: 1e6,
  logFiles: 3,
  snip36Binary: "/unused",
};

const DONE: ProverResult = { kind: "done", output: FAKE_OUT, durMs: 44000 };
const FAILED: ProverResult = {
  kind: "fail",
  exitCode: 1,
  signal: null,
  reason: "Vote is not open",
  stderrTail: "x\nVote is not open",
  durMs: 1000,
};

interface Rig {
  h: TestHome;
  store: ConfigStore;
  quota: QuotaStore;
  service: ProofService;
  fake: FakeProver;
}

function writeSites(h: TestHome, limits: Partial<Limits> = {}, enabled = true, perDay = 2): void {
  h.writeSites({ limits, sites: { voty: { keySha256: hashKey("K"), enabled, perDay: { sepolia: perDay } } } });
}

async function setup(
  t: TestContext,
  opts: { limits?: Partial<Limits>; perDay?: number; startProof?: (spec: ProofSpec) => ProofRun } = {},
): Promise<Rig> {
  const h = await makeHome();
  writeSites(h, opts.limits, true, opts.perDay);
  const store = new ConfigStore(h.layout.sitesFile);
  store.start();
  const files = instanceFiles(h.layout, INST.name);
  const quota = new QuotaStore(files.usageFile, () => new Date(NOW));
  const log = new JsonlLogger({ file: files.logFile, inst: INST.name, maxBytes: 1e6, maxFiles: 3 });
  const fake = fakeProver();
  const service = new ProofService({
    inst: INST,
    layout: h.layout,
    config: store,
    quota,
    log,
    startProof: opts.startProof ?? fake.start,
    now: () => NOW,
  });
  t.after(async () => {
    await service.shutdown(0);
    store.stop();
    h.cleanup();
  });
  return { h, store, quota, service, fake };
}

function makeJob(reqId: string, site = "voty", lan = false): { job: ProveJob; sink: RecordingSink } {
  const sink = new RecordingSink();
  return { job: { reqId, site, lan, ip: "1.2.3.4", blockNumber: 123, tx, sse: sink, enqueuedAt: NOW }, sink };
}

function refusal(admission: Admission): Extract<Admission, { ok: false }> {
  assert.equal(admission.ok, false);
  return admission as Extract<Admission, { ok: false }>;
}

// Runs A and queues B for the same site.
async function runAandQueueB(r: Rig): Promise<{ a: RecordingSink; b: RecordingSink }> {
  const a = makeJob("A");
  const b = makeJob("B");
  r.service.submit(a.job);
  await waitFor(() => r.fake.specs.length === 1);
  r.service.submit(b.job);
  return { a: a.sink, b: b.sink };
}

test("a LAN job gets queued, started, then done", async (t) => {
  const r = await setup(t);
  const { job, sink } = makeJob("A", "lan", true);
  r.service.submit(job);
  await waitFor(() => r.fake.specs.length === 1);
  assert.deepEqual(sink.events, [
    { event: "queued", data: { position: 1, etaSec: 0 } },
    { event: "started", data: {} },
  ]);
  r.fake.finish(0, DONE);
  await waitFor(() => sink.closed);
  assert.deepEqual(sink.events.at(-1), { event: "done", data: FAKE_OUT });
  assert.equal(r.quota.used("lan"), 0);
});

test("LAN jobs are admitted even when the queue is full", async (t) => {
  const r = await setup(t, { limits: { queueMax: 0 } });
  assert.deepEqual(r.service.admit("x", true), { ok: true });
  const refused = refusal(r.service.admit("voty", false));
  assert.equal(refused.status, 503);
  assert.equal(refused.reason, "queue_full");
  assert.ok((refused.retryAfterSec ?? 0) >= 1);
});

test("quota counts launched and queued jobs", async (t) => {
  const r = await setup(t);
  await runAandQueueB(r);
  const refused = refusal(r.service.admit("voty", false));
  assert.equal(refused.status, 429);
  assert.equal(refused.reason, "quota_exceeded");
  assert.equal(refused.retryAfterSec, 3600);
});

test("site_busy when the site already has perSiteQueueMax jobs", async (t) => {
  const r = await setup(t, { perDay: 100, limits: { perSiteQueueMax: 2 } });
  await runAandQueueB(r);
  const refused = refusal(r.service.admit("voty", false));
  assert.equal(refused.status, 429);
  assert.equal(refused.reason, "site_busy");
});

test("queue_full", async (t) => {
  const r = await setup(t, { perDay: 100, limits: { perSiteQueueMax: 5, queueMax: 1 } });
  await runAandQueueB(r);
  const refused = refusal(r.service.admit("voty", false));
  assert.equal(refused.status, 503);
  assert.equal(refused.reason, "queue_full");
  assert.equal(refused.retryAfterSec, 120); // 1 queued + 1 running, 60 s each
});

test("wait_too_long counts jobs ahead", async (t) => {
  const r = await setup(t, { perDay: 100, limits: { perSiteQueueMax: 5, maxWaitSec: 100 } });
  r.service.submit(makeJob("A").job);
  await waitFor(() => r.fake.specs.length === 1);
  assert.deepEqual(r.service.admit("voty", false), { ok: true }); // 1 job ahead: 60 s
  r.service.submit(makeJob("B").job);
  const refused = refusal(r.service.admit("voty", false)); // 2 jobs ahead: 120 s
  assert.equal(refused.status, 503);
  assert.equal(refused.reason, "wait_too_long");
  assert.equal(refused.retryAfterSec, 120);
});

test("LAN jobs jump ahead of external ones", async (t) => {
  const r = await setup(t, { perDay: 100, limits: { perSiteQueueMax: 5 } });
  r.service.submit(makeJob("A").job);
  await waitFor(() => r.fake.specs.length === 1);
  r.service.submit(makeJob("B").job);
  r.service.submit(makeJob("C", "lan", true).job);
  r.fake.finish(0, DONE);
  await waitFor(() => r.fake.specs.length === 2);
  assert.equal(r.fake.specs[1].jobId, "C");
});

test("quota is counted at launch, not at admission", async (t) => {
  const r = await setup(t);
  await runAandQueueB(r);
  assert.equal(r.quota.used("voty"), 1);
  r.fake.finish(0, DONE);
  await waitFor(() => r.fake.specs.length === 2);
  assert.equal(r.quota.used("voty"), 2);
});

test("cancel while queued removes the job without counting it", async (t) => {
  const r = await setup(t);
  const { a, b } = await runAandQueueB(r);
  r.service.cancel("B");
  assert.ok(!b.names.includes("started"));
  const aborts = r.h.readLog("sepolia").filter((e) => e.ev === "abort");
  assert.deepEqual(aborts.map((e) => [e.reqId, e.site, e.reason]), [["B", "voty", "client_disconnected"]]);
  assert.equal(r.quota.used("voty"), 1);

  r.fake.finish(0, DONE);
  await waitFor(() => a.closed);
  await sleep(100);
  assert.equal(r.fake.specs.length, 1); // B never starts
});

test("cancel while running kills the proof", async (t) => {
  const r = await setup(t);
  const a = makeJob("A");
  r.service.submit(a.job);
  await waitFor(() => r.fake.specs.length === 1);
  r.service.cancel("A");
  assert.deepEqual(r.fake.killed, [{ index: 0, reason: "abort" }]);
  await waitFor(() => a.sink.closed);
  const aborts = r.h.readLog("sepolia").filter((e) => e.ev === "abort");
  assert.deepEqual(aborts.map((e) => [e.reqId, e.reason]), [["A", "client_disconnected"]]);
  assert.equal(r.quota.used("voty"), 1);
});

test("failure and timeout messages", async (t) => {
  const r = await setup(t);

  const external = makeJob("E");
  r.service.submit(external.job);
  await waitFor(() => r.fake.specs.length === 1);
  r.fake.finish(0, FAILED);
  await waitFor(() => external.sink.closed);
  assert.deepEqual(external.sink.events.at(-1), {
    event: "error",
    data: { message: "Proof generation failed: Vote is not open" },
  });

  const lan = makeJob("L", "lan", true);
  r.service.submit(lan.job);
  await waitFor(() => r.fake.specs.length === 2);
  r.fake.finish(1, FAILED);
  await waitFor(() => lan.sink.closed);
  assert.deepEqual(lan.sink.events.at(-1), {
    event: "error",
    data: { message: "Proof generation failed: Vote is not open", stderr: "x\nVote is not open" },
  });

  const slow = makeJob("T");
  r.service.submit(slow.job);
  await waitFor(() => r.fake.specs.length === 3);
  r.fake.finish(2, { kind: "killed", reason: "timeout", durMs: 600000 });
  await waitFor(() => slow.sink.closed);
  assert.deepEqual(slow.sink.events.at(-1), { event: "error", data: { message: "Proof timed out after 600 s" } });

  const log = r.h.readLog("sepolia");
  assert.deepEqual(
    log.filter((e) => e.ev === "fail").map((e) => [e.reqId, e.reason]),
    [
      ["E", "Vote is not open"],
      ["L", "Vote is not open"],
    ],
  );
  assert.deepEqual(log.filter((e) => e.ev === "timeout").map((e) => e.reqId), ["T"]);
});

test("disabling a site rejects its queued jobs", async (t) => {
  const r = await setup(t);
  const { b } = await runAandQueueB(r);
  writeSites(r.h, {}, false);
  r.store.reloadNow();
  assert.deepEqual(b.events.at(-1), { event: "error", data: { message: "Access for this site was revoked" } });
  assert.equal(b.closed, true);
  const rejects = r.h.readLog("sepolia").filter((e) => e.ev === "reject");
  assert.deepEqual(rejects.map((e) => [e.reqId, e.site, e.reason]), [["B", "voty", "site_revoked"]]);
  assert.deepEqual(r.fake.killed, []); // the running proof continues
});

test("shutdown rejects queued jobs, lets the running one finish, then refuses new jobs", async (t) => {
  const r = await setup(t);
  const { a, b } = await runAandQueueB(r);
  const stopped = r.service.shutdown(5000);

  assert.deepEqual(b.events.at(-1), { event: "error", data: { message: "Server is shutting down" } });
  assert.equal(b.closed, true);
  for (const refused of [refusal(r.service.admit("voty", false)), refusal(r.service.admit("x", true))]) {
    assert.equal(refused.status, 503);
    assert.equal(refused.reason, "shutting_down");
  }
  assert.equal(r.service.health().ok, false);

  r.fake.finish(0, DONE);
  await stopped;
  assert.equal(a.events.at(-1)?.event, "done");
  const aborts = r.h.readLog("sepolia").filter((e) => e.ev === "abort");
  assert.deepEqual(aborts.map((e) => [e.reqId, e.reason]), [["B", "shutdown"]]);
});

test("shutdown kills a run that outlives the grace", async (t) => {
  const r = await setup(t);
  const a = makeJob("A");
  r.service.submit(a.job);
  await waitFor(() => r.fake.specs.length === 1);
  await r.service.shutdown(200);
  assert.deepEqual(r.fake.killed, [{ index: 0, reason: "shutdown" }]);
  assert.deepEqual(a.sink.events.at(-1), { event: "error", data: { message: "Server is shutting down" } });
  assert.equal(a.sink.closed, true);
});

test("a slot held elsewhere delays the job", async (t) => {
  const r = await setup(t);
  const hold = await tryAcquireSlot(r.h.layout, 1);
  assert.ok(hold);
  t.after(() => hold.release());
  r.service.submit(makeJob("A").job);
  await sleep(300);
  assert.equal(r.fake.specs.length, 0);
  await hold.release();
  await waitFor(() => r.fake.specs.length === 1, 2500);
});

test("status lists jobs without transaction data", async (t) => {
  const r = await setup(t);
  await runAandQueueB(r);
  const status = r.service.status();
  assert.equal(status.inst, "sepolia");
  assert.deepEqual(status.running.map((j) => [j.reqId, j.site]), [["A", "voty"]]);
  assert.deepEqual(status.queue.map((j) => [j.reqId, j.site]), [["B", "voty"]]);
  assert.deepEqual(status.usage, { day: "2026-10-28", used: { voty: 1 } });
  assert.deepEqual(status.sites, [{ name: "voty", enabled: true, perDay: { sepolia: 2 } }]);
  const text = JSON.stringify(status);
  assert.ok(!text.includes(tx.calldata[6]));
  assert.ok(!text.includes(tx.signature[0]));
  assert.ok(!text.includes("keySha256"));
  assert.ok(!text.includes(hashKey("K")));
});

test("the prover lines go to LAN clients only", async (t) => {
  const r = await setup(t);
  const external = makeJob("E");
  r.service.submit(external.job);
  await waitFor(() => r.fake.specs.length === 1);
  assert.equal(r.fake.specs[0].onLine, undefined);
  r.fake.finish(0, DONE);
  await waitFor(() => external.sink.closed);

  const lan = makeJob("L", "lan", true);
  r.service.submit(lan.job);
  await waitFor(() => r.fake.specs.length === 2);
  r.fake.specs[1].onLine?.("stdout", "hello");
  assert.deepEqual(lan.sink.events.at(-1), { event: "log", data: { stream: "stdout", line: "hello" } });
});

test("queue positions are announced again when they change", async (t) => {
  const r = await setup(t, { perDay: 100, limits: { perSiteQueueMax: 5 } });
  r.service.submit(makeJob("A").job);
  await waitFor(() => r.fake.specs.length === 1);
  const b = makeJob("B");
  const c = makeJob("C");
  r.service.submit(b.job);
  r.service.submit(c.job);
  assert.deepEqual(b.sink.events, [{ event: "queued", data: { position: 1, etaSec: 60 } }]);
  assert.deepEqual(c.sink.events, [{ event: "queued", data: { position: 2, etaSec: 120 } }]);

  r.fake.finish(0, DONE);
  await waitFor(() => r.fake.specs.length === 2); // B starts, C moves up
  assert.deepEqual(b.sink.names, ["queued", "started"]);
  assert.deepEqual(c.sink.events, [
    { event: "queued", data: { position: 2, etaSec: 120 } },
    { event: "queued", data: { position: 1, etaSec: 44 } }, // B runs: the 44 s of A now feed the estimate
  ]);
});

test("a start that throws fails the job and frees the slot", async (t) => {
  const r = await setup(t, {
    startProof: () => {
      throw new Error("boom");
    },
  });
  const a = makeJob("A");
  r.service.submit(a.job);
  await waitFor(() => a.sink.closed);
  assert.deepEqual(a.sink.events.at(-1), { event: "error", data: { message: "Proof generation failed: boom" } });
  const lock = await tryAcquireSlot(r.h.layout, 1);
  assert.ok(lock);
  await lock.release();
});

test("measured durations feed the wait estimate", async (t) => {
  const r = await setup(t, { perDay: 100, limits: { perSiteQueueMax: 5, queueMax: 1 } });
  const a = makeJob("A");
  r.service.submit(a.job);
  await waitFor(() => r.fake.specs.length === 1);
  r.fake.finish(0, DONE); // 44 s
  await waitFor(() => a.sink.closed);

  r.service.submit(makeJob("C").job);
  await waitFor(() => r.fake.specs.length === 2);
  r.service.submit(makeJob("D").job);
  const refused = refusal(r.service.admit("voty", false));
  assert.equal(refused.reason, "queue_full");
  assert.equal(refused.retryAfterSec, 88); // 1 queued + 1 running, 44 s each
});

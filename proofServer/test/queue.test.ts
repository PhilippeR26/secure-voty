import assert from "node:assert/strict";
import test from "node:test";
import { DurationEstimator, ProofQueue, Queued, estimateWaitSec } from "../src/queue";

const job = (reqId: string, site: string, lan = false): Queued => ({ reqId, site, lan });
const ids = (q: ProofQueue<Queued>) => q.items().map((i) => i.reqId);

test("LAN jobs go before external ones, in arrival order", () => {
  const q = new ProofQueue<Queued>();
  q.enqueue(job("a", "voty"));
  q.enqueue(job("b", "voty"));
  q.enqueue(job("c", "lan", true));
  q.enqueue(job("d", "lan", true));
  q.enqueue(job("e", "other"));
  assert.deepEqual(ids(q), ["c", "d", "a", "b", "e"]);
  assert.equal(q.position("a"), 3);
  assert.equal(q.position("zz"), 0);
  assert.equal(q.shift()!.reqId, "c");
  assert.equal(q.remove("b")!.reqId, "b");
  assert.equal(q.size(), 3);
  assert.deepEqual(ids(q), ["d", "a", "e"]);
});

test("countBySite and removeWhere", () => {
  const q = new ProofQueue<Queued>();
  q.enqueue(job("a", "voty"));
  q.enqueue(job("b", "voty"));
  q.enqueue(job("c", "other"));
  q.enqueue(job("d", "lan", true));
  assert.equal(q.countBySite("voty"), 2);
  assert.equal(q.countBySite("other"), 1);
  assert.equal(q.countBySite("lan"), 1);
  assert.equal(q.countBySite("zz"), 0);

  const removed = q.removeWhere((item) => item.site === "voty");
  assert.deepEqual(removed.map((i) => i.reqId), ["a", "b"]);
  assert.deepEqual(ids(q), ["d", "c"]);
  assert.equal(q.size(), 2);
});

test("an empty queue or an unknown id does not fail; items() is a copy", () => {
  const q = new ProofQueue<Queued>();
  assert.equal(q.shift(), undefined);
  assert.equal(q.remove("zz"), undefined);
  assert.deepEqual(q.removeWhere(() => true), []);

  q.enqueue(job("a", "voty"));
  assert.equal(q.remove("zz"), undefined);
  (q.items() as Queued[]).pop();
  assert.equal(q.size(), 1);
});

test("DurationEstimator: initial value, then a sliding window of 10", () => {
  const e = new DurationEstimator();
  assert.equal(e.averageMs(), 60000);
  for (let i = 1; i <= 10; i++) e.add(i * 1000);
  assert.equal(e.averageMs(), 5500);
  e.add(20000);
  assert.equal(e.averageMs(), 7400);
});

test("DurationEstimator ignores invalid durations", () => {
  const e = new DurationEstimator(10, 1000);
  e.add(NaN);
  e.add(-5);
  e.add(Infinity);
  assert.equal(e.averageMs(), 1000);
  e.add(3000);
  assert.equal(e.averageMs(), 3000);
});

test("estimateWaitSec", () => {
  assert.equal(estimateWaitSec(0, 44000), 0);
  assert.equal(estimateWaitSec(3, 44000), 132);
  assert.equal(estimateWaitSec(1, 1500), 2);
});

import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { QuotaStore, secondsUntilUtcMidnight, utcDay } from "../src/quota";

const at = () => new Date("2026-10-28T10:00:00Z");

function tmpUsageFile(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state", "sepolia", "usage.json");
}

test("utcDay and secondsUntilUtcMidnight", () => {
  assert.equal(utcDay(new Date("2026-10-28T23:59:59Z")), "2026-10-28");
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-28T23:00:00Z")), 3600);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-28T23:59:59.500Z")), 1);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-29T00:00:00Z")), 86400);
});

test("QuotaStore counts per site and persists", (t) => {
  const file = tmpUsageFile(t);
  const quota = new QuotaStore(file, at);
  quota.increment("voty");
  quota.increment("voty");
  assert.equal(quota.used("voty"), 2);
  assert.equal(quota.used("x"), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { day: "2026-10-28", used: { voty: 2 } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["usage.json"]); // no temporary file left
  assert.equal(new QuotaStore(file, at).used("voty"), 2);
});

test("QuotaStore resets at 00:00 UTC", (t) => {
  const file = tmpUsageFile(t);
  let now = new Date("2026-10-28T23:59:59Z");
  const quota = new QuotaStore(file, () => now);
  quota.increment("voty");
  assert.equal(quota.used("voty"), 1);

  now = new Date("2026-10-29T00:00:00Z");
  assert.equal(quota.used("voty"), 0);
  assert.equal(quota.snapshot().day, "2026-10-29");

  quota.increment("voty");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { day: "2026-10-29", used: { voty: 1 } });
});

test("a file from an older day reads as zero", (t) => {
  const file = tmpUsageFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ day: "2026-10-27", used: { voty: 5 } }));
  const quota = new QuotaStore(file, at);
  assert.equal(quota.used("voty"), 0);
  assert.deepEqual(quota.snapshot(), { day: "2026-10-28", used: {} });
});

test("an unreadable usage file starts from zero and warns", (t) => {
  const file = tmpUsageFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ bad");
  const errors = t.mock.method(console, "error", () => {});
  const quota = new QuotaStore(file, at);
  assert.equal(quota.used("voty"), 0);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /usage\.json/);
});

test("a failing write keeps the count in memory and warns", (t) => {
  const file = tmpUsageFile(t);
  fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.dirname(file), ""); // a regular file where the instance directory should be
  const errors = t.mock.method(console, "error", () => {});
  const quota = new QuotaStore(file, at);
  assert.doesNotThrow(() => quota.increment("voty"));
  assert.equal(quota.used("voty"), 1);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /usage/);
});

test("names inherited from Object are not sites; snapshot is a copy", (t) => {
  const quota = new QuotaStore(tmpUsageFile(t), at);
  assert.equal(quota.used("constructor"), 0);
  quota.increment("voty");
  const snap = quota.snapshot();
  snap.used.voty = 99;
  assert.equal(quota.used("voty"), 1);
});

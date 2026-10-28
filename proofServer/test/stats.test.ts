import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "fs";
import path from "path";
import { main } from "../src/cli/main";
import { LogRecord } from "../src/log";
import { REJECT_CATEGORY, computeStats, formatStats, percentile, readLogRecords } from "../src/cli/stats";
import { TestHome, makeHome } from "./helpers/home";

const FIXTURE = path.join(__dirname, "fixtures", "stats.log");
const fixtureLines = fs.readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);

const zero = { auth: 0, quota: 0, overload: 0, invalid: 0 };
const EXPECTED_ROWS = [
  { day: "2026-10-28", site: "(unknown)", requests: 0, done: 0, failed: 0, timeouts: 0, aborted: 0, rejected: { ...zero, auth: 1 }, durMedianMs: null, durP95Ms: null, waitMedianMs: null, waitMaxMs: null },
  { day: "2026-10-28", site: "voty", requests: 3, done: 2, failed: 0, timeouts: 0, aborted: 0, rejected: { ...zero, quota: 1 }, durMedianMs: 44000, durP95Ms: 50000, waitMedianMs: 20, waitMaxMs: 30000 },
  { day: "2026-10-29", site: "lan", requests: 1, done: 0, failed: 1, timeouts: 0, aborted: 0, rejected: zero, durMedianMs: null, durP95Ms: null, waitMedianMs: 10, waitMaxMs: 10 },
];

// A home whose logs directory holds the reference log as the log of the instance sepolia.
async function homeWithFixture(t: TestContext): Promise<TestHome> {
  const home = await makeHome();
  t.after(() => home.cleanup());
  fs.mkdirSync(home.layout.logsDir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(home.layout.logsDir, "sepolia.log"));
  return home;
}

async function run(home: TestHome, ...args: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(["stats", ...args], home.layout, (line) => lines.push(line));
  return { code, text: lines.join("\n") };
}

test("percentile is nearest-rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([40, 10, 30, 20], 50), 20); // the input need not be sorted
});

test("computeStats on the reference log", async (t) => {
  const home = await homeWithFixture(t);
  const result = computeStats(readLogRecords(home.layout.logsDir));
  assert.deepEqual(result.rows, EXPECTED_ROWS);
  assert.deepEqual(result.global, { peakQueue: 2, timeouts: 0, busiestHour: "2026-10-28T10" });
});

test("filters", async (t) => {
  const home = await homeWithFixture(t);
  const records = readLogRecords(home.layout.logsDir);
  assert.deepEqual(computeStats(records, { day: "2026-10-29" }).rows, [EXPECTED_ROWS[2]]);
  assert.deepEqual(computeStats(records, { site: "voty" }).rows, [EXPECTED_ROWS[1]]);
  assert.deepEqual(computeStats(records, { since: new Date("2026-10-29T00:00:00Z") }).rows, [EXPECTED_ROWS[2]]);
  assert.deepEqual(computeStats(records, { instance: "mainnet" }).rows, []);
  assert.deepEqual(computeStats(records, { site: "(unknown)" }).rows, [EXPECTED_ROWS[0]]);
});

test("readLogRecords reads rotated files oldest first, all instances", async (t) => {
  const home = await makeHome();
  t.after(() => home.cleanup());
  const dir = home.layout.logsDir;
  fs.mkdirSync(dir, { recursive: true });
  // .log.10 is older than .log.2: the numbers are compared as numbers
  fs.writeFileSync(path.join(dir, "sepolia.log.10"), fixtureLines.slice(0, 4).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "sepolia.log.2"), fixtureLines.slice(4, 8).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "sepolia.log"), fixtureLines.slice(8).join("\n") + "\n");
  const mainnet = { ts: "2026-10-28T12:00:00.000Z", inst: "mainnet", ev: "request", reqId: "m", site: "voty", ip: "2.2.2.2" };
  fs.writeFileSync(path.join(dir, "mainnet.log"), JSON.stringify(mainnet) + "\n");

  const all = readLogRecords(dir);
  assert.equal(all.length, 16); // 15 valid lines of the fixture, one record of mainnet; the broken line is skipped
  const expected = fixtureLines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).reqId);
  assert.deepEqual(all.filter((r) => r.inst === "sepolia").map((r) => r.reqId), expected);
  assert.deepEqual(readLogRecords(dir, "mainnet").map((r) => r.reqId), ["m"]);
});

test("the logs of Caddy and the console files are not instance logs", async (t) => {
  const home = await homeWithFixture(t);
  const dir = home.layout.logsDir;
  fs.writeFileSync(path.join(dir, "caddy.log"), '{"level":"info","ts":1761000000.5,"msg":"served"}\n');
  fs.writeFileSync(path.join(dir, "caddy.stdout"), "started\n");
  fs.writeFileSync(path.join(dir, "sepolia.stdout"), '{"ts":"2026-10-28T10:00:00.000Z","inst":"sepolia","ev":"request"}\n');
  assert.equal(readLogRecords(dir).length, 15);
});

test("events that are not about a request make no row", () => {
  const record = (ev: LogRecord["ev"], extra: Partial<LogRecord> = {}): LogRecord => ({
    ts: "2026-10-28T10:00:00.000Z",
    inst: "sepolia",
    ev,
    ...extra,
  });
  const result = computeStats([
    record("startup", { msg: "network=sepolia" }),
    record("config_reload"),
    record("config_error", { msg: "x" }),
    record("ban", { ip: "6.6.6.6" }),
    record("shutdown"),
  ]);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.global, { peakQueue: 0, timeouts: 0, busiestHour: null });
});

test("timeouts and aborts are counted per site and globally", () => {
  const at = (ev: LogRecord["ev"], extra: Partial<LogRecord>): LogRecord => ({ ts: "2026-10-28T10:00:00.000Z", inst: "i", ev, site: "voty", ...extra });
  const result = computeStats([at("timeout", { durMs: 600000 }), at("abort", { reason: "client_disconnected" }), at("abort", { reason: "shutdown" })]);
  assert.equal(result.rows[0].timeouts, 1);
  assert.equal(result.rows[0].aborted, 2);
  assert.equal(result.global.timeouts, 1);
});

test("the busiest hour: the earliest one when several are tied", () => {
  const request = (ts: string): LogRecord => ({ ts, inst: "i", ev: "request", site: "voty" });
  const result = computeStats([request("2026-10-28T14:10:00Z"), request("2026-10-28T09:10:00Z"), request("2026-10-28T09:20:00Z"), request("2026-10-28T14:20:00Z")]);
  assert.equal(result.global.busiestHour, "2026-10-28T09");
});

test("every reason the server can give for a rejection has a category", () => {
  const reasons = [
    "missing_key", "unknown_key", "site_disabled", "network_not_allowed", "banned", "site_revoked",
    "quota_exceeded", "site_busy",
    "queue_full", "wait_too_long", "shutting_down",
    "invalid_json", "invalid_body", "body_too_large", "not_private",
  ];
  for (const reason of reasons) assert.ok(REJECT_CATEGORY[reason], reason);
  assert.equal(REJECT_CATEGORY.quota_exceeded, "quota");
  assert.equal(REJECT_CATEGORY.unknown_key, "auth");
});

test("formatStats shows the figures in a readable table", async (t) => {
  const home = await homeWithFixture(t);
  const text = formatStats(computeStats(readLogRecords(home.layout.logsDir)));
  assert.match(text, /voty/);
  assert.match(text, /44\.0 s/);
  assert.match(text, /30\.0 s/);
  assert.match(text, /20 ms/);
  assert.match(text, /2026-10-28T10/);
  assert.match(formatStats({ rows: [], global: { peakQueue: 0, timeouts: 0, busiestHour: null } }), /No request/);
});

test("stats command", async (t) => {
  const home = await homeWithFixture(t);
  const records = readLogRecords(home.layout.logsDir);

  const json = await run(home, "--json");
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.text), computeStats(records));

  const human = await run(home);
  assert.equal(human.code, 0);
  assert.match(human.text, /voty/);
  assert.match(human.text, /\(unknown\)/);

  const one = await run(home, "--day", "2026-10-29", "--site", "lan");
  assert.equal(one.code, 0);
  assert.match(one.text, /lan/);
  assert.ok(!one.text.includes("voty"));

  for (const bad of [["--since", "2x"], ["--day", "29-10"], ["--since", "1d", "--day", "2026-10-29"], ["--nope"]]) {
    assert.equal((await run(home, ...bad)).code, 1, bad.join(" "));
  }
});

test("stats without any log says so", async (t) => {
  const home = await makeHome();
  t.after(() => home.cleanup());
  const result = await run(home);
  assert.equal(result.code, 0);
  assert.match(result.text, /No request/);
});

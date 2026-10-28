import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { JsonlLogger, LOG_EVENTS, logFileSet } from "../src/log";

const at = () => new Date("2026-10-28T10:00:00.000Z");

function tmpFile(t: TestContext, ...subdirs: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, ...subdirs, "test.log");
}

test("one JSON object per line, ts/inst/ev first", (t) => {
  const file = tmpFile(t);
  const log = new JsonlLogger({ file, inst: "sepolia", maxBytes: 1e6, maxFiles: 3, now: at });
  log.write("request", { reqId: "r1", site: "voty", ip: "1.2.3.4" });
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '{"ts":"2026-10-28T10:00:00.000Z","inst":"sepolia","ev":"request","reqId":"r1","site":"voty","ip":"1.2.3.4"}\n',
  );
});

test("fields outside LogRecord are dropped", (t) => {
  const file = tmpFile(t);
  const log = new JsonlLogger({ file, inst: "sepolia", maxBytes: 1e6, maxFiles: 3, now: at });
  log.write("done", { reqId: "r", tx: { calldata: ["0xdead"] } } as never);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("0xdead"));
  assert.ok(text.includes('"reqId":"r"'));
});

test("rotation keeps maxFiles old files of at most maxBytes", (t) => {
  const file = tmpFile(t);
  const log = new JsonlLogger({ file, inst: "i", maxBytes: 300, maxFiles: 2, now: at });
  for (let i = 0; i < 40; i++) log.write("request", { reqId: `r${i}`.padEnd(40, "x") });
  assert.deepEqual(logFileSet(file, 2), [`${file}.2`, `${file}.1`, file]);
  assert.ok(!fs.existsSync(`${file}.3`));
  for (const f of logFileSet(file, 2)) assert.ok(fs.statSync(f).size <= 300);
  assert.match(fs.readFileSync(file, "utf8"), /r39x/);
});

test("an existing file counts toward the size limit", (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, "x".repeat(250));
  const log = new JsonlLogger({ file, inst: "i", maxBytes: 300, maxFiles: 2, now: at });
  log.write("startup");
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(250));
  assert.match(fs.readFileSync(file, "utf8"), /"ev":"startup"/);
});

test("creates the log directory", (t) => {
  const file = tmpFile(t, "not", "yet");
  const log = new JsonlLogger({ file, inst: "i", maxBytes: 1e6, maxFiles: 3, now: at });
  log.write("startup", { msg: "hello" });
  assert.match(fs.readFileSync(file, "utf8"), /"msg":"hello"/);
});

test("a failing write reports on stderr and does not throw", (t) => {
  const file = tmpFile(t);
  fs.mkdirSync(file); // a directory where the log file should be
  const errors = t.mock.method(console, "error", () => {});
  const log = new JsonlLogger({ file, inst: "i", maxBytes: 1e6, maxFiles: 3, now: at });
  assert.doesNotThrow(() => log.write("request"));
  assert.match(String(errors.mock.calls[0].arguments[0]), /^log write failed: /);
});

test("LOG_EVENTS lists the events of the design", () => {
  assert.deepEqual(
    [...LOG_EVENTS],
    ["request", "reject", "queued", "start", "done", "fail", "abort", "timeout", "ban", "config_reload", "config_error", "startup", "shutdown"],
  );
});

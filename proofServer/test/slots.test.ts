import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test, { TestContext } from "node:test";
import fs from "fs";
import net from "net";
import path from "path";
import { layoutEnv } from "../src/layout";
import { isGroupAlive, isPortFree, isProcessAlive, killGroup, waitUntil } from "../src/proc";
import { SlotInfo, killOrphanProofs, tryAcquireSlot } from "../src/slots";
import { TestHome, freePort, makeHome } from "./helpers/home";
import { pgrepF } from "./helpers/procs";

const PACKAGE_DIR = path.resolve(__dirname, "..");
const HOLD_SLOT = path.join(__dirname, "helpers", "hold-slot.ts");

// pid of a process that has already exited
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

// A process group of its own, like a proof started by the server; killed when the test ends.
function startGroup(t: TestContext, arg = "60"): number {
  const child = spawn("sleep", [arg], { detached: true, stdio: "ignore" });
  t.after(() => killGroup(child.pid!, "SIGKILL"));
  return child.pid!;
}

function writeRecord(h: TestHome, index: number, info: Partial<SlotInfo>): string {
  fs.mkdirSync(h.layout.slotsDir, { recursive: true });
  const file = path.join(h.layout.slotsDir, `slot-${index}.json`);
  const record = { ownerPid: 0, inst: "x", pgid: 0, since: new Date().toISOString(), ...info };
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

async function newHome(t: TestContext): Promise<TestHome> {
  const h = await makeHome();
  t.after(() => h.cleanup());
  return h;
}

test("one slot: busy until released", async (t) => {
  const l = (await newHome(t)).layout;
  const a = await tryAcquireSlot(l, 1);
  assert.ok(a);
  assert.equal(a.index, 0);
  assert.equal(a.runnerPort, l.runnerBasePort);
  assert.equal(await tryAcquireSlot(l, 1), null);
  await a.release();
  const b = await tryAcquireSlot(l, 1);
  assert.equal(b?.index, 0);
  await b?.release();
});

test("two slots give indexes 0 and 1", async (t) => {
  const l = (await newHome(t)).layout;
  const a = await tryAcquireSlot(l, 2);
  const b = await tryAcquireSlot(l, 2);
  assert.ok(a && b);
  assert.equal(a.index, 0);
  assert.equal(b.index, 1);
  assert.equal(b.runnerPort, l.runnerBasePort + 1);
  assert.equal(await tryAcquireSlot(l, 2), null);
  await a.release();
  await b.release();
});

test("the kernel frees a slot when its holder dies", async (t) => {
  const h = await newHome(t);
  const child = spawn(process.execPath, ["--import", "tsx", HOLD_SLOT], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...layoutEnv(h.layout) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGKILL"));
  const first = await new Promise<string>((resolve) => child.stdout!.once("data", (data) => resolve(String(data).trim())));
  assert.equal(first, "held");
  assert.equal(await tryAcquireSlot(h.layout, 1), null);

  child.kill("SIGKILL");
  const freed = await waitUntil(async () => {
    const lock = await tryAcquireSlot(h.layout, 1);
    await lock?.release();
    return lock !== null;
  }, 3000);
  assert.equal(freed, true);
});

test("taking a slot kills the orphan proof recorded for it", async (t) => {
  const h = await newHome(t);
  const orphan = startGroup(t);
  const file = writeRecord(h, 0, { ownerPid: await deadPid(), pgid: orphan });
  assert.equal(isGroupAlive(orphan), true);

  const lock = await tryAcquireSlot(h.layout, 1);
  assert.ok(lock);
  assert.equal(isGroupAlive(orphan), false);
  assert.equal(fs.existsSync(file), false);
  await lock.release();
});

test("killOrphanProofs kills dead owners' groups only", async (t) => {
  const h = await newHome(t);
  const orphan = startGroup(t);
  const live = startGroup(t);
  const deadFile = writeRecord(h, 0, { ownerPid: await deadPid(), pgid: orphan });
  const liveFile = writeRecord(h, 1, { ownerPid: process.pid, pgid: live });

  assert.equal(await killOrphanProofs(h.layout), 1);
  assert.equal(isGroupAlive(orphan), false);
  assert.equal(fs.existsSync(deadFile), false);
  assert.equal(isGroupAlive(live), true);
  assert.equal(fs.existsSync(liveFile), true);
});

test("killOrphanProofs leaves a slot whose lock is held alone", async (t) => {
  const h = await newHome(t);
  const held = await tryAcquireSlot(h.layout, 1); // a live server holds slot 0
  assert.ok(held);
  const group = startGroup(t);
  const file = writeRecord(h, 0, { ownerPid: await deadPid(), pgid: group });

  assert.equal(await killOrphanProofs(h.layout), 0);
  assert.equal(isGroupAlive(group), true);
  assert.equal(fs.existsSync(file), true);
  await held.release();
});

test("a group that is not the recorded process is not killed", async (t) => {
  const h = await newHome(t);
  const stranger = startGroup(t); // as if the recorded pid had been reused by another program
  const file = writeRecord(h, 0, { ownerPid: await deadPid(), pgid: stranger, procStart: "1" });

  assert.equal(await killOrphanProofs(h.layout), 0);
  assert.equal(isGroupAlive(stranger), true);
  assert.equal(fs.existsSync(file), false);
});

test("a corrupt record is removed without killing anything", async (t) => {
  const h = await newHome(t);
  fs.mkdirSync(h.layout.slotsDir, { recursive: true });
  const file = path.join(h.layout.slotsDir, "slot-0.json");

  fs.writeFileSync(file, "{ bad");
  assert.equal(await killOrphanProofs(h.layout), 0);
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, JSON.stringify({ ownerPid: "x", inst: 3, pgid: 1 }));
  const lock = await tryAcquireSlot(h.layout, 1);
  assert.ok(lock);
  assert.equal(fs.existsSync(file), false);
  await lock.release();
});

test("recordProof writes the owner, the group and its start time; release removes it", async (t) => {
  const h = await newHome(t);
  const group = startGroup(t);
  const lock = await tryAcquireSlot(h.layout, 1);
  assert.ok(lock);
  lock.recordProof(group, "sepolia");

  const file = path.join(h.layout.slotsDir, "slot-0.json");
  const info = JSON.parse(fs.readFileSync(file, "utf8")) as SlotInfo;
  assert.equal(info.ownerPid, process.pid);
  assert.equal(info.inst, "sepolia");
  assert.equal(info.pgid, group);
  assert.match(info.since, /^\d{4}-\d{2}-\d{2}T/);
  if (process.platform === "linux") assert.match(String(info.procStart), /^\d+$/);

  await lock.release();
  assert.equal(fs.existsSync(file), false);
  lock.recordProof(group, "sepolia"); // after release: nothing is written
  assert.equal(fs.existsSync(file), false);
});

test("killGroup never signals group 0 or 1", (t) => {
  const kill = t.mock.method(process, "kill", () => true); // a faulty guard must not kill anything here
  for (const pgid of [0, 1, -5, 1.5, NaN]) {
    killGroup(pgid, "SIGKILL");
    assert.equal(isGroupAlive(pgid), false);
  }
  assert.equal(kill.mock.callCount(), 0);
});

test("proc helpers", async () => {
  const child = spawn("sleep", ["60.25"], { detached: true, stdio: "ignore" });
  const pgid = child.pid!;
  assert.equal(isProcessAlive(pgid), true);
  assert.equal(isGroupAlive(pgid), true);
  assert.ok(pgrepF("sleep 60.25").includes(pgid));

  killGroup(pgid, "SIGKILL");
  assert.equal(await waitUntil(() => !isGroupAlive(pgid), 3000), true);
  assert.equal(isProcessAlive(pgid), false);
  assert.doesNotThrow(() => killGroup(pgid, "SIGKILL")); // dead group: ESRCH is ignored

  const port = await freePort();
  assert.equal(await isPortFree(port), true);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  assert.equal(await isPortFree(port), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await isPortFree(port), true);

  let calls = 0;
  assert.equal(await waitUntil(() => ++calls >= 3, 1000, 10), true);
  assert.equal(await waitUntil(() => false, 150, 10), false);
});

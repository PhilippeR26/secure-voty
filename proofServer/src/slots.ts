import fs from "fs";
import net from "net";
import path from "path";
import { Layout } from "./layout";
import { isGroupAlive, isPortFree, isProcessAlive, killGroup, processStartTime, waitUntil } from "./proc";

export interface SlotInfo {
  ownerPid: number;
  inst: string;
  pgid: number;
  since: string;
  procStart?: string; // start time of the group leader when it was recorded: tells it from a reused pid
}

export interface SlotLock {
  readonly index: number;
  readonly runnerPort: number;
  recordProof(pgid: number, inst: string): void;
  release(): Promise<void>;
}

const RECORD_RE = /^slot-(\d+)\.json$/;

function slotFile(layout: Layout, index: number): string {
  return path.join(layout.slotsDir, `slot-${index}.json`);
}

// null: no record, or a record that is not valid.
function readSlotInfo(file: string): SlotInfo | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { ownerPid, inst, pgid, since, procStart } = raw as Record<string, unknown>;
    if (typeof ownerPid !== "number" || !Number.isInteger(ownerPid) || ownerPid <= 0) return null;
    if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 1) return null;
    if (typeof inst !== "string" || typeof since !== "string") return null;
    if (procStart !== undefined && typeof procStart !== "string") return null;
    return { ownerPid, inst, pgid, since, ...(procStart !== undefined && { procStart }) };
  } catch {
    return null;
  }
}

// False when the group id now belongs to another program (the pid was reused).
function isRecordedProcess(info: SlotInfo): boolean {
  if (info.procStart === undefined) return true; // nothing to compare with: trust the record
  return processStartTime(info.pgid) === info.procStart;
}

// Binds the lock port of a slot; null when another process holds it.
function listenOn(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(null);
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      server.on("error", () => {}); // a late accept error must not crash the process
      server.unref();
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// With the slot lock held: kills the proof group that a dead server left in the slot record, waits until
// the runner port is free, deletes the record. Returns true when a group was killed.
async function clearRecord(layout: Layout, index: number): Promise<boolean> {
  const file = slotFile(layout, index);
  const info = readSlotInfo(file);
  let killed = false;
  if (info && isGroupAlive(info.pgid) && isRecordedProcess(info)) {
    killGroup(info.pgid, "SIGKILL");
    await waitUntil(() => !isGroupAlive(info.pgid), 3000);
    killed = true;
  }
  await waitUntil(() => isPortFree(layout.runnerBasePort + index), 5000);
  fs.rmSync(file, { force: true });
  return killed;
}

class Lock implements SlotLock {
  readonly index: number;
  readonly runnerPort: number;
  private readonly layout: Layout;
  private readonly server: net.Server;
  private released = false;

  constructor(layout: Layout, index: number, server: net.Server) {
    this.layout = layout;
    this.index = index;
    this.server = server;
    this.runnerPort = layout.runnerBasePort + index;
  }

  recordProof(pgid: number, inst: string): void {
    if (this.released) return;
    const info: SlotInfo = { ownerPid: process.pid, inst, pgid, since: new Date().toISOString() };
    const procStart = processStartTime(pgid);
    if (procStart !== null) info.procStart = procStart;
    const file = slotFile(this.layout, this.index);
    try {
      fs.mkdirSync(this.layout.slotsDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(info));
      fs.renameSync(tmp, file);
    } catch (err) {
      // The proof can still run; only the cleanup after a hard kill is lost.
      console.error(`slot record not written: ${(err as Error).message}`);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    fs.rmSync(slotFile(this.layout, this.index), { force: true });
    await closeServer(this.server);
  }
}

export async function tryAcquireSlot(layout: Layout, machineSlots: number): Promise<SlotLock | null> {
  for (let index = 0; index < machineSlots; index++) {
    const server = await listenOn(layout.slotLockBasePort + index);
    if (!server) continue;
    try {
      // The lock is ours, so the server that recorded a proof here is gone.
      if (fs.existsSync(slotFile(layout, index))) await clearRecord(layout, index);
    } catch (err) {
      await closeServer(server);
      throw err;
    }
    return new Lock(layout, index, server);
  }
  return null;
}

// Kills the proofs that servers killed hard left behind. Returns the number of groups killed.
export async function killOrphanProofs(layout: Layout): Promise<number> {
  let names: string[];
  try {
    names = fs.readdirSync(layout.slotsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let killed = 0;
  for (const name of names) {
    const match = RECORD_RE.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    const info = readSlotInfo(path.join(layout.slotsDir, name));
    if (info && isProcessAlive(info.ownerPid)) continue; // its server is running
    const server = await listenOn(layout.slotLockBasePort + index);
    if (!server) continue; // a running server holds the slot
    try {
      if (await clearRecord(layout, index)) killed++;
    } finally {
      await closeServer(server);
    }
  }
  return killed;
}

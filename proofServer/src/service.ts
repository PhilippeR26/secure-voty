import { ConfigStore, Limits, siteAllowed } from "./config";
import { InstanceConfig, Network } from "./instance";
import { Layout, instanceFiles } from "./layout";
import { JsonlLogger, LogEvent, LogFields } from "./log";
import { waitUntil } from "./proc";
import { ProofRun, ProofSpec, ProverResult, sanitizeReason, startProof as realStartProof } from "./prover";
import { DurationEstimator, ProofQueue, estimateWaitSec } from "./queue";
import { QuotaStore, secondsUntilUtcMidnight } from "./quota";
import { SlotLock, tryAcquireSlot } from "./slots";

export type SseEvent = "queued" | "started" | "log" | "done" | "error";

export interface SseSink {
  send(event: SseEvent, data: object): void;
  close(): void;
  readonly closed: boolean;
}

export interface ProveJob {
  reqId: string;
  site: string;
  lan: boolean;
  ip: string;
  blockNumber: number;
  tx: unknown;
  sse: SseSink;
  enqueuedAt: number;
}

export type ServiceReject = "quota_exceeded" | "site_busy" | "queue_full" | "wait_too_long" | "shutting_down";

export type Admission =
  | { ok: true }
  | { ok: false; status: 429 | 503; reason: ServiceReject; message: string; retryAfterSec?: number };

export interface HealthPayload {
  ok: boolean;
  network: Network;
  queueLength: number;
  running: number;
}

export interface StatusPayload {
  inst: string;
  network: Network;
  running: Array<{ reqId: string; site: string; runningSec: number }>;
  queue: Array<{ reqId: string; site: string; waitingSec: number }>;
  usage: { day: string; used: Record<string, number> };
  limits: Limits;
  sites: Array<{ name: string; enabled: boolean; perDay: Partial<Record<Network, number>> }>;
}

export interface ServiceDeps {
  inst: InstanceConfig;
  layout: Layout;
  config: ConfigStore;
  quota: QuotaStore;
  log: JsonlLogger;
  startProof?: (spec: ProofSpec) => ProofRun;
  now?: () => number;
}

interface RunningJob {
  job: ProveJob;
  lock: SlotLock;
  run: ProofRun;
  startedAt: number;
  timeoutSec: number;
  done: Promise<void>; // settles once the end of the job is fully handled
}

const PUMP_INTERVAL_MS = 1000;

// Admission, queue and life cycle of the proofs of one instance. A proof runs only while it holds a machine
// slot, which the instances of the machine share.
export class ProofService {
  private readonly inst: InstanceConfig;
  private readonly layout: Layout;
  private readonly config: ConfigStore;
  private readonly quota: QuotaStore;
  private readonly log: JsonlLogger;
  private readonly startProof: (spec: ProofSpec) => ProofRun;
  private readonly now: () => number;
  private readonly queue = new ProofQueue<ProveJob>();
  private readonly running = new Map<string, RunningJob>();
  private readonly estimator = new DurationEstimator();
  private readonly announced = new Map<string, number>(); // reqId -> last queue position sent to the client
  private readonly timer: NodeJS.Timeout;
  private readonly onReload = (): void => this.dropRevokedJobs();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private pumping = false;
  private pumpAgain = false;
  private lastPumpError = "";

  constructor(deps: ServiceDeps) {
    this.inst = deps.inst;
    this.layout = deps.layout;
    this.config = deps.config;
    this.quota = deps.quota;
    this.log = deps.log;
    this.startProof = deps.startProof ?? realStartProof;
    this.now = deps.now ?? Date.now;
    this.config.on("reload", this.onReload);
    // A slot freed by another instance sends no signal: look again every second.
    this.timer = setInterval(() => void this.pump(), PUMP_INTERVAL_MS);
    this.timer.unref();
  }

  admit(site: string, lan: boolean): Admission {
    if (this.shuttingDown) {
      return { ok: false, status: 503, reason: "shutting_down", message: "The server is shutting down." };
    }
    if (lan) return { ok: true };

    const cfg = this.config.get();
    const limits = cfg.limits;
    const perDay = (Object.hasOwn(cfg.sites, site) ? cfg.sites[site].perDay[this.inst.network] : undefined) ?? 0;
    const queued = this.queue.countBySite(site);
    const averageMs = this.estimator.averageMs();

    if (this.quota.used(site) + queued >= perDay) {
      return {
        ok: false,
        status: 429,
        reason: "quota_exceeded",
        message: `The daily quota of ${perDay} proofs on ${this.inst.network} is used up; it resets at 00:00 UTC.`,
        retryAfterSec: secondsUntilUtcMidnight(new Date(this.now())),
      };
    }

    const running = this.running.size;
    const siteJobs = queued + [...this.running.values()].filter((entry) => entry.job.site === site).length;
    if (siteJobs >= limits.perSiteQueueMax) {
      return {
        ok: false,
        status: 429,
        reason: "site_busy",
        message: `This site already has ${siteJobs} proof requests queued or running (limit ${limits.perSiteQueueMax}).`,
      };
    }

    const ahead = this.queue.size() + running;
    if (this.queue.size() >= limits.queueMax) {
      return {
        ok: false,
        status: 503,
        reason: "queue_full",
        message: `The proof queue is full (${limits.queueMax} waiting). Try again later.`,
        retryAfterSec: Math.max(1, estimateWaitSec(ahead, averageMs)),
      };
    }

    const eta = estimateWaitSec(ahead, averageMs);
    if (eta > limits.maxWaitSec) {
      return {
        ok: false,
        status: 503,
        reason: "wait_too_long",
        message: `The estimated wait (${eta} s) is above the limit (${limits.maxWaitSec} s). Try again later.`,
        retryAfterSec: eta,
      };
    }
    return { ok: true };
  }

  submit(job: ProveJob): void {
    if (this.shuttingDown) {
      this.send(job, "error", { message: "Server is shutting down" });
      this.closeSink(job);
      this.write("abort", job, { reason: "shutdown" });
      return;
    }
    this.queue.enqueue(job);
    this.write("queued", job, { queueLen: this.queue.size() });
    this.refreshPositions();
    void this.pump();
  }

  cancel(reqId: string): void {
    const queued = this.queue.remove(reqId);
    if (queued) {
      this.announced.delete(reqId);
      this.write("abort", queued, { reason: "client_disconnected" });
      this.closeSink(queued);
      this.refreshPositions();
      return;
    }
    this.running.get(reqId)?.run.kill("abort");
  }

  health(): HealthPayload {
    return {
      ok: !this.shuttingDown,
      network: this.inst.network,
      queueLength: this.queue.size(),
      running: this.running.size,
    };
  }

  // Never holds transaction data or key hashes.
  status(): StatusPayload {
    const now = this.now();
    const cfg = this.config.get();
    return {
      inst: this.inst.name,
      network: this.inst.network,
      running: [...this.running.values()].map((entry) => ({
        reqId: entry.job.reqId,
        site: entry.job.site,
        runningSec: Math.floor((now - entry.startedAt) / 1000),
      })),
      queue: this.queue.items().map((job) => ({
        reqId: job.reqId,
        site: job.site,
        waitingSec: Math.floor((now - job.enqueuedAt) / 1000),
      })),
      usage: this.quota.snapshot(),
      limits: { ...cfg.limits, badKey: { ...cfg.limits.badKey } },
      sites: Object.entries(cfg.sites).map(([name, site]) => ({
        name,
        enabled: site.enabled,
        perDay: { ...site.perDay },
      })),
    };
  }

  // Queued jobs are refused at once; running ones get `graceMs` to finish, then are killed.
  shutdown(graceMs: number): Promise<void> {
    this.shutdownPromise ??= this.stopAll(graceMs);
    return this.shutdownPromise;
  }

  private async stopAll(graceMs: number): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.timer);
    this.config.off("reload", this.onReload);
    for (const job of this.queue.removeWhere(() => true)) {
      this.announced.delete(job.reqId);
      this.send(job, "error", { message: "Server is shutting down" });
      this.closeSink(job);
      this.write("abort", job, { reason: "shutdown" });
    }
    if (await waitUntil(() => this.running.size === 0, graceMs, 50)) return;
    const remaining = [...this.running.values()];
    for (const entry of remaining) entry.run.kill("shutdown");
    await Promise.all(remaining.map((entry) => entry.done));
  }

  // Starts queued jobs while a machine slot is free. One pass at a time: a call during a pass asks for another.
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (this.queue.size() > 0 && !this.shuttingDown) {
          const lock = await tryAcquireSlot(this.layout, this.config.get().limits.machineSlots);
          this.lastPumpError = "";
          if (!lock) break;
          const job = this.shuttingDown ? undefined : this.queue.shift(); // the queue may have changed meanwhile
          if (!job) {
            await lock.release();
            break;
          }
          this.announced.delete(job.reqId);
          this.launch(job, lock);
        }
      } while (this.pumpAgain);
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastPumpError) {
        this.lastPumpError = message;
        console.error(`cannot take a machine slot: ${message}`);
      }
    } finally {
      this.pumping = false;
    }
  }

  private launch(job: ProveJob, lock: SlotLock): void {
    const timeoutSec = this.config.get().limits.proofTimeoutSec;
    const startedAt = this.now();
    if (!job.lan) this.quota.increment(job.site); // every launched proof counts, successful or not
    this.write("start", job, { waitMs: Math.max(0, startedAt - job.enqueuedAt) });
    this.send(job, "started", {});

    const spec: ProofSpec = {
      binary: this.inst.snip36Binary,
      repoDir: this.layout.repoDir,
      workDir: instanceFiles(this.layout, this.inst.name).workDir,
      jobId: job.reqId,
      network: this.inst.network,
      rpcUrl: this.inst.rpcUrl,
      blockNumber: job.blockNumber,
      tx: job.tx,
      runnerPort: lock.runnerPort,
      timeoutMs: timeoutSec * 1000,
      onLine: job.lan ? (stream, line) => this.send(job, "log", { stream, line }) : undefined,
    };
    let run: ProofRun;
    try {
      run = this.startProof(spec);
    } catch (err) {
      const reason = sanitizeReason((err as Error).message, job.tx);
      run = {
        pgid: null,
        result: Promise.resolve({ kind: "fail", exitCode: null, signal: null, reason, stderrTail: "", durMs: 0 }),
        kill: () => {},
      };
    }
    if (run.pgid !== null) lock.recordProof(run.pgid, this.inst.name);

    const entry: RunningJob = { job, lock, run, startedAt, timeoutSec, done: Promise.resolve() };
    this.running.set(job.reqId, entry);
    entry.done = run.result.then(
      (result) => this.finish(entry, result),
      (err) =>
        this.finish(entry, {
          kind: "fail",
          exitCode: null,
          signal: null,
          reason: sanitizeReason(String((err as Error)?.message ?? err), job.tx),
          stderrTail: "",
          durMs: this.now() - startedAt,
        }),
    );
    this.refreshPositions();
  }

  private async finish(entry: RunningJob, result: ProverResult): Promise<void> {
    const { job } = entry;
    try {
      if (result.kind === "done") {
        this.send(job, "done", result.output);
        this.write("done", job, { durMs: result.durMs });
        this.estimator.add(result.durMs);
      } else if (result.kind === "fail") {
        this.send(job, "error", {
          message: `Proof generation failed: ${result.reason}`,
          ...(job.lan && { stderr: result.stderrTail }),
        });
        this.write("fail", job, { durMs: result.durMs, reason: result.reason });
      } else if (result.reason === "timeout") {
        this.send(job, "error", { message: `Proof timed out after ${entry.timeoutSec} s` });
        this.write("timeout", job, { durMs: result.durMs });
      } else if (result.reason === "shutdown") {
        this.send(job, "error", { message: "Server is shutting down" });
        this.write("abort", job, { durMs: result.durMs, reason: "shutdown" });
      } else {
        this.write("abort", job, { durMs: result.durMs, reason: "client_disconnected" });
      }
    } catch (err) {
      // Nobody awaits entry.done: a rejection here would stop the process.
      console.error(`cannot report the end of a proof: ${(err as Error).message}`);
    } finally {
      try {
        await entry.lock.release();
      } catch (err) {
        console.error(`machine slot not released: ${(err as Error).message}`);
      }
      this.running.delete(job.reqId);
      this.closeSink(job);
      this.refreshPositions();
      void this.pump();
    }
  }

  // Jobs of a site that is no longer allowed on this network leave the queue; running ones go on.
  private dropRevokedJobs(): void {
    const cfg = this.config.get();
    const revoked = this.queue.removeWhere((job) => !job.lan && !siteAllowed(cfg, job.site, this.inst.network));
    for (const job of revoked) {
      this.announced.delete(job.reqId);
      this.send(job, "error", { message: "Access for this site was revoked" });
      this.closeSink(job);
      this.write("reject", job, { reason: "site_revoked" });
    }
    this.refreshPositions();
    void this.pump(); // the limits may have changed too
  }

  // Tells each queued client its position when it is not the one it was last told.
  private refreshPositions(): void {
    const averageMs = this.estimator.averageMs();
    this.queue.items().forEach((job, index) => {
      const position = index + 1;
      if (this.announced.get(job.reqId) === position) return;
      this.announced.set(job.reqId, position);
      this.send(job, "queued", {
        position,
        etaSec: estimateWaitSec(position - 1 + this.running.size, averageMs),
      });
    });
  }

  private write(ev: LogEvent, job: ProveJob, fields: LogFields = {}): void {
    this.log.write(ev, { reqId: job.reqId, site: job.site, ...fields });
  }

  private send(job: ProveJob, event: SseEvent, data: object): void {
    try {
      job.sse.send(event, data);
    } catch {
      // the connection is gone
    }
  }

  private closeSink(job: ProveJob): void {
    try {
      job.sse.close();
    } catch {
      // already closed
    }
  }
}

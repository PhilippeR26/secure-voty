export interface Queued {
  reqId: string;
  site: string;
  lan: boolean;
}

// Jobs waiting for a machine slot. LAN jobs go before external ones, each group in arrival order.
export class ProofQueue<T extends Queued> {
  private list: T[] = [];

  enqueue(item: T): void {
    if (!item.lan) {
      this.list.push(item);
      return;
    }
    let at = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].lan) {
        at = i + 1;
        break;
      }
    }
    this.list.splice(at, 0, item);
  }

  shift(): T | undefined {
    return this.list.shift();
  }

  remove(reqId: string): T | undefined {
    const index = this.list.findIndex((item) => item.reqId === reqId);
    return index === -1 ? undefined : this.list.splice(index, 1)[0];
  }

  removeWhere(pred: (item: T) => boolean): T[] {
    const removed: T[] = [];
    this.list = this.list.filter((item) => {
      if (!pred(item)) return true;
      removed.push(item);
      return false;
    });
    return removed;
  }

  // 1-based run order, 0 when the job is not queued.
  position(reqId: string): number {
    return this.list.findIndex((item) => item.reqId === reqId) + 1;
  }

  size(): number {
    return this.list.length;
  }

  countBySite(site: string): number {
    return this.list.filter((item) => item.site === site).length;
  }

  // A copy, in run order: callers may keep iterating while the queue changes.
  items(): readonly T[] {
    return this.list.slice();
  }
}

// Mean of the last proof durations, to announce a wait time.
export class DurationEstimator {
  private readonly windowSize: number;
  private readonly initialMs: number;
  private readonly values: number[] = [];

  constructor(windowSize = 10, initialMs = 60_000) {
    this.windowSize = windowSize;
    this.initialMs = initialMs;
  }

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values.push(ms);
    if (this.values.length > this.windowSize) this.values.shift();
  }

  averageMs(): number {
    if (this.values.length === 0) return this.initialMs;
    return this.values.reduce((sum, ms) => sum + ms, 0) / this.values.length;
  }
}

export function estimateWaitSec(jobsAhead: number, averageMs: number): number {
  return Math.ceil((jobsAhead * averageMs) / 1000);
}

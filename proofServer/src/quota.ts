import fs from "fs";
import path from "path";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(d: Date): number {
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextMidnight - d.getTime()) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Proofs launched per site during the current UTC day, persisted as {"day":"YYYY-MM-DD","used":{"<site>":n}}.
export class QuotaStore {
  private readonly file: string;
  private readonly now: () => Date;
  private day: string;
  private counts = new Map<string, number>();

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
    this.day = utcDay(now());
    this.load();
  }

  used(site: string): number {
    this.rollOver();
    return this.counts.get(site) ?? 0;
  }

  increment(site: string): void {
    this.rollOver();
    this.counts.set(site, (this.counts.get(site) ?? 0) + 1);
    this.save();
  }

  snapshot(): { day: string; used: Record<string, number> } {
    this.rollOver();
    return { day: this.day, used: Object.fromEntries(this.counts) };
  }

  private rollOver(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") this.warn((err as Error).message);
      return;
    }
    try {
      const raw: unknown = JSON.parse(text);
      if (!isRecord(raw) || typeof raw.day !== "string" || !DAY_RE.test(raw.day) || !isRecord(raw.used)) {
        throw new Error("unexpected content");
      }
      const entries: Array<[string, number]> = [];
      for (const [site, count] of Object.entries(raw.used)) {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new Error(`bad count for ${site}`);
        }
        entries.push([site, count]);
      }
      if (raw.day === this.day) this.counts = new Map(entries);
    } catch (err) {
      this.warn((err as Error).message);
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ day: this.day, used: Object.fromEntries(this.counts) }) + "\n");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`usage file ${this.file}: cannot write: ${(err as Error).message}`);
    }
  }

  private warn(message: string): void {
    console.error(`usage file ${this.file} ignored, counters start from zero: ${message}`);
  }
}

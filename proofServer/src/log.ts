import fs from "fs";
import path from "path";

export const LOG_EVENTS = [
  "request",
  "reject",
  "queued",
  "start",
  "done",
  "fail",
  "abort",
  "timeout",
  "ban",
  "config_reload",
  "config_error",
  "startup",
  "shutdown",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export interface LogRecord {
  ts: string;
  inst: string;
  ev: LogEvent;
  reqId?: string;
  site?: string;
  ip?: string;
  reason?: string;
  waitMs?: number;
  durMs?: number;
  queueLen?: number;
  msg?: string;
}
export type LogFields = Omit<LogRecord, "ts" | "inst" | "ev">;

// Only these keys are ever written, so transaction data cannot reach the log.
const FIELD_ORDER = ["reqId", "site", "ip", "reason", "waitMs", "durMs", "queueLen", "msg"] as const;

export class JsonlLogger {
  private readonly file: string;
  private readonly inst: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  private size = 0;

  constructor(opts: { file: string; inst: string; maxBytes: number; maxFiles: number; now?: () => Date }) {
    this.file = opts.file;
    this.inst = opts.inst;
    this.maxBytes = opts.maxBytes;
    this.maxFiles = opts.maxFiles;
    this.now = opts.now ?? (() => new Date());
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch (err) {
      console.error(`log write failed: ${(err as Error).message}`);
    }
  }

  write(ev: LogEvent, fields: LogFields = {}): void {
    try {
      const record: Record<string, unknown> = { ts: this.now().toISOString(), inst: this.inst, ev };
      for (const key of FIELD_ORDER) {
        if (fields[key] !== undefined) record[key] = fields[key];
      }
      const line = JSON.stringify(record) + "\n";
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += bytes;
    } catch (err) {
      console.error(`log write failed: ${(err as Error).message}`);
    }
  }

  private rotate(): void {
    fs.rmSync(`${this.file}.${this.maxFiles}`, { force: true });
    for (let k = this.maxFiles - 1; k >= 1; k--) {
      if (fs.existsSync(`${this.file}.${k}`)) fs.renameSync(`${this.file}.${k}`, `${this.file}.${k + 1}`);
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }
}

// Existing files of a log, oldest first: file.N … file.1, file.
export function logFileSet(file: string, maxFiles: number): string[] {
  const files: string[] = [];
  for (let k = maxFiles; k >= 1; k--) {
    if (fs.existsSync(`${file}.${k}`)) files.push(`${file}.${k}`);
  }
  if (fs.existsSync(file)) files.push(file);
  return files;
}

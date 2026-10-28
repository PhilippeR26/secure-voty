import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { LogRecord } from "../log";
import { utcDay } from "../quota";
import type { Command } from "./main";

export type RejectCategory = "auth" | "quota" | "overload" | "invalid";

export const REJECT_CATEGORY: Record<string, RejectCategory> = {
  missing_key: "auth",
  unknown_key: "auth",
  banned: "auth",
  site_disabled: "auth",
  network_not_allowed: "auth",
  site_revoked: "auth",
  quota_exceeded: "quota",
  site_busy: "quota",
  queue_full: "overload",
  wait_too_long: "overload",
  shutting_down: "overload",
  invalid_json: "invalid",
  invalid_body: "invalid",
  body_too_large: "invalid",
  not_private: "invalid",
};

export interface StatsOptions {
  since?: Date;
  day?: string;
  site?: string;
  instance?: string;
}

export interface SiteDayStats {
  day: string;
  site: string;
  requests: number;
  done: number;
  failed: number;
  timeouts: number;
  aborted: number;
  rejected: Record<RejectCategory, number>;
  durMedianMs: number | null;
  durP95Ms: number | null;
  waitMedianMs: number | null;
  waitMaxMs: number | null;
}

export interface GlobalStats {
  peakQueue: number;
  timeouts: number;
  busiestHour: string | null; // "YYYY-MM-DDTHH", UTC
}

export interface StatsResult {
  rows: SiteDayStats[];
  global: GlobalStats;
}

const UNKNOWN_SITE = "(unknown)";

// The events that belong to a request; startup, shutdown, config_* and ban say nothing about a site.
const REQUEST_EVENTS = new Set(["request", "reject", "queued", "start", "done", "fail", "abort", "timeout"]);

function parseFile(file: string): LogRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: LogRecord[] = [];
  for (const line of text.split("\n")) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.ts === "string" && typeof record.inst === "string" && typeof record.ev === "string") {
        records.push(record);
      }
    } catch {
      // a line that is not JSON is skipped
    }
  }
  return records;
}

// Per instance, oldest first: <inst>.log.N ... <inst>.log.1, then <inst>.log. The logs of Caddy are not read.
export function readLogRecords(logsDir: string, instance?: string): LogRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  const byInstance = new Map<string, Array<{ rank: number; file: string }>>();
  for (const name of names) {
    const match = /^(.+)\.log(?:\.(\d+))?$/.exec(name);
    if (!match || match[1] === "caddy") continue;
    if (instance !== undefined && match[1] !== instance) continue;
    const files = byInstance.get(match[1]) ?? [];
    files.push({ rank: match[2] === undefined ? 0 : Number(match[2]), file: path.join(logsDir, name) });
    byInstance.set(match[1], files);
  }
  const records: LogRecord[] = [];
  for (const inst of [...byInstance.keys()].sort()) {
    for (const { file } of byInstance.get(inst)!.sort((a, b) => b.rank - a.rank)) records.push(...parseFile(file));
  }
  return records;
}

// Nearest rank: sorted[ceil(p / 100 * n) - 1].
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

interface Accumulator {
  requests: number;
  done: number;
  failed: number;
  timeouts: number;
  aborted: number;
  rejected: Record<RejectCategory, number>;
  durations: number[];
  waits: number[];
}

export function computeStats(records: LogRecord[], opts: StatsOptions = {}): StatsResult {
  const rows = new Map<string, { day: string; site: string; acc: Accumulator }>();
  const requestsPerHour = new Map<string, number>();
  const global: GlobalStats = { peakQueue: 0, timeouts: 0, busiestHour: null };

  for (const r of records) {
    if (!REQUEST_EVENTS.has(r.ev)) continue;
    const time = Date.parse(r.ts);
    if (Number.isNaN(time)) continue;
    const at = new Date(time);
    if (opts.since && time < opts.since.getTime()) continue;
    const day = utcDay(at);
    if (opts.day && day !== opts.day) continue;
    if (opts.instance && r.inst !== opts.instance) continue;
    const site = r.site ?? UNKNOWN_SITE;
    if (opts.site && site !== opts.site) continue;

    const key = `${day}\n${site}`;
    let row = rows.get(key);
    if (!row) {
      const acc: Accumulator = {
        requests: 0,
        done: 0,
        failed: 0,
        timeouts: 0,
        aborted: 0,
        rejected: { auth: 0, quota: 0, overload: 0, invalid: 0 },
        durations: [],
        waits: [],
      };
      row = { day, site, acc };
      rows.set(key, row);
    }
    const { acc } = row;

    switch (r.ev) {
      case "request": {
        acc.requests++;
        const hour = at.toISOString().slice(0, 13);
        requestsPerHour.set(hour, (requestsPerHour.get(hour) ?? 0) + 1);
        break;
      }
      case "reject":
        if (r.reason !== undefined && Object.hasOwn(REJECT_CATEGORY, r.reason)) acc.rejected[REJECT_CATEGORY[r.reason]]++;
        break;
      case "queued":
        if (typeof r.queueLen === "number") global.peakQueue = Math.max(global.peakQueue, r.queueLen);
        break;
      case "start":
        if (typeof r.waitMs === "number") acc.waits.push(r.waitMs);
        break;
      case "done":
        acc.done++;
        if (typeof r.durMs === "number") acc.durations.push(r.durMs);
        break;
      case "fail":
        acc.failed++;
        break;
      case "timeout":
        acc.timeouts++;
        global.timeouts++;
        break;
      case "abort":
        acc.aborted++;
        break;
    }
  }

  let busiest = 0;
  for (const hour of [...requestsPerHour.keys()].sort()) {
    if (requestsPerHour.get(hour)! > busiest) {
      busiest = requestsPerHour.get(hour)!;
      global.busiestHour = hour;
    }
  }

  const sorted = [...rows.values()].sort((a, b) =>
    a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.site < b.site ? -1 : a.site > b.site ? 1 : 0,
  );
  return {
    rows: sorted.map(({ day, site, acc }) => ({
      day,
      site,
      requests: acc.requests,
      done: acc.done,
      failed: acc.failed,
      timeouts: acc.timeouts,
      aborted: acc.aborted,
      rejected: acc.rejected,
      durMedianMs: percentile(acc.durations, 50),
      durP95Ms: percentile(acc.durations, 95),
      waitMedianMs: percentile(acc.waits, 50),
      waitMaxMs: acc.waits.length > 0 ? Math.max(...acc.waits) : null,
    })),
    global,
  };
}

function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatStats(result: StatsResult): string {
  if (result.rows.length === 0) return "No request in these logs.";
  const table: string[][] = [
    ["day", "site", "requests", "done", "failed", "timeouts", "aborted", "rejected", "duration med / p95", "wait med / max"],
    ...result.rows.map((r) => [
      r.day,
      r.site,
      String(r.requests),
      String(r.done),
      String(r.failed),
      String(r.timeouts),
      String(r.aborted),
      `${r.rejected.auth}/${r.rejected.quota}/${r.rejected.overload}/${r.rejected.invalid}`,
      `${formatMs(r.durMedianMs)} / ${formatMs(r.durP95Ms)}`,
      `${formatMs(r.waitMedianMs)} / ${formatMs(r.waitMaxMs)}`,
    ]),
  ];
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  const lines = table.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
  const { peakQueue, timeouts, busiestHour } = result.global;
  return [
    ...lines,
    "",
    "rejected = authentication / quota / overload / invalid request",
    `peak queue: ${peakQueue}, timeouts: ${timeouts}, busiest hour: ${busiestHour ? `${busiestHour} UTC` : "-"}`,
  ].join("\n");
}

export const statsCommand: Command = async (layout, args, out) => {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        since: { type: "string" },
        day: { type: "string" },
        site: { type: "string" },
        instance: { type: "string" },
        json: { type: "boolean" },
      },
    });
  } catch (err) {
    out(`stats: ${(err as Error).message}`);
    return 1;
  }
  const { since, day, site, instance, json } = parsed.values;
  if (since !== undefined && day !== undefined) {
    out("Use --since or --day, not both.");
    return 1;
  }

  const opts: StatsOptions = { site, instance };
  if (since !== undefined) {
    const match = /^(\d+)([dh])$/.exec(since);
    if (!match) {
      out(`--since: expected a number of days or hours such as 7d or 12h, got "${since}"`);
      return 1;
    }
    opts.since = new Date(Date.now() - Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000));
  }
  if (day !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
      out(`--day: expected a date such as 2026-10-28, got "${day}"`);
      return 1;
    }
    opts.day = day;
  }

  const result = computeStats(readLogRecords(layout.logsDir, instance), opts);
  out(json ? JSON.stringify(result, null, 2) : formatStats(result));
  return 0;
};

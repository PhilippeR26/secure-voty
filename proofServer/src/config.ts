import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { NETWORKS, Network } from "./instance";

export interface Limits {
  machineSlots: number;
  queueMax: number;
  perSiteQueueMax: number;
  maxWaitSec: number;
  proofTimeoutSec: number;
  maxBodyKB: number;
  badKey: { maxFailures: number; windowMin: number; banMin: number };
}

export interface Site {
  keySha256: string;
  enabled: boolean;
  perDay: Partial<Record<Network, number>>;
  note?: string;
}

export interface SitesConfig {
  limits: Limits;
  sites: Record<string, Site>;
}

export const DEFAULT_LIMITS: Limits = {
  machineSlots: 1,
  queueMax: 10,
  perSiteQueueMax: 2,
  maxWaitSec: 900,
  proofTimeoutSec: 600,
  maxBodyKB: 256,
  badKey: { maxFailures: 10, windowMin: 10, banMin: 60 },
};

export function emptyConfig(): SitesConfig {
  return { limits: { ...DEFAULT_LIMITS, badKey: { ...DEFAULT_LIMITS.badKey } }, sites: {} };
}

type NumericLimit = Exclude<keyof Limits, "badKey">;
const LIMIT_BOUNDS: Record<NumericLimit, [number, number]> = {
  machineSlots: [1, 8],
  queueMax: [0, Infinity],
  perSiteQueueMax: [1, Infinity],
  maxWaitSec: [1, Infinity],
  proofTimeoutSec: [1, Infinity],
  maxBodyKB: [1, 10240],
};
const BAD_KEY_FIELDS = ["maxFailures", "windowMin", "banMin"] as const;
const SITE_FIELDS = ["keySha256", "enabled", "perDay", "note"];
const SITE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;

class ConfigError extends Error {}

function fail(at: string, message: string): never {
  throw new ConfigError(`${at}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A misspelled key (e.g. "enable") must not be silently ignored.
function checkKeys(at: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${at}.${key}`, "unknown key");
  }
}

function readInteger(at: string, value: unknown, min: number, max = Infinity): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(at, `expected an integer ${max === Infinity ? `>= ${min}` : `between ${min} and ${max}`}`);
  }
  return value;
}

function parseLimits(raw: unknown): Limits {
  const limits = emptyConfig().limits;
  if (raw === undefined) return limits;
  if (!isRecord(raw)) fail("limits", "expected an object");
  checkKeys("limits", raw, [...Object.keys(LIMIT_BOUNDS), "badKey"]);
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS)) {
    if (raw[key] !== undefined) {
      limits[key as NumericLimit] = readInteger(`limits.${key}`, raw[key], min, max);
    }
  }
  if (raw.badKey !== undefined) {
    if (!isRecord(raw.badKey)) fail("limits.badKey", "expected an object");
    checkKeys("limits.badKey", raw.badKey, BAD_KEY_FIELDS);
    for (const key of BAD_KEY_FIELDS) {
      if (raw.badKey[key] !== undefined) {
        limits.badKey[key] = readInteger(`limits.badKey.${key}`, raw.badKey[key], 1);
      }
    }
  }
  return limits;
}

function parseSites(raw: unknown): Record<string, Site> {
  const sites: Record<string, Site> = {};
  if (raw === undefined) return sites;
  if (!isRecord(raw)) fail("sites", "expected an object");
  const owners = new Map<string, string>(); // key hash -> site name
  for (const [name, entry] of Object.entries(raw)) {
    const at = `sites.${name}`;
    if (!SITE_NAME_RE.test(name)) {
      fail(at, "invalid site name: letters, digits, dot, underscore and dash, at most 64 characters, starting with a letter or a digit");
    }
    if (name === "lan") fail(at, '"lan" is a reserved name (it marks LAN requests in the log)');
    if (!isRecord(entry)) fail(at, "expected an object");
    checkKeys(at, entry, SITE_FIELDS);

    const keySha256 = entry.keySha256;
    if (typeof keySha256 !== "string" || !KEY_HASH_RE.test(keySha256)) {
      fail(`${at}.keySha256`, "expected 64 lowercase hex characters (the SHA-256 of the key)");
    }
    const owner = owners.get(keySha256);
    if (owner !== undefined) fail(`${at}.keySha256`, `same key as site "${owner}"`);
    owners.set(keySha256, name);

    let enabled = true;
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== "boolean") fail(`${at}.enabled`, "expected true or false");
      enabled = entry.enabled;
    }

    const perDay: Partial<Record<Network, number>> = {};
    if (entry.perDay !== undefined) {
      if (!isRecord(entry.perDay)) fail(`${at}.perDay`, "expected an object");
      for (const [networkName, quota] of Object.entries(entry.perDay)) {
        const where = `${at}.perDay.${networkName}`;
        const network = NETWORKS.find((n) => n === networkName);
        if (!network) fail(where, "unknown network");
        perDay[network] = readInteger(where, quota, 0);
      }
    }

    const note = entry.note;
    if (note !== undefined && typeof note !== "string") fail(`${at}.note`, "expected a string");
    sites[name] = { keySha256, enabled, perDay, ...(note !== undefined && { note }) };
  }
  return sites;
}

export function parseSitesConfig(text: string): { ok: true; config: SitesConfig } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  try {
    if (!isRecord(raw)) fail("config", "expected an object");
    checkKeys("config", raw, ["limits", "sites"]);
    return { ok: true, config: { limits: parseLimits(raw.limits), sites: parseSites(raw.sites) } };
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, error: err.message };
    throw err;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function configFromText(file: string, text: string | null): SitesConfig {
  if (text === null) return emptyConfig();
  const parsed = parseSitesConfig(text);
  if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
  return parsed.config;
}

export function readSitesFile(file: string): SitesConfig {
  return configFromText(file, readText(file));
}

export function writeSitesFile(file: string, config: SitesConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function siteAllowed(config: SitesConfig, site: string, network: Network): boolean {
  if (!Object.hasOwn(config.sites, site)) return false;
  const entry = config.sites[site];
  return entry.enabled && entry.perDay[network] !== undefined;
}

// Events: "reload" (config: SitesConfig) after a valid change, "error" (message: string) when the file is
// invalid or missing; the previous configuration is kept in that case.
export class ConfigStore extends EventEmitter {
  private readonly file: string;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private config: SitesConfig = emptyConfig();
  private lastText: string | null = null; // null: the file is missing
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(file: string, opts: { pollMs?: number; debounceMs?: number } = {}) {
    super();
    this.file = file;
    this.pollMs = opts.pollMs ?? 5000;
    this.debounceMs = opts.debounceMs ?? 200;
  }

  start(): SitesConfig {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const text = readText(this.file);
    this.config = configFromText(this.file, text); // throws like readSitesFile
    this.lastText = text;
    this.stopped = false;

    // The directory is watched, not the file: editors replace the file instead of writing into it.
    // The watcher keeps the process alive until stop(); the timers do not.
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename === null || filename === base) this.schedule();
      });
      this.watcher.on("error", () => this.closeWatcher()); // the poll below stays as the fallback
    } catch {
      this.watcher = null;
    }
    this.pollTimer = setInterval(() => this.reloadNow(), this.pollMs);
    this.pollTimer.unref();
    return this.config;
  }

  get(): SitesConfig {
    return this.config;
  }

  reloadNow(): void {
    if (this.stopped) return;
    let text: string | null;
    try {
      text = readText(this.file);
    } catch (err) {
      this.report(`${this.file}: ${(err as Error).message}`);
      return;
    }
    if (text === this.lastText) return;
    this.lastText = text;
    if (text === null) {
      this.report(`${this.file}: file is missing, keeping the previous configuration`);
      return;
    }
    const parsed = parseSitesConfig(text);
    if (!parsed.ok) {
      this.report(`${this.file}: ${parsed.error}`);
      return;
    }
    this.config = parsed.config;
    this.emit("reload", parsed.config);
  }

  stop(): void {
    this.stopped = true;
    this.closeWatcher();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
  }

  // An "error" event nobody listens to would throw: report only when someone listens.
  private report(message: string): void {
    if (this.listenerCount("error") > 0) this.emit("error", message);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reloadNow();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

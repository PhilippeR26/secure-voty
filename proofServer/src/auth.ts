import { timingSafeEqual } from "crypto";
import { Limits, SitesConfig } from "./config";
import { Network } from "./instance";
import { hashKey } from "./keys";

export type AuthFailure = "missing_key" | "unknown_key" | "site_disabled" | "network_not_allowed";
export type AuthResult = { ok: true; site: string } | { ok: false; status: 401 | 403; reason: AuthFailure };

const BEARER_RE = /^bearer\s+(.*)$/i;

export function authenticate(authorization: string | undefined, network: Network, config: SitesConfig): AuthResult {
  const key = BEARER_RE.exec(authorization ?? "")?.[1].trim();
  if (!key) return { ok: false, status: 401, reason: "missing_key" };

  // No early exit: the time spent does not tell which site matched.
  const hash = Buffer.from(hashKey(key), "hex");
  let site: string | null = null;
  for (const [name, entry] of Object.entries(config.sites)) {
    const stored = Buffer.from(entry.keySha256, "hex");
    if (stored.length === hash.length && timingSafeEqual(stored, hash)) site = name;
  }
  if (site === null) return { ok: false, status: 401, reason: "unknown_key" };

  const entry = config.sites[site];
  if (!entry.enabled) return { ok: false, status: 403, reason: "site_disabled" };
  if (entry.perDay[network] === undefined) return { ok: false, status: 403, reason: "network_not_allowed" };
  return { ok: true, site };
}

export class BanList {
  private readonly now: () => number;
  private readonly maxTracked: number;
  private readonly failures = new Map<string, number[]>(); // ip -> times of the failures inside the window
  private readonly bans = new Map<string, number>(); // ip -> end of the ban

  constructor(now: () => number = Date.now, maxTracked = 10_000) {
    this.now = now;
    this.maxTracked = maxTracked;
  }

  isBanned(ip: string): boolean {
    const until = this.bans.get(ip);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.bans.delete(ip);
    return false;
  }

  // Returns true when this failure starts a ban.
  recordFailure(ip: string, rule: Limits["badKey"]): boolean {
    const now = this.now();
    const windowMs = rule.windowMin * 60_000;
    if (this.trackedCount() >= this.maxTracked) this.prune(now, windowMs);

    const recent = (this.failures.get(ip) ?? []).filter((time) => time > now - windowMs);
    recent.push(now);
    if (recent.length >= rule.maxFailures) {
      this.failures.delete(ip);
      this.bans.set(ip, now + rule.banMin * 60_000);
      return true;
    }
    this.failures.set(ip, recent);
    return false;
  }

  trackedCount(): number {
    return this.failures.size + this.bans.size;
  }

  // Bounds the memory used when many distinct addresses fail once.
  private prune(now: number, windowMs: number): void {
    for (const [ip, times] of this.failures) {
      if (times[times.length - 1] <= now - windowMs) this.failures.delete(ip);
    }
    for (const [ip, until] of this.bans) {
      if (until <= now) this.bans.delete(ip);
    }
  }
}

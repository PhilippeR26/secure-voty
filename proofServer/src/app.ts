import { randomUUID } from "crypto";
import express from "express";
import { AuthFailure, BanList, authenticate } from "./auth";
import { ConfigStore } from "./config";
import { InstanceConfig } from "./instance";
import { JsonlLogger } from "./log";
import { ProofService, ServiceReject } from "./service";
import { SseStream } from "./sse";
import { validateProveBody } from "./validate";

export type HttpReject =
  | AuthFailure
  | ServiceReject
  | "not_private"
  | "banned"
  | "body_too_large"
  | "invalid_json"
  | "invalid_body";

export interface AppDeps {
  inst: InstanceConfig;
  service: ProofService;
  config: ConfigStore;
  bans: BanList;
  log: JsonlLogger;
}

const STATUS: Record<HttpReject, number> = {
  missing_key: 401,
  unknown_key: 401,
  site_disabled: 403,
  network_not_allowed: 403,
  banned: 403,
  not_private: 403,
  body_too_large: 413,
  invalid_json: 400,
  invalid_body: 400,
  quota_exceeded: 429,
  site_busy: 429,
  queue_full: 503,
  wait_too_long: 503,
  shutting_down: 503,
};

const AUTH_MESSAGES: Record<AuthFailure, string> = {
  missing_key: "Missing API key: send it as 'Authorization: Bearer <key>'.",
  unknown_key: "Unknown API key.",
  site_disabled: "This site is disabled.",
  network_not_allowed: "This site is not allowed on this network.",
};

// 127/8, 10/8, 172.16/12, 192.168/16, ::1, and the same IPv4 ranges written as ::ffff:a.b.c.d
export function isLanAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === "::1") return true;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)?.[1] ?? addr;
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)?.slice(1).map(Number);
  if (!parts || parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Behind Caddy the client is the last X-Forwarded-For entry (the one Caddy added); trusted on the public
// listener only, which nothing but Caddy can reach.
export function clientIp(xForwardedFor: string | undefined, socketAddr: string | undefined): string {
  const last = xForwardedFor?.split(",").pop()?.trim();
  return last || socketAddr || "unknown";
}

type JsonRead = { ok: true; body: unknown } | { ok: false; reason: "body_too_large" | "invalid_json" };

// express.json with a limit read at each request, so that a change of maxBodyKB applies at once.
// Only Content-Type: application/json is read: a web page cannot send that without a CORS preflight.
function readJson(req: express.Request, res: express.Response, limitBytes: number): Promise<JsonRead> {
  return new Promise((resolve) => {
    express.json({ limit: limitBytes })(req, res, (err?: unknown) => {
      if (err) {
        const type = (err as { type?: string }).type;
        resolve({ ok: false, reason: type === "entity.too.large" ? "body_too_large" : "invalid_json" });
      } else {
        resolve({ ok: true, body: req.body });
      }
    });
  });
}

function createApp(deps: AppDeps, lan: boolean): express.Express {
  const { inst, service, config, bans, log } = deps;
  const app = express();
  app.disable("x-powered-by");

  const reject = (
    res: express.Response,
    who: { reqId: string; site?: string; ip: string },
    reason: HttpReject,
    message: string,
    retryAfterSec?: number,
    status: number = STATUS[reason],
  ): void => {
    res.status(status);
    if (retryAfterSec !== undefined) res.setHeader("Retry-After", String(retryAfterSec));
    res.json({ error: message, reason });
    log.write("reject", { reqId: who.reqId, site: who.site, ip: who.ip, reason });
  };

  app.use((req, res, next) => {
    const socketAddress = req.socket.remoteAddress;
    const ip = lan
      ? (socketAddress ?? "unknown")
      : clientIp(req.headers["x-forwarded-for"] as string | undefined, socketAddress);
    res.locals.ip = ip;
    if (lan && !isLanAddress(socketAddress)) {
      reject(res, { reqId: randomUUID(), ip }, "not_private", "This listener only serves the local network.");
    } else if (!lan && bans.isBanned(ip)) {
      reject(res, { reqId: randomUUID(), ip }, "banned", "Too many invalid API keys from this address: banned for a while.");
    } else {
      next();
    }
  });

  app.get("/health", (_req, res) => {
    res.json(service.health());
  });

  app.get("/status", (_req, res, next) => {
    if (!lan) return next();
    res.json(service.status());
  });

  app.post("/prove", async (req, res) => {
    const reqId = randomUUID();
    const ip = res.locals.ip as string;
    let site = "lan";

    if (!lan) {
      const auth = authenticate(req.headers.authorization, inst.network, config.get());
      if (!auth.ok) {
        if (auth.reason === "missing_key" || auth.reason === "unknown_key") {
          if (bans.recordFailure(ip, config.get().limits.badKey)) log.write("ban", { ip });
        }
        return reject(res, { reqId, ip }, auth.reason, AUTH_MESSAGES[auth.reason], undefined, auth.status);
      }
      site = auth.site;
    }
    log.write("request", { reqId, site, ip });
    const who = { reqId, site, ip };

    const maxBodyKB = config.get().limits.maxBodyKB;
    const parsed = await readJson(req, res, maxBodyKB * 1024);
    if (res.destroyed) return; // the client left while its body was read
    if (!parsed.ok) {
      const message =
        parsed.reason === "body_too_large"
          ? `The request body is larger than ${maxBodyKB} KB.`
          : "The request body is not valid JSON.";
      return reject(res, who, parsed.reason, message);
    }
    if (parsed.body === undefined) {
      return reject(res, who, "invalid_body", "Expected a JSON body (Content-Type: application/json).");
    }
    const check = validateProveBody(parsed.body);
    if (!check.ok) return reject(res, who, "invalid_body", check.message);

    const admission = service.admit(site, lan);
    if (!admission.ok) {
      return reject(res, who, admission.reason, admission.message, admission.retryAfterSec, admission.status);
    }

    const sse = new SseStream(res, { onDisconnect: () => service.cancel(reqId) });
    service.submit({ reqId, site, lan, ip, blockNumber: check.blockNumber, tx: check.tx, sse, enqueuedAt: Date.now() });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`request failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });

  return app;
}

// Local network: no key, no quota. Refuses any source address outside the private ranges.
export function createLanApp(deps: AppDeps): express.Express {
  return createApp(deps, true);
}

// Reached through Caddy only: key, quota and bans.
export function createPublicApp(deps: AppDeps): express.Express {
  return createApp(deps, false);
}

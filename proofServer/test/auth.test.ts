import assert from "node:assert/strict";
import test from "node:test";
import { BanList, authenticate } from "../src/auth";
import { Limits, Site, SitesConfig, emptyConfig } from "../src/config";
import { hashKey } from "../src/keys";

const RULE: Limits["badKey"] = { maxFailures: 10, windowMin: 10, banMin: 60 };
const MIN = 60_000;

function makeConfig(site: Partial<Site> = {}): SitesConfig {
  const config = emptyConfig();
  config.sites.voty = { keySha256: hashKey("K"), enabled: true, perDay: { sepolia: 2 }, ...site };
  return config;
}

test("authenticate", () => {
  const cfg = makeConfig();
  const missing = { ok: false, status: 401, reason: "missing_key" };
  assert.deepEqual(authenticate(undefined, "sepolia", cfg), missing);
  assert.deepEqual(authenticate("Basic K", "sepolia", cfg), missing);
  assert.deepEqual(authenticate("Bearer ", "sepolia", cfg), missing);
  assert.deepEqual(authenticate("Bearer", "sepolia", cfg), missing);
  assert.deepEqual(authenticate("bearer K", "sepolia", cfg), { ok: true, site: "voty" });
  assert.deepEqual(authenticate("Bearer   K  ", "sepolia", cfg), { ok: true, site: "voty" });
  assert.deepEqual(authenticate("Bearer nope", "sepolia", cfg), { ok: false, status: 401, reason: "unknown_key" });
  assert.deepEqual(authenticate("Bearer K", "mainnet", cfg), {
    ok: false,
    status: 403,
    reason: "network_not_allowed",
  });
  assert.deepEqual(authenticate("Bearer K", "sepolia", makeConfig({ enabled: false })), {
    ok: false,
    status: 403,
    reason: "site_disabled",
  });
  // a zero quota is still an allowed network: the quota rejects later
  assert.deepEqual(authenticate("Bearer K", "sepolia", makeConfig({ perDay: { sepolia: 0 } })), {
    ok: true,
    site: "voty",
  });
});

test("authenticate finds the site that owns the key", () => {
  const cfg = makeConfig();
  cfg.sites.other = { keySha256: hashKey("L"), enabled: true, perDay: { sepolia: 1 } };
  assert.deepEqual(authenticate("Bearer L", "sepolia", cfg), { ok: true, site: "other" });
  assert.deepEqual(authenticate("Bearer K", "sepolia", cfg), { ok: true, site: "voty" });
});

test("the hash stored in sites.json is not a valid key", () => {
  assert.deepEqual(authenticate(`Bearer ${hashKey("K")}`, "sepolia", makeConfig()), {
    ok: false,
    status: 401,
    reason: "unknown_key",
  });
});

test("BanList: 10 failures within 10 min ban for 60 min", () => {
  let now = 0;
  const bans = new BanList(() => now);
  for (let i = 0; i < 9; i++) {
    assert.equal(bans.recordFailure("1.2.3.4", RULE), false);
    assert.equal(bans.isBanned("1.2.3.4"), false);
  }
  assert.equal(bans.recordFailure("1.2.3.4", RULE), true);
  assert.equal(bans.isBanned("1.2.3.4"), true);
  assert.equal(bans.isBanned("5.6.7.8"), false);
  now = 60 * MIN - 1;
  assert.equal(bans.isBanned("1.2.3.4"), true);
  now = 60 * MIN + 1;
  assert.equal(bans.isBanned("1.2.3.4"), false);
});

test("BanList: failures spread beyond the window never ban", () => {
  let now = 0;
  const bans = new BanList(() => now);
  for (let i = 0; i < 10; i++) {
    bans.recordFailure("1.2.3.4", RULE);
    now += 2 * MIN;
  }
  assert.equal(bans.isBanned("1.2.3.4"), false);
});

test("BanList: IPs are counted separately; the count restarts after a ban", () => {
  let now = 0;
  const bans = new BanList(() => now);
  for (let i = 0; i < 5; i++) {
    bans.recordFailure("1.1.1.1", RULE);
    bans.recordFailure("2.2.2.2", RULE);
  }
  assert.equal(bans.isBanned("1.1.1.1"), false);
  assert.equal(bans.isBanned("2.2.2.2"), false);

  for (let i = 0; i < 5; i++) bans.recordFailure("1.1.1.1", RULE);
  assert.equal(bans.isBanned("1.1.1.1"), true);
  assert.equal(bans.isBanned("2.2.2.2"), false);

  now = 61 * MIN;
  for (let i = 0; i < 9; i++) assert.equal(bans.recordFailure("1.1.1.1", RULE), false);
  assert.equal(bans.recordFailure("1.1.1.1", RULE), true);
});

test("BanList forgets stale entries once maxTracked is reached", () => {
  let now = 0;
  const bans = new BanList(() => now, 3);
  for (let i = 0; i < 3; i++) bans.recordFailure(`10.0.0.${i}`, RULE);
  assert.equal(bans.trackedCount(), 3);
  now = 11 * MIN; // every failure is now outside the 10 min window
  bans.recordFailure("10.0.0.9", RULE);
  assert.equal(bans.trackedCount(), 1);
});

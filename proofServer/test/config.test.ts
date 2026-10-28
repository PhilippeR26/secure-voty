import assert from "node:assert/strict";
import { once } from "node:events";
import test, { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ConfigStore,
  DEFAULT_LIMITS,
  SitesConfig,
  emptyConfig,
  parseSitesConfig,
  readSitesFile,
  siteAllowed,
  writeSitesFile,
} from "../src/config";
import { hashKey } from "../src/keys";
import { waitFor } from "./helpers/home";

const HEX = hashKey("K");

function tmpSitesFile(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "config", "sites.json");
}

function startStore(t: TestContext, file: string): ConfigStore {
  const store = new ConfigStore(file);
  store.start();
  t.after(() => store.stop());
  return store;
}

test("defaults", () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    machineSlots: 1,
    queueMax: 10,
    perSiteQueueMax: 2,
    maxWaitSec: 900,
    proofTimeoutSec: 600,
    maxBodyKB: 256,
    badKey: { maxFailures: 10, windowMin: 10, banMin: 60 },
  });
  const r = parseSitesConfig("{}");
  assert.ok(r.ok);
  assert.deepEqual(r.config, emptyConfig());
});

test("partial limits are merged; enabled defaults to true", () => {
  const r = parseSitesConfig(
    JSON.stringify({ limits: { queueMax: 3 }, sites: { voty: { keySha256: HEX, perDay: { sepolia: 5 } } } }),
  );
  assert.ok(r.ok);
  assert.equal(r.config.limits.queueMax, 3);
  assert.equal(r.config.limits.maxWaitSec, 900);
  assert.deepEqual(r.config.limits.badKey, DEFAULT_LIMITS.badKey);
  assert.equal(r.config.sites.voty.enabled, true);
});

test("invalid configs name the faulty path", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["not JSON", "{ bad", /JSON/i],
    ["not an object", "[]", /object/],
    ["missing key hash", JSON.stringify({ sites: { voty: {} } }), /keySha256/],
    ["bad key hash", JSON.stringify({ sites: { voty: { keySha256: "xyz" } } }), /keySha256/],
    ["unknown network", JSON.stringify({ sites: { voty: { keySha256: HEX, perDay: { goerli: 1 } } } }), /goerli/],
    ["negative quota", JSON.stringify({ sites: { voty: { keySha256: HEX, perDay: { sepolia: -1 } } } }), /sepolia/],
    ["same key twice", JSON.stringify({ sites: { a: { keySha256: HEX }, b: { keySha256: HEX } } }), /same key/],
    ["machineSlots 0", JSON.stringify({ limits: { machineSlots: 0 } }), /machineSlots/],
    ["maxBodyKB too large", JSON.stringify({ limits: { maxBodyKB: 20000 } }), /maxBodyKB/],
    ["badKey.maxFailures 0", JSON.stringify({ limits: { badKey: { maxFailures: 0 } } }), /maxFailures/],
    ["reserved site name", JSON.stringify({ sites: { lan: { keySha256: HEX } } }), /reserved/],
    ["bad site name", JSON.stringify({ sites: { "-bad": { keySha256: HEX } } }), /-bad/],
    ["unknown site field", JSON.stringify({ sites: { voty: { keySha256: HEX, enable: false } } }), /enable/],
    ["unknown top-level field", JSON.stringify({ limit: {} }), /limit/],
  ];
  for (const [label, text, re] of cases) {
    const r = parseSitesConfig(text);
    assert.equal(r.ok, false, label);
    if (!r.ok) assert.match(r.error, re, label);
  }
});

test("the committed sites.example.json is valid", () => {
  const text = fs.readFileSync(path.resolve(__dirname, "..", "config", "sites.example.json"), "utf8");
  const r = parseSitesConfig(text);
  assert.ok(r.ok, r.ok ? "" : r.error);
});

test("write then read round-trips; a missing file reads as emptyConfig()", (t) => {
  const file = tmpSitesFile(t);
  assert.deepEqual(readSitesFile(file), emptyConfig());

  const config = emptyConfig();
  config.limits.queueMax = 4;
  config.sites.voty = { keySha256: HEX, enabled: false, perDay: { sepolia: 5, mainnet: 0 }, note: "demo" };
  writeSitesFile(file, config);
  assert.deepEqual(readSitesFile(file), config);

  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith('{\n  "limits"'));
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["sites.json"]);
});

test("reading an invalid file throws with the file name", (t) => {
  const file = tmpSitesFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ bad");
  assert.throws(() => readSitesFile(file), /sites\.json: invalid JSON/);
});

test("siteAllowed", () => {
  const config = emptyConfig();
  config.sites.voty = { keySha256: HEX, enabled: true, perDay: { sepolia: 5 } };
  config.sites.off = { keySha256: hashKey("other"), enabled: false, perDay: { sepolia: 5 } };
  config.sites.zero = { keySha256: hashKey("zero"), enabled: true, perDay: { sepolia: 0 } };
  assert.equal(siteAllowed(config, "voty", "sepolia"), true);
  assert.equal(siteAllowed(config, "off", "sepolia"), false);
  assert.equal(siteAllowed(config, "voty", "mainnet"), false);
  assert.equal(siteAllowed(config, "zero", "sepolia"), true); // the quota rejects later
  assert.equal(siteAllowed(config, "nobody", "sepolia"), false);
  assert.equal(siteAllowed(config, "constructor", "sepolia"), false);
});

test("start throws on an invalid file", (t) => {
  const file = tmpSitesFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ bad");
  assert.throws(() => new ConfigStore(file).start(), /sites\.json: invalid JSON/);
});

test("reload on change", async (t) => {
  const file = tmpSitesFile(t);
  writeSitesFile(file, emptyConfig());
  const store = startStore(t, file);
  const reloaded = once(store, "reload");
  const next = emptyConfig();
  next.limits.queueMax = 3;
  writeSitesFile(file, next);
  const [cfg] = await reloaded;
  assert.equal(cfg.limits.queueMax, 3);
  assert.equal(store.get().limits.queueMax, 3);
});

test("an invalid file keeps the previous config", async (t) => {
  const file = tmpSitesFile(t);
  writeSitesFile(file, emptyConfig());
  const store = startStore(t, file);
  const failed = once(store, "error");
  fs.writeFileSync(file, "{ bad");
  const [message] = await failed;
  assert.match(message, /sites\.json/);
  assert.equal(store.get().limits.queueMax, 10);
});

test("editor-style save (truncate, then write) ends on the new config", async (t) => {
  const file = tmpSitesFile(t);
  writeSitesFile(file, emptyConfig());
  const store = startStore(t, file);
  fs.writeFileSync(file, "");
  await setTimeout(20);
  fs.writeFileSync(file, JSON.stringify({ limits: { queueMax: 7 } }));
  await waitFor(() => store.get().limits.queueMax === 7, 3000);
});

test("reloadNow applies a change synchronously", (t) => {
  const file = tmpSitesFile(t);
  writeSitesFile(file, emptyConfig());
  const store = startStore(t, file);
  const next = emptyConfig();
  next.limits.queueMax = 3;
  writeSitesFile(file, next);
  store.reloadNow();
  assert.equal(store.get().limits.queueMax, 3);
});

test("a deleted file keeps the previous config; recreating it reloads", (t) => {
  const file = tmpSitesFile(t);
  const kept = emptyConfig();
  kept.limits.queueMax = 5;
  writeSitesFile(file, kept);
  const store = startStore(t, file);
  const errors: string[] = [];
  const reloads: SitesConfig[] = [];
  store.on("error", (message: string) => errors.push(message));
  store.on("reload", (config: SitesConfig) => reloads.push(config));

  fs.rmSync(file);
  store.reloadNow();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing/);
  assert.equal(store.get().limits.queueMax, 5);

  store.reloadNow(); // same state: nothing new to report
  assert.equal(errors.length, 1);

  const next = emptyConfig();
  next.limits.queueMax = 8;
  writeSitesFile(file, next);
  store.reloadNow();
  assert.equal(reloads.length, 1);
  assert.equal(store.get().limits.queueMax, 8);
});

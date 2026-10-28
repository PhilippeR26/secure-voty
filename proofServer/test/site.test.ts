import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "fs";
import path from "path";
import { main } from "../src/cli/main";
import { readSitesFile } from "../src/config";
import { hashKey } from "../src/keys";
import { instanceFiles } from "../src/layout";
import { utcDay } from "../src/quota";
import { TestHome, makeHome } from "./helpers/home";

interface Rig {
  home: TestHome;
  run(...args: string[]): Promise<{ code: number; text: string }>;
}

async function rig(t: TestContext): Promise<Rig> {
  const home = await makeHome();
  t.after(() => home.cleanup());
  return {
    home,
    async run(...args) {
      const lines: string[] = [];
      const code = await main(["site", ...args], home.layout, (line) => lines.push(line));
      return { code, text: lines.join("\n") };
    },
  };
}

// The key is alone on an indented line.
function keyOf(text: string): string {
  const match = /^\s+([A-Za-z0-9_-]{43})$/m.exec(text);
  assert.ok(match, `no key in: ${text}`);
  return match[1];
}

const sites = (r: Rig) => readSitesFile(r.home.layout.sitesFile).sites;

test("add prints the key once and stores only its hash", async (t) => {
  const r = await rig(t);
  const { code, text } = await r.run("add", "voty", "--sepolia", "100", "--note", "Secure voty");
  assert.equal(code, 0);
  const key = keyOf(text);
  assert.match(text, /Saved config\/sites\.json/);
  assert.match(text, /cannot be shown again/);
  assert.deepEqual(sites(r).voty, {
    keySha256: hashKey(key),
    enabled: true,
    perDay: { sepolia: 100 },
    note: "Secure voty",
  });
  assert.ok(!fs.readFileSync(r.home.layout.sitesFile, "utf8").includes(key));
});

test("add refuses an existing site", async (t) => {
  const r = await rig(t);
  assert.equal((await r.run("add", "voty", "--sepolia", "1")).code, 0);
  const again = await r.run("add", "voty", "--sepolia", "5");
  assert.equal(again.code, 1);
  assert.match(again.text, /already exists/);
  assert.deepEqual(sites(r).voty.perDay, { sepolia: 1 });
});

test("set changes quotas; off removes a network", async (t) => {
  const r = await rig(t);
  await r.run("add", "voty", "--sepolia", "100");
  const result = await r.run("set", "voty", "--mainnet", "5", "--sepolia", "off", "--note", "changed");
  assert.equal(result.code, 0);
  assert.deepEqual(sites(r).voty.perDay, { mainnet: 5 });
  assert.equal(sites(r).voty.note, "changed");
  assert.equal((await r.run("set", "voty")).code, 1); // nothing to change
});

test("disable, enable, remove", async (t) => {
  const r = await rig(t);
  await r.run("add", "voty", "--sepolia", "100");
  assert.equal((await r.run("disable", "voty")).code, 0);
  assert.equal(sites(r).voty.enabled, false);
  assert.equal((await r.run("enable", "voty")).code, 0);
  assert.equal(sites(r).voty.enabled, true);
  assert.equal((await r.run("remove", "voty")).code, 0);
  assert.deepEqual(sites(r), {});
});

test("rotate-key replaces the hash", async (t) => {
  const r = await rig(t);
  const oldKey = keyOf((await r.run("add", "voty", "--sepolia", "100")).text);
  const rotated = await r.run("rotate-key", "voty");
  assert.equal(rotated.code, 0);
  const newKey = keyOf(rotated.text);
  assert.notEqual(newKey, oldKey);
  assert.equal(sites(r).voty.keySha256, hashKey(newKey));
  assert.notEqual(sites(r).voty.keySha256, hashKey(oldKey));
});

test("bad quotas are refused and change nothing", async (t) => {
  const r = await rig(t);
  for (const bad of ["-1", "abc", "1.5", ""]) {
    const result = await r.run("add", "voty", `--sepolia=${bad}`);
    assert.equal(result.code, 1, bad);
  }
  assert.equal((await r.run("add", "voty", "--sepolia", "-1")).code, 1);
  assert.deepEqual(sites(r), {});
  await r.run("add", "voty", "--sepolia", "100");
  assert.equal((await r.run("set", "voty", "--sepolia=abc")).code, 1);
  assert.deepEqual(sites(r).voty.perDay, { sepolia: 100 });
});

test("list shows today's usage per network", async (t) => {
  const r = await rig(t);
  r.home.writeInstance("sepolia", { NETWORK: "sepolia", STARKNET_RPC_URL: "http://127.0.0.1:9545", LAN_PORT: 3030 });
  await r.run("add", "voty", "--sepolia", "100", "--mainnet", "5");
  await r.run("add", "idle", "--sepolia", "10");
  await r.run("disable", "idle");
  const { usageFile } = instanceFiles(r.home.layout, "sepolia");
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  fs.writeFileSync(usageFile, JSON.stringify({ day: utcDay(new Date()), used: { voty: 3 } }));

  const { code, text } = await r.run("list");
  assert.equal(code, 0);
  const voty = text.split("\n").find((line) => line.startsWith("voty"));
  assert.ok(voty, text);
  assert.match(voty, /enabled/);
  assert.match(voty, /sepolia 3\/100/);
  assert.match(voty, /mainnet 0\/5/);
  const idle = text.split("\n").find((line) => line.startsWith("idle"));
  assert.ok(idle, text);
  assert.match(idle, /disabled/);
  assert.match(idle, /sepolia 0\/10/);
});

test("unknown site, missing name, unknown command", async (t) => {
  const r = await rig(t);
  for (const args of [["remove", "ghost"], ["disable", "ghost"], ["rotate-key", "ghost"], ["set", "ghost", "--sepolia", "1"]]) {
    const result = await r.run(...args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.text, /unknown site/);
  }
  const noName = await r.run("add");
  assert.equal(noName.code, 1);
  assert.match(noName.text, /name/);
  assert.equal((await r.run("frobnicate")).code, 1);
  assert.equal((await r.run()).code, 1);
  assert.equal((await r.run("list")).code, 0); // empty list is not an error
});

test("an invalid name is refused without writing anything", async (t) => {
  const r = await rig(t);
  const result = await r.run("add", "lan", "--sepolia", "1");
  assert.equal(result.code, 1);
  assert.match(result.text, /reserved/);
  assert.equal(fs.existsSync(r.home.layout.sitesFile), false);
});

test("a broken sites.json is reported, not overwritten", async (t) => {
  const r = await rig(t);
  fs.mkdirSync(path.dirname(r.home.layout.sitesFile), { recursive: true });
  fs.writeFileSync(r.home.layout.sitesFile, "{ bad");
  const result = await r.run("add", "voty", "--sepolia", "1");
  assert.equal(result.code, 1);
  assert.match(result.text, /sites\.json/);
  assert.equal(fs.readFileSync(r.home.layout.sitesFile, "utf8"), "{ bad");
});

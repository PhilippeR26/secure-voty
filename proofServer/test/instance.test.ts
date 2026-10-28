import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import {
  CHAIN_IDS,
  CHAIN_NAMES,
  InstanceError,
  NETWORKS,
  listInstances,
  loadInstance,
} from "../src/instance";
import { resolveLayout } from "../src/layout";
import { makeHome } from "./helpers/home";

const base = { NETWORK: "sepolia", STARKNET_RPC_URL: "http://127.0.0.1:9545/rpc/v0_9", LAN_PORT: 3030 };
const full = { ...base, PUBLIC_ENABLED: true, PUBLIC_PORT: 4030 };

test("loads a complete instance file", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  h.writeInstance("sepolia", full);
  assert.deepEqual(loadInstance(h.layout, "sepolia"), {
    name: "sepolia",
    network: "sepolia",
    rpcUrl: full.STARKNET_RPC_URL,
    lanPort: 3030,
    publicEnabled: true,
    publicPort: 4030,
    logMaxBytes: 5 * 1024 * 1024,
    logFiles: 3,
    snip36Binary: path.join(h.layout.repoDir, "target/release/snip36"),
  });
});

test("PUBLIC_ENABLED defaults to false; publicPort is then null", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  h.writeInstance("sepolia", base);
  const lanOnly = loadInstance(h.layout, "sepolia");
  assert.equal(lanOnly.publicEnabled, false);
  assert.equal(lanOnly.publicPort, null);

  h.writeInstance("sepolia", { ...base, PUBLIC_ENABLED: false, PUBLIC_PORT: 4030 });
  assert.equal(loadInstance(h.layout, "sepolia").publicPort, null);
});

test("bad files name the variable", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  const cases: Array<[string, Record<string, string | number | boolean>, RegExp]> = [
    ["unknown network", { ...full, NETWORK: "goerli" }, /NETWORK/],
    ["missing node URL", { NETWORK: "sepolia", LAN_PORT: 3030 }, /STARKNET_RPC_URL/],
    ["node URL without scheme", { ...full, STARKNET_RPC_URL: "localhost:9545" }, /STARKNET_RPC_URL/],
    ["LAN port 0", { ...full, LAN_PORT: 0 }, /LAN_PORT/],
    ["public without port", { ...base, PUBLIC_ENABLED: true }, /PUBLIC_PORT/],
    ["same port twice", { ...full, PUBLIC_PORT: 3030 }, /PUBLIC_PORT/],
    ["PUBLIC_ENABLED not a boolean", { ...full, PUBLIC_ENABLED: "yes" }, /PUBLIC_ENABLED/],
    ["LOG_MAX_MB not positive", { ...full, LOG_MAX_MB: 0 }, /LOG_MAX_MB/],
    ["LOG_FILES below 1", { ...full, LOG_FILES: 0 }, /LOG_FILES/],
  ];
  for (const [label, vars, re] of cases) {
    h.writeInstance("x", vars);
    assert.throws(
      () => loadInstance(h.layout, "x"),
      (e) => e instanceof InstanceError && re.test(e.message) && e.message.includes("instances/x.env"),
      label,
    );
  }
});

test("missing file says how to create it", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  assert.throws(
    () => loadInstance(h.layout, "nope"),
    (e) => e instanceof InstanceError && /instances\/nope\.env/.test(e.message) && /example\.env/.test(e.message),
  );
});

test("instance names must be URL-safe", () => {
  const layout = resolveLayout({ PROOF_SERVER_HOME: "/nonexistent" });
  assert.throws(
    () => loadInstance(layout, "Sepolia_1"),
    (e) => e instanceof InstanceError && /name/.test(e.message),
  );
});

test("the name caddy is reserved: its pid file and log belong to Caddy", () => {
  const layout = resolveLayout({ PROOF_SERVER_HOME: "/nonexistent" });
  assert.throws(
    () => loadInstance(layout, "caddy"),
    (e) => e instanceof InstanceError && /reserved/.test(e.message),
  );
});

test("listInstances skips example.env", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  assert.deepEqual(listInstances(h.layout), []);
  for (const name of ["example", "sepolia", "mainnet"]) h.writeInstance(name, base);
  assert.deepEqual(listInstances(h.layout), ["mainnet", "sepolia"]);
});

test("the committed example.env is valid", () => {
  assert.equal(loadInstance(resolveLayout({}), "example").network, "sepolia");
});

test("CHAIN_IDS are the hex short strings of CHAIN_NAMES", () => {
  assert.deepEqual(NETWORKS, ["mainnet", "sepolia"]);
  for (const n of NETWORKS) {
    assert.equal(CHAIN_IDS[n], "0x" + Buffer.from(CHAIN_NAMES[n]).toString("hex"));
  }
});

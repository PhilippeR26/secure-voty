import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { renderCaddyfile } from "../src/cli/caddy";
import { main } from "../src/cli/main";
import { InstanceConfig, Network, loadInstance } from "../src/instance";
import { resolveLayout } from "../src/layout";
import { makeHome } from "./helpers/home";

const node = { STARKNET_RPC_URL: "http://127.0.0.1:9545" };

test("renderCaddyfile routes each public instance", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  h.writeInstance("sepolia", { NETWORK: "sepolia", ...node, LAN_PORT: 3030, PUBLIC_ENABLED: true, PUBLIC_PORT: 4030 });
  h.writeInstance("mainnet", { NETWORK: "mainnet", ...node, LAN_PORT: 3031, PUBLIC_ENABLED: true, PUBLIC_PORT: 4031 });
  h.writeInstance("local", { NETWORK: "sepolia", ...node, LAN_PORT: 3032 });
  const instances = ["sepolia", "mainnet", "local"].map((name) => loadInstance(h.layout, name));

  const text = renderCaddyfile(h.layout, "myproof.duckdns.org", instances);
  for (const part of [
    "https_port 8443",
    "myproof.duckdns.org {",
    "handle_path /mainnet/* {",
    "reverse_proxy 127.0.0.1:4031 {",
    "handle_path /sepolia/* {",
    "reverse_proxy 127.0.0.1:4030 {",
    "disable_http_challenge",
    "flush_interval -1",
    `root ${h.layout.stateDir}/caddy`,
    `output file ${h.layout.logsDir}/caddy.log {`,
  ]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes("/local/"));
  assert.ok(text.indexOf("handle_path /mainnet/*") < text.indexOf("handle_path /sepolia/*"));
  assert.ok(text.endsWith("}\n"));
});

test("caddyfile command checks its input", async (t) => {
  const h = await makeHome();
  t.after(() => h.cleanup());
  const run = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await main(["caddyfile", ...args], h.layout, (line) => lines.push(line));
    return { code, text: lines.join("\n") };
  };

  assert.equal((await run()).code, 1); // no domain
  assert.equal((await run("--domain", "my proof")).code, 1);
  assert.equal((await run("--domain", "localhost")).code, 1);

  h.writeInstance("local", { NETWORK: "sepolia", ...node, LAN_PORT: 3032 });
  const none = await run("--domain", "myproof.duckdns.org");
  assert.equal(none.code, 1);
  assert.match(none.text, /No public instance/);
  assert.equal(fs.existsSync(h.layout.caddyfile), false);

  h.writeInstance("sepolia", { NETWORK: "sepolia", ...node, LAN_PORT: 3030, PUBLIC_ENABLED: true, PUBLIC_PORT: 4030 });
  const ok = await run("--domain", "myproof.duckdns.org");
  assert.equal(ok.code, 0);
  assert.ok(fs.readFileSync(h.layout.caddyfile, "utf8").includes("myproof.duckdns.org {"));
  assert.match(ok.text, /https:\/\/myproof\.duckdns\.org\/sepolia\/prove/);
  assert.match(ok.text, /Freebox: forward TCP 443 to this machine, port 8443\./);
});

test("the committed Caddyfile.example is what renderCaddyfile gives", () => {
  const layout = resolveLayout({ PROOF_SERVER_HOME: "/home/you/secure-voty/proofServer" });
  const publicInstance = (network: Network, publicPort: number): InstanceConfig => ({
    name: network,
    network,
    rpcUrl: "http://127.0.0.1:9545",
    lanPort: publicPort - 1000,
    publicEnabled: true,
    publicPort,
    logMaxBytes: 1,
    logFiles: 1,
    snip36Binary: "",
  });
  const expected = renderCaddyfile(layout, "myproof.duckdns.org", [
    publicInstance("sepolia", 4030),
    publicInstance("mainnet", 4031),
  ]);
  const committed = fs.readFileSync(path.resolve(__dirname, "..", "deploy", "Caddyfile.example"), "utf8");
  assert.equal(committed, expected);
});

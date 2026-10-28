import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import test, { TestContext } from "node:test";
import { CHAIN_IDS } from "../src/instance";
import { fetchChainId } from "../src/rpc";
import { freePort } from "./helpers/home";
import { startFakeRpc } from "./helpers/rpc";

// A node that answers every request with `handler`; returns its URL.
async function serve(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("fetchChainId returns the chain id the node gives", async (t) => {
  const integration = "0x534e5f494e544547524154494f4e5f5345504f4c4941"; // SN_INTEGRATION_SEPOLIA
  for (const chainId of [CHAIN_IDS.sepolia, CHAIN_IDS.mainnet, integration]) {
    const rpc = await startFakeRpc(chainId);
    t.after(() => rpc.close());
    assert.equal(await fetchChainId(rpc.url), chainId);
  }
});

test("a node that refuses the connection is reported with the reason", async () => {
  const closedPort = await freePort(); // fetch itself refuses a few ports, port 1 among them
  await assert.rejects(fetchChainId(`http://127.0.0.1:${closedPort}`), /ECONNREFUSED/);
});

test("an HTTP error is reported with its status", async (t) => {
  const url = await serve(t, (_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await assert.rejects(fetchChainId(url), /HTTP 404/);
});

test("a JSON-RPC error is reported with the message of the node", async (t) => {
  const url = await serve(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }));
  });
  await assert.rejects(fetchChainId(url), /Method not found/);
});

test("a node that never answers ends with a timeout", async (t) => {
  const url = await serve(t, () => {});
  const started = Date.now();
  await assert.rejects(fetchChainId(url, 300), /timeout|aborted/i);
  assert.ok(Date.now() - started < 3000);
});

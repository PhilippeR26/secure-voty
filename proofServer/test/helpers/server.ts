import fs from "fs";
import { Limits } from "../../src/config";
import { CHAIN_IDS } from "../../src/instance";
import { hashKey } from "../../src/keys";
import { RunningServer, startServer } from "../../src/server";
import { FAKE_SNIP36 } from "./fake";
import { TestHome, freePort, makeHome } from "./home";
import { startFakeRpc } from "./rpc";

export const TEST_KEY = "test-key-0123456789";

export interface TestServer {
  home: TestHome;
  server: RunningServer;
  lanUrl: string;
  publicUrl: string;
  close(): Promise<void>;
}

// A complete instance "sepolia" (LAN and public listeners) on free ports, with a fake node, the fake prover
// and a site "voty" whose key is TEST_KEY.
export async function startTestServer(
  opts: { limits?: Partial<Limits>; perDay?: number; chainId?: string } = {},
): Promise<TestServer> {
  const home = await makeHome();
  const rpc = await startFakeRpc(opts.chainId ?? CHAIN_IDS.sepolia);
  const lanPort = await freePort();
  let publicPort = await freePort();
  while (publicPort === lanPort) publicPort = await freePort();

  fs.mkdirSync(home.layout.repoDir, { recursive: true }); // the fake prover runs there
  home.writeInstance("sepolia", {
    NETWORK: "sepolia",
    STARKNET_RPC_URL: rpc.url,
    LAN_PORT: lanPort,
    PUBLIC_ENABLED: true,
    PUBLIC_PORT: publicPort,
    SNIP36_BINARY: FAKE_SNIP36,
  });
  home.writeSites({
    limits: opts.limits ?? {},
    sites: { voty: { keySha256: hashKey(TEST_KEY), enabled: true, perDay: { sepolia: opts.perDay ?? 2 } } },
  });

  let server: RunningServer;
  try {
    server = await startServer(home.layout, "sepolia");
  } catch (err) {
    await rpc.close();
    home.cleanup();
    throw err;
  }
  return {
    home,
    server,
    lanUrl: server.lanUrl,
    publicUrl: server.publicUrl!,
    async close() {
      await server.stop(0);
      await rpc.close();
      home.cleanup();
    },
  };
}

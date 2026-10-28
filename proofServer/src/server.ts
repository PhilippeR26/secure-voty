import fs from "fs";
import http from "http";
import path from "path";
import { CairoFelt252, num } from "starknet";
import { createLanApp, createPublicApp } from "./app";
import { BanList } from "./auth";
import { ConfigStore, readSitesFile } from "./config";
import { CHAIN_IDS, CHAIN_NAMES, InstanceConfig, loadInstance } from "./instance";
import { Layout, instanceFiles } from "./layout";
import { JsonlLogger } from "./log";
import { QuotaStore } from "./quota";
import { fetchChainId } from "./rpc";
import { ProofService } from "./service";
import { killOrphanProofs } from "./slots";

export class StartupError extends Error {}

export interface RunningServer {
  inst: InstanceConfig;
  lanUrl: string;
  publicUrl: string | null;
  service: ProofService;
  stop(graceMs?: number): Promise<void>;
}

export const SHUTDOWN_GRACE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  const e = err as Error & { cause?: { message?: string } };
  return e.cause?.message ?? e.message;
}

// "SN_MAIN" for 0x534e5f4d41494e; the hex itself when it does not decode to printable text.
function chainName(chainId: string): string {
  try {
    const text = new CairoFelt252(chainId).decodeUtf8();
    if (/^[\x20-\x7e]+$/.test(text)) return text;
  } catch {
    // not a felt: shown as it is
  }
  return chainId;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", (err) => console.error(`listener ${host}:${port}: ${err.message}`));
      resolve();
    });
  });
}

function stopListening(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

// Checks everything an instance needs, then starts it. A failure says what to do.
export async function startServer(layout: Layout, instName: string): Promise<RunningServer> {
  let inst: InstanceConfig;
  try {
    inst = loadInstance(layout, instName);
  } catch (err) {
    throw new StartupError((err as Error).message);
  }

  try {
    fs.accessSync(inst.snip36Binary, fs.constants.X_OK);
  } catch {
    throw new StartupError(`snip36 not found at ${inst.snip36Binary} — run ./proof-server.sh setup`);
  }

  try {
    readSitesFile(layout.sitesFile);
  } catch (err) {
    throw new StartupError((err as Error).message);
  }

  let chainId: string;
  try {
    chainId = await fetchChainId(inst.rpcUrl);
  } catch (err) {
    throw new StartupError(`node ${inst.rpcUrl} unreachable: ${errorText(err)}`);
  }
  let sameChain = false;
  try {
    sameChain = num.toBigInt(chainId) === num.toBigInt(CHAIN_IDS[inst.network]);
  } catch {
    // not a number: it is not the expected chain
  }
  if (!sameChain) {
    throw new StartupError(
      `node ${inst.rpcUrl} is on ${chainName(chainId)}, but instances/${inst.name}.env says ` +
        `NETWORK=${inst.network} (${CHAIN_NAMES[inst.network]})`,
    );
  }

  // The work directory only holds the files of the proofs that are running.
  const files = instanceFiles(layout, inst.name);
  for (const dir of [layout.logsDir, path.dirname(files.usageFile), layout.slotsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(files.workDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(files.workDir, 0o700);
  for (const name of fs.readdirSync(files.workDir)) {
    fs.rmSync(path.join(files.workDir, name), { recursive: true, force: true });
  }

  await killOrphanProofs(layout);

  const log = new JsonlLogger({
    file: files.logFile,
    inst: inst.name,
    maxBytes: inst.logMaxBytes,
    maxFiles: inst.logFiles,
  });
  const config = new ConfigStore(layout.sitesFile);
  config.on("reload", () => log.write("config_reload"));
  config.on("error", (msg: string) => log.write("config_error", { msg }));
  try {
    config.start();
  } catch (err) {
    throw new StartupError((err as Error).message);
  }
  const service = new ProofService({ inst, layout, config, quota: new QuotaStore(files.usageFile), log });
  const deps = { inst, service, config, bans: new BanList(), log };

  const servers: http.Server[] = [];
  const open = async (app: http.RequestListener, port: number, host: string, optional = false): Promise<void> => {
    const server = http.createServer(app);
    try {
      await listen(server, port, host);
      servers.push(server);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (optional && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")) return; // no such address here
      if (code === "EADDRINUSE") {
        throw new StartupError(`port ${port} is already in use (another instance, or the old proof server?)`);
      }
      throw new StartupError(`cannot listen on ${host}:${port}: ${(err as Error).message}`);
    }
  };
  try {
    const lanApp = createLanApp(deps);
    await open(lanApp, inst.lanPort, "0.0.0.0");
    await open(lanApp, inst.lanPort, "::1", true); // so that http://localhost:<port> works whichever address localhost resolves to
    if (inst.publicEnabled) await open(createPublicApp(deps), inst.publicPort!, "127.0.0.1");
  } catch (err) {
    await Promise.all(servers.map(stopListening));
    await service.shutdown(0);
    config.stop();
    throw err;
  }

  log.write("startup", { msg: `network=${inst.network} lan=${inst.lanPort} public=${inst.publicPort ?? "off"}` });
  console.log(
    `${inst.name}: listening — LAN port ${inst.lanPort}, ` +
      `public ${inst.publicEnabled ? `127.0.0.1:${inst.publicPort}` : "off"}`,
  );

  let stopping: Promise<void> | null = null;
  const stop = (graceMs = SHUTDOWN_GRACE_MS): Promise<void> =>
    (stopping ??= (async () => {
      log.write("shutdown");
      const closed = servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
      await service.shutdown(graceMs);
      config.stop();
      for (const server of servers) server.closeIdleConnections();
      await Promise.race([Promise.all(closed), sleep(1000)]);
      for (const server of servers) server.closeAllConnections();
    })());

  return {
    inst,
    lanUrl: `http://127.0.0.1:${inst.lanPort}`,
    publicUrl: inst.publicEnabled ? `http://127.0.0.1:${inst.publicPort}` : null,
    service,
    stop,
  };
}

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { constants } from "starknet";
import { Layout, instanceFiles } from "./layout";

export type Network = "mainnet" | "sepolia";
export const NETWORKS: readonly Network[] = ["mainnet", "sepolia"];
export const CHAIN_NAMES: Record<Network, string> = {
  mainnet: constants.NetworkName.SN_MAIN,
  sepolia: constants.NetworkName.SN_SEPOLIA,
};
export const CHAIN_IDS: Record<Network, string> = {
  mainnet: constants.StarknetChainId.SN_MAIN,
  sepolia: constants.StarknetChainId.SN_SEPOLIA,
};

export interface InstanceConfig {
  name: string;
  network: Network;
  rpcUrl: string;
  lanPort: number;
  publicEnabled: boolean;
  publicPort: number | null;
  logMaxBytes: number;
  logFiles: number;
  snip36Binary: string;
}

export class InstanceError extends Error {}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_LOG_MAX_MB = 5;
const DEFAULT_LOG_FILES = 3;

function bad(label: string, message: string): InstanceError {
  return new InstanceError(`${label}: ${message}`);
}

function readPort(label: string, key: string, raw: string | undefined): number {
  const text = raw?.trim() ?? "";
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw bad(label, `${key} must be an integer between 1 and 65535`);
  }
  return port;
}

export function loadInstance(layout: Layout, name: string): InstanceConfig {
  if (!NAME_RE.test(name)) {
    throw new InstanceError(
      `instance name "${name}" is invalid: use lowercase letters, digits and dashes, starting with a letter or a digit`,
    );
  }
  if (name === "caddy") {
    throw new InstanceError('instance name "caddy" is reserved: state/caddy.pid and logs/caddy.log belong to Caddy');
  }
  const label = `instances/${name}.env`;

  let text: string;
  try {
    text = fs.readFileSync(instanceFiles(layout, name).envFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstanceError(`${label} not found — copy instances/example.env to ${label}`);
    }
    throw bad(label, (err as Error).message);
  }
  const vars = dotenv.parse(text); // never touches process.env

  const network = NETWORKS.find((n) => n === vars.NETWORK?.trim());
  if (!network) throw bad(label, `NETWORK must be one of: ${NETWORKS.join(", ")}`);

  const rpcUrl = vars.STARKNET_RPC_URL?.trim();
  if (!rpcUrl) throw bad(label, "STARKNET_RPC_URL is missing");
  if (!/^https?:\/\//.test(rpcUrl)) throw bad(label, "STARKNET_RPC_URL must start with http:// or https://");

  const lanPort = readPort(label, "LAN_PORT", vars.LAN_PORT);

  const rawPublic = (vars.PUBLIC_ENABLED ?? "false").trim();
  if (rawPublic !== "true" && rawPublic !== "false") {
    throw bad(label, "PUBLIC_ENABLED must be true or false");
  }
  const publicEnabled = rawPublic === "true";
  let publicPort: number | null = null;
  if (publicEnabled) {
    if (!vars.PUBLIC_PORT?.trim()) throw bad(label, "PUBLIC_PORT is required when PUBLIC_ENABLED=true");
    publicPort = readPort(label, "PUBLIC_PORT", vars.PUBLIC_PORT);
    if (publicPort === lanPort) throw bad(label, "PUBLIC_PORT must differ from LAN_PORT");
  }

  const rawMb = vars.LOG_MAX_MB?.trim();
  const logMaxMb = rawMb ? Number(rawMb) : DEFAULT_LOG_MAX_MB;
  if (!Number.isFinite(logMaxMb) || logMaxMb <= 0) throw bad(label, "LOG_MAX_MB must be a positive number");

  const rawFiles = vars.LOG_FILES?.trim();
  const logFiles = rawFiles ? Number(rawFiles) : DEFAULT_LOG_FILES;
  if (!Number.isInteger(logFiles) || logFiles < 1) throw bad(label, "LOG_FILES must be an integer >= 1");

  const rawBinary = vars.SNIP36_BINARY?.trim();
  const snip36Binary = rawBinary
    ? path.resolve(layout.root, rawBinary)
    : path.join(layout.repoDir, "target/release/snip36");

  return {
    name,
    network,
    rpcUrl,
    lanPort,
    publicEnabled,
    publicPort,
    logMaxBytes: Math.round(logMaxMb * 1024 * 1024),
    logFiles,
    snip36Binary,
  };
}

export function listInstances(layout: Layout): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(layout.instancesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((file) => file.endsWith(".env") && file.length > ".env".length)
    .map((file) => file.slice(0, -".env".length))
    .filter((name) => name !== "example")
    .sort();
}

import { parseArgs } from "util";
import { Site, SitesConfig, parseSitesConfig, readSitesFile, writeSitesFile } from "../config";
import { NETWORKS, Network, listInstances, loadInstance } from "../instance";
import { generateKey, hashKey } from "../keys";
import { Layout, instanceFiles } from "../layout";
import { QuotaStore } from "../quota";
import type { Command, Out } from "./main";

const USAGE = [
  "Usage: ./proof-server.sh site <command>",
  "",
  "  add <name> [--sepolia N] [--mainnet N] [--note TEXT]   create a site; its key is shown once",
  "  set <name> [--sepolia N|off] [--mainnet N|off] [--note TEXT]",
  "                                                         change its daily quotas (off: network not allowed)",
  "  enable <name> | disable <name> | remove <name>",
  "  rotate-key <name>                                      new key; the old one is refused at once",
  "  list                                                   sites, and today's use of their quotas",
];

interface Options {
  name: string | undefined;
  quotas: Partial<Record<Network, number | "off">>;
  note: string | undefined;
}

// A daily quota: a whole number, or "off" for "this network is not allowed".
function quotaFrom(raw: string): number | "off" | null {
  if (raw === "off") return "off";
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}

// Returns the options, or the message to show.
function parseOptions(args: string[]): Options | string {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...Object.fromEntries(NETWORKS.map((network) => [network, { type: "string" as const }])),
        note: { type: "string" as const },
      },
    });
  } catch (err) {
    return (err as Error).message;
  }
  const quotas: Options["quotas"] = {};
  for (const network of NETWORKS) {
    const raw = (parsed.values as Record<string, string | undefined>)[network];
    if (raw === undefined) continue;
    const quota = quotaFrom(raw);
    if (quota === null) return `--${network}: expected a whole number (0 or more) or "off", got "${raw}"`;
    quotas[network] = quota;
  }
  return { name: parsed.positionals[0], quotas, note: parsed.values.note as string | undefined };
}

// Checks the whole configuration with the rules the server applies, then writes it.
function save(layout: Layout, config: SitesConfig, out: Out): boolean {
  const checked = parseSitesConfig(JSON.stringify(config));
  if (!checked.ok) {
    out(checked.error);
    return false;
  }
  writeSitesFile(layout.sitesFile, config);
  out("Saved config/sites.json — running instances apply it within 5 s.");
  return true;
}

function printKey(name: string, key: string, out: Out): void {
  out("");
  out(`Key of "${name}". Send it through a private channel (never a git repository or a plain email):`);
  out("it cannot be shown again, only a hash of it is kept.");
  out("");
  out(`  ${key}`);
  out("");
}

function applyQuotas(site: Site, quotas: Options["quotas"]): void {
  for (const network of NETWORKS) {
    const quota = quotas[network];
    if (quota === undefined) continue;
    if (quota === "off") delete site.perDay[network];
    else site.perDay[network] = quota;
  }
}

const needName = (out: Out): number => {
  out("A site name is missing.");
  out(USAGE[0]);
  return 1;
};

const unknownSite = (name: string, config: SitesConfig, out: Out): number => {
  const known = Object.keys(config.sites);
  out(`unknown site "${name}"${known.length > 0 ? `; known: ${known.join(", ")}` : ""}`);
  return 1;
};

function list(layout: Layout, config: SitesConfig, out: Out): number {
  const names = Object.keys(config.sites).sort();
  if (names.length === 0) {
    out("No site yet: ./proof-server.sh site add <name> --sepolia 100");
    return 0;
  }
  // Today's use of a network: the sum over the instances of that network.
  const usage = new Map<Network, QuotaStore[]>(NETWORKS.map((network) => [network, []]));
  for (const instance of listInstances(layout)) {
    try {
      const { network } = loadInstance(layout, instance);
      usage.get(network)!.push(new QuotaStore(instanceFiles(layout, instance).usageFile));
    } catch {
      // an instance file with an error does not stop the list
    }
  }
  for (const name of names) {
    const site = config.sites[name];
    const networks = NETWORKS.filter((network) => site.perDay[network] !== undefined).map((network) => {
      const used = usage.get(network)!.reduce((sum, store) => sum + store.used(name), 0);
      return `${network} ${used}/${site.perDay[network]}`;
    });
    const note = site.note ? `  — ${site.note}` : "";
    out(`${name}  ${site.enabled ? "enabled" : "disabled"}  ${networks.join("  ") || "no network allowed"}${note}`);
  }
  return 0;
}

export const siteCommand: Command = async (layout, args, out) => {
  const [command, ...rest] = args;
  if (command === undefined || !["add", "set", "enable", "disable", "remove", "rotate-key", "list"].includes(command)) {
    if (command !== undefined) out(`Unknown site command: ${command}`);
    USAGE.forEach((line) => out(line));
    return 1;
  }

  const options = parseOptions(rest);
  if (typeof options === "string") {
    out(options);
    return 1;
  }
  const config = readSitesFile(layout.sitesFile);
  if (command === "list") return list(layout, config, out);

  const { name } = options;
  if (name === undefined) return needName(out);

  if (command === "add") {
    if (Object.hasOwn(config.sites, name)) {
      out(`site "${name}" already exists: use "site set ${name} ..." or "site rotate-key ${name}"`);
      return 1;
    }
    const key = generateKey();
    const site: Site = { keySha256: hashKey(key), enabled: true, perDay: {}, ...(options.note !== undefined && { note: options.note }) };
    applyQuotas(site, options.quotas);
    config.sites[name] = site;
    if (!save(layout, config, out)) return 1;
    printKey(name, key, out);
    if (Object.keys(site.perDay).length === 0) {
      out(`No quota given: "${name}" cannot use any network yet. Add one with: site set ${name} --sepolia 100`);
    }
    return 0;
  }

  if (!Object.hasOwn(config.sites, name)) return unknownSite(name, config, out);
  const site = config.sites[name];

  switch (command) {
    case "set":
      if (Object.keys(options.quotas).length === 0 && options.note === undefined) {
        out("Nothing to change: give --sepolia, --mainnet or --note.");
        return 1;
      }
      applyQuotas(site, options.quotas);
      if (options.note !== undefined) site.note = options.note;
      return save(layout, config, out) ? 0 : 1;
    case "enable":
    case "disable":
      site.enabled = command === "enable";
      return save(layout, config, out) ? 0 : 1;
    case "remove":
      delete config.sites[name];
      return save(layout, config, out) ? 0 : 1;
    default: {
      // rotate-key
      const key = generateKey();
      site.keySha256 = hashKey(key);
      if (!save(layout, config, out)) return 1;
      printKey(name, key, out);
      return 0;
    }
  }
};

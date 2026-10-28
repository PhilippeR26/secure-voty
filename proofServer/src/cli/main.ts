import { Layout, resolveLayout } from "../layout";
import { caddyfileCommand } from "./caddy";
import { restartCommand, startCommand, statusCommand, stopCommand } from "./lifecycle";
import { setupCommand } from "./setup";
import { siteCommand } from "./site";

export type Out = (line: string) => void;
// Returns the exit code.
export type Command = (layout: Layout, args: string[], out: Out) => Promise<number>;

const HELP = [
  "Usage: ./proof-server.sh <command> [options]",
  "",
  "  setup                       clone and build the snip36 prover (once per machine)",
  "  start [<instance>|all]      start the instance(s), and Caddy when one of them is public",
  "  stop [<instance>|all]       stop them; a proof that is running is allowed to finish",
  "  restart [<instance>|all]    stop, then start",
  "  status                      state of every instance and of Caddy",
  "  stats [options]             statistics from the logs",
  "  site <command> ...          the sites that may use the server: keys and daily quotas",
  "  caddyfile --domain <name>   generate deploy/Caddyfile for the public instances",
  "  help                        this text",
];

// One call per line, with the line only: out may be console.log, which would print the extra arguments of forEach.
function printHelp(out: Out): void {
  for (const line of HELP) out(line);
}

const COMMANDS: Record<string, Command> = {
  start: startCommand,
  stop: stopCommand,
  restart: restartCommand,
  status: statusCommand,
  setup: setupCommand,
  site: siteCommand,
  caddyfile: caddyfileCommand,
};

// Announced by help, written by the next task.
const PLANNED = ["stats"];

export async function main(argv: string[], layout: Layout = resolveLayout(), out: Out = console.log): Promise<number> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    out(`Node.js 22 or newer is required (this is ${process.versions.node}): see INSTALL.md`);
    return 1;
  }

  const [name, ...args] = argv;
  if (name === "help") {
    printHelp(out);
    return 0;
  }
  if (name !== undefined && Object.hasOwn(COMMANDS, name)) {
    try {
      return await COMMANDS[name](layout, args, out);
    } catch (err) {
      out(`${name}: ${(err as Error).message}`);
      return 1;
    }
  }
  if (name !== undefined && PLANNED.includes(name)) {
    out(`${name}: not available yet`);
    return 1;
  }
  if (name !== undefined) out(`Unknown command: ${name}`);
  printHelp(out);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

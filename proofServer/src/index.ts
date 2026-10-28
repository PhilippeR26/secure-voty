import fs from "fs";
import { instanceFiles, resolveLayout } from "./layout";
import { RunningServer, StartupError, startServer } from "./server";

// node dist/index.js <instance>: one instance of the proof server, started by ./proof-server.sh.
async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: node dist/index.js <instance>");
    process.exit(1);
  }
  const layout = resolveLayout();

  // A crash leaves the pid file in place, so that `status` reports the instance as crashed.
  process.on("uncaughtException", (err) => {
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error(err);
    process.exit(1);
  });

  let server: RunningServer;
  try {
    server = await startServer(layout, name);
  } catch (err) {
    console.error(err instanceof StartupError ? err.message : ((err as Error).stack ?? String(err)));
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    await server.stop();
    const { pidFile } = instanceFiles(layout, name);
    try {
      if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.rmSync(pidFile);
    } catch {
      // no pid file: started by hand
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main();

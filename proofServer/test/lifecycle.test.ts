import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { TestContext, afterEach } from "node:test";
import fs from "fs";
import path from "path";
import { caddyState } from "../src/cli/caddy";
import { instanceState, stopCommand, stopInstance } from "../src/cli/lifecycle";
import { main } from "../src/cli/main";
import { CHAIN_IDS, loadInstance } from "../src/instance";
import { instanceFiles, resolveLayout } from "../src/layout";
import { isGroupAlive, isPortFree, isProcessAlive, writePidFile } from "../src/proc";
import { FAKE_SNIP36 } from "./helpers/fake";
import { TestHome, freePort, makeHome, waitFor } from "./helpers/home";
import { pgrepF } from "./helpers/procs";
import { startFakeRpc } from "./helpers/rpc";
import { prove } from "./helpers/sse";

// The servers are started by `tsx` from the sources, and Caddy is a test double.
process.env.PROOF_SERVER_DEV = "1";
process.env.CADDY_BINARY = path.resolve(__dirname, "fake-caddy.sh");

const tx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));
const body = { blockNumber: 123, tx };

afterEach(() => {
  for (const key of ["FAKE_MODE", "FAKE_SLEEP", "FAKE_TRACE", "FAKE_TRACE_ARGS", "FAKE_LEAK"]) {
    delete process.env[key];
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

interface Rig {
  home: TestHome;
  lines: string[];
  out: (line: string) => void;
  text(): string; // what the commands printed since the last reset()
  reset(): void;
  url(name: string): string; // LAN URL of an instance
}

// A home with one instance file per entry, on free ports, with a fake node. Everything is stopped at the end.
async function rig(
  t: TestContext,
  instances: Array<{ name: string; chainId?: string; public?: boolean }>,
): Promise<Rig> {
  const home = await makeHome();
  fs.mkdirSync(home.layout.repoDir, { recursive: true }); // the fake prover runs there
  const rpcs = new Map<string, { url: string; close(): Promise<void> }>();
  const used = new Set<number>();
  const port = async (): Promise<number> => {
    let candidate = await freePort();
    while (used.has(candidate)) candidate = await freePort();
    used.add(candidate);
    return candidate;
  };

  for (const spec of instances) {
    const chainId = spec.chainId ?? CHAIN_IDS.sepolia;
    if (!rpcs.has(chainId)) rpcs.set(chainId, await startFakeRpc(chainId));
    home.writeInstance(spec.name, {
      NETWORK: "sepolia",
      STARKNET_RPC_URL: rpcs.get(chainId)!.url,
      LAN_PORT: await port(),
      PUBLIC_ENABLED: spec.public === true,
      ...(spec.public ? { PUBLIC_PORT: await port() } : {}),
      SNIP36_BINARY: FAKE_SNIP36,
    });
  }

  t.after(async () => {
    await stopCommand(home.layout, ["all"], () => {});
    for (const rpc of rpcs.values()) await rpc.close();
    home.cleanup();
  });
  const lines: string[] = [];
  return {
    home,
    lines,
    out: (line) => lines.push(line),
    text: () => lines.join("\n"),
    reset: () => void (lines.length = 0),
    url: (name) => `http://127.0.0.1:${loadInstance(home.layout, name).lanPort}`,
  };
}

const traceMarks = (file: string): string[] =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => /^(start|end) /.test(line))
    .map((line) => line.split(" ")[0]);

test("help and unknown commands", async () => {
  const layout = resolveLayout({ PROOF_SERVER_HOME: "/nonexistent" });
  const lines: string[] = [];
  assert.equal(await main(["help"], layout, (line) => lines.push(line)), 0);
  const help = lines.join("\n");
  for (const command of ["start", "stop", "restart", "status", "site", "stats", "caddyfile", "setup"]) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
  assert.equal(await main(["nope"], layout, () => {}), 1);
  assert.equal(await main([], layout, () => {}), 1);

  // out may be console.log: it must receive the line alone, not the index and the array of forEach
  const calls: unknown[][] = [];
  await main(["help"], layout, (...args: unknown[]) => void calls.push(args));
  assert.ok(calls.length > 5);
  assert.ok(calls.every((args) => args.length === 1 && typeof args[0] === "string"));
});

test("start, start again, restart, status, stop", async (t) => {
  const r = await rig(t, [{ name: "a" }]);
  const { layout } = r.home;

  assert.equal(await main(["start", "a"], layout, r.out), 0);
  assert.match(r.text(), /a: running/);
  const first = instanceState(layout, "a");
  assert.equal(first.state, "running");

  r.reset();
  assert.equal(await main(["start", "a"], layout, r.out), 1);
  assert.match(r.text(), /already running/);

  r.reset();
  assert.equal(await main(["restart", "a"], layout, r.out), 0);
  const second = instanceState(layout, "a");
  assert.equal(second.state, "running");
  assert.notEqual(second.pid, first.pid);

  r.reset();
  assert.equal(await main(["status"], layout, r.out), 0);
  assert.match(r.text(), /a/);
  assert.match(r.text(), /running/);

  r.reset();
  assert.equal(await main(["stop", "a"], layout, r.out), 0);
  assert.equal(instanceState(layout, "a").state, "stopped");
  assert.equal(fs.existsSync(instanceFiles(layout, "a").pidFile), false);
});

test("start reports a startup failure and status shows it", async (t) => {
  const r = await rig(t, [{ name: "a", chainId: CHAIN_IDS.mainnet }]); // a node of the other network
  const { layout } = r.home;

  assert.equal(await main(["start", "a"], layout, r.out), 1);
  assert.match(r.text(), /NETWORK=sepolia/);

  r.reset();
  assert.equal(await main(["status"], layout, r.out), 0);
  assert.match(r.text(), /crashed/);
  assert.match(r.text(), /NETWORK=sepolia/);
});

test("two instances share the machine slot", async (t) => {
  process.env.FAKE_SLEEP = "1";
  const r = await rig(t, [{ name: "a" }, { name: "b" }]);
  const trace = path.join(r.home.root, "trace.log");
  process.env.FAKE_TRACE = trace;

  assert.equal(await main(["start"], r.home.layout, r.out), 0);
  const [a, b] = await Promise.all([prove(r.url("a"), body), prove(r.url("b"), body)]);
  assert.equal(a.events.at(-1)?.event, "done");
  assert.equal(b.events.at(-1)?.event, "done");
  assert.deepEqual(traceMarks(trace), ["start", "end", "start", "end"]);
});

test("stop during a proof lets it finish and leaves no process", async (t) => {
  process.env.FAKE_SLEEP = "2";
  const r = await rig(t, [{ name: "a" }]);
  const { layout } = r.home;
  assert.equal(await main(["start", "a"], layout, r.out), 0);

  const started = deferred();
  const proof = prove(r.url("a"), body, { onEvent: (e) => e.event === "started" && started.resolve() });
  await started.promise;
  assert.equal(await main(["stop", "a"], layout, r.out), 0);

  assert.equal((await proof).events.at(-1)?.event, "done");
  assert.equal(instanceState(layout, "a").state, "stopped");
  assert.deepEqual(pgrepF(r.home.root), []);
  const stdout = fs.readFileSync(instanceFiles(layout, "a").stdoutFile, "utf8");
  assert.ok(!stdout.includes(tx.calldata[6]));
  assert.ok(!stdout.includes(tx.signature[0]));
});

test("orphan proof of a SIGKILLed server is killed on restart", async (t) => {
  process.env.FAKE_MODE = "hang";
  const r = await rig(t, [{ name: "a" }]);
  const { layout } = r.home;
  assert.equal(await main(["start", "a"], layout, r.out), 0);

  const started = deferred();
  const proof = prove(r.url("a"), body, { onEvent: (e) => e.event === "started" && started.resolve() }).catch(() => null);
  await started.promise;
  const slotFile = path.join(layout.slotsDir, "slot-0.json");
  await waitFor(() => fs.existsSync(slotFile));
  const { pgid } = JSON.parse(fs.readFileSync(slotFile, "utf8"));

  process.kill(instanceState(layout, "a").pid!, "SIGKILL");
  await waitFor(() => instanceState(layout, "a").state === "crashed");
  await proof; // the connection broke
  r.reset();
  await main(["status"], layout, r.out);
  assert.match(r.text(), /crashed/);
  assert.equal(isGroupAlive(pgid), true); // the proof is still there

  assert.equal(await main(["start", "a"], layout, r.out), 0);
  assert.equal(isGroupAlive(pgid), false);
  assert.equal(await isPortFree(layout.runnerBasePort), true);
});

test("Caddy follows the public instances", async (t) => {
  const r = await rig(t, [{ name: "p", public: true }]);
  const { layout } = r.home;

  assert.equal(await main(["start"], layout, r.out), 1); // no Caddyfile yet
  assert.match(r.text(), /caddyfile --domain/);
  assert.equal(instanceState(layout, "p").state, "running");

  fs.mkdirSync(path.dirname(layout.caddyfile), { recursive: true });
  fs.writeFileSync(layout.caddyfile, "# any content\n");
  r.reset();
  assert.equal(await main(["start"], layout, r.out), 0);
  assert.equal(caddyState(layout).state, "running");
  assert.match(r.text(), /caddy: running/);

  assert.equal(await main(["stop"], layout, r.out), 0);
  assert.equal(caddyState(layout).state, "stopped");
  assert.equal(instanceState(layout, "p").state, "stopped");
});

test("stop with nothing running", async (t) => {
  const r = await rig(t, [{ name: "a" }]);
  assert.equal(await main(["stop"], r.home.layout, r.out), 0);
  assert.match(r.text(), /not running/);
});

test("a pid file that points to another program is not trusted", async (t) => {
  const r = await rig(t, [{ name: "a" }]);
  const { layout } = r.home;
  const stranger = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => stranger.kill("SIGKILL"));
  const { pidFile } = instanceFiles(layout, "a");
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${stranger.pid}\n1\n`); // the pid of a live program, but not its start time

  assert.equal(instanceState(layout, "a").state, "crashed");
  assert.equal(await main(["stop", "a"], layout, r.out), 0);
  assert.match(r.text(), /was crashed/);
  assert.equal(isProcessAlive(stranger.pid!), true); // it was not signalled
  assert.equal(fs.existsSync(pidFile), false);
});

test("stop kills a server that ignores SIGTERM", async (t) => {
  const r = await rig(t, [{ name: "a" }]);
  const { layout } = r.home;
  const stubborn = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => stubborn.kill("SIGKILL"));
  await new Promise<void>((resolve) => stubborn.stdout!.once("data", () => resolve()));
  writePidFile(instanceFiles(layout, "a").pidFile, stubborn.pid!);
  assert.equal(instanceState(layout, "a").state, "running");

  await stopInstance(layout, "a", r.out, 300);
  assert.match(r.text(), /killed after/);
  assert.equal(isProcessAlive(stubborn.pid!), false);
  assert.equal(instanceState(layout, "a").state, "stopped");
});

test("start refuses what it cannot start and says why", async (t) => {
  const r = await rig(t, [{ name: "a" }]);
  const { layout } = r.home;

  assert.equal(await main(["start", "nope"], layout, r.out), 1);
  assert.match(r.text(), /unknown instance/);
  assert.match(r.text(), /\ba\b/); // the known instances are listed

  r.home.writeInstance("broken", { NETWORK: "goerli" });
  r.reset();
  assert.equal(await main(["start", "broken"], layout, r.out), 1);
  assert.match(r.text(), /NETWORK/);

  const empty = await makeHome();
  t.after(() => empty.cleanup());
  r.reset();
  assert.equal(await main(["start"], empty.layout, r.out), 1);
  assert.match(r.text(), /No instance/);
});

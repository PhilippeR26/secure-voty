# Internet-facing SNIP-36 Proof Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the proof server in `proofServer/` with an Internet-facing TypeScript server — per-site API keys and daily quotas, a queue with machine-wide slots, limits reloaded live, a bounded JSON Lines log with a stats command — started and stopped by hand with `./proof-server.sh`, behind Caddy for HTTPS.

**Architecture:** One Node process per network instance, each with a LAN listener (no key) and an optional public listener on 127.0.0.1 that only Caddy reaches (key + quota). Accepted requests wait in an in-memory queue; a job runs only while it holds a machine slot (exclusive TCP bind shared by every instance of the machine), as a `snip36 prove virtual-os` child in its own process group. A CLI behind `proof-server.sh` covers setup, start/stop/status, site keys, stats and the Caddyfile.

**Tech Stack:** Node.js ≥ 22, TypeScript 6 (strict, CommonJS, existing `proofServer/tsconfig.json`), Express 5, dotenv, `node:test` + tsx, bash, Caddy 2 (apt).

**Spec:** `docs/superpowers/specs/2026-10-28-proof-server-design.md` — read it entirely before Task 0. Where this plan is silent, the spec decides.

## Global Constraints

- Server code lives in `proofServer/`; run `npm` commands there unless a step says otherwise.
- Node.js ≥ 22 (`node --test` globs, `util.parseArgs`, global `fetch`); `package.json` declares `"engines": { "node": ">=22" }`.
- Runtime dependencies: `express` ^5.2.1, `dotenv` ^17.4.1, the `@starknet-io/starknet-types-0101` alias (types). No new runtime dependency. `starknet` is removed in Task 9.
- Keep `proofServer/tsconfig.json` as is (it compiles with TypeScript 6.0.2). Style of `proofServer/src`: 2-space indent, double quotes, semicolons.
- Tests: `node:test` + `node:assert/strict`, files `proofServer/test/**/*.test.ts`. All: `npm test` (= `node --import tsx --test --test-concurrency=1 "test/**/*.test.ts"`). One file: `node --import tsx --test test/<name>.test.ts`. Tests that set `FAKE_*` environment variables delete them in `afterEach`.
- English for code, comments, log events, CLI output and docs.
- Privacy invariant: transaction data (calldata, signature) and API keys never reach `logs/*.log`, `logs/*.stdout` or console output. In secure-voty the calldata holds the voter's secret.
- Days are UTC (`YYYY-MM-DD` of `toISOString()`); quotas reset at 00:00 UTC.
- No automatic launch: no systemd unit, no cron entry, no restart loop.
- Values pinned by the spec: `machineSlots` 1, `queueMax` 10, `perSiteQueueMax` 2, `maxWaitSec` 900, `proofTimeoutSec` 600, `maxBodyKB` 256, `badKey` {`maxFailures` 10, `windowMin` 10, `banMin` 60}, `LOG_MAX_MB` 5, `LOG_FILES` 3, SSE ping 15 s, config poll 5 s, shutdown grace 60 s, `stop` escalates to SIGKILL after 75 s, `calldata` ≤ 5 000 elements, wait-estimate window 10 proofs / 60 s initial.
- Ports (defaults): LAN listener 3030…, public listener 4030… (127.0.0.1), slot locks 9800 + k and runners 9900 + k (127.0.0.1), Caddy 8443 / 8080 / admin 2019. Only public 443 → 8443 is forwarded on the Freebox.
- Commit checkpoints: the owner commits from the VS Code Source Control panel, where committing with nothing staged sweeps every change, untracked files included. At each checkpoint stop, give the owner the message and the exact files to stage, and wait. Do not run `git commit` unless the owner asks. Messages follow the repo style (`feat: …`, `chore: …`, `test: …`, `docs: …`), with no attribution trailer of any kind.

## Review Focus

1. **Secrets in the log** — after a successful proof, a failed proof and a bad key, `logs/<inst>.log` holds no calldata, signature or key. Test `privacy: log holds no tx data or key` (Task 9); stdout file checked in `stop during a proof lets it finish and leaves no process` (Task 10).
2. **Client gone while waiting or proving** — dropped while queued: leaves the queue, not counted; dropped while running: proof group killed, counted. Tests `disconnect while queued: removed and not counted` and `disconnect while running: proof killed and counted` (Task 9).
3. **Server killed hard during a proof** (OOM killer, `stop` escalating to SIGKILL) — the orphan proof group is killed before its slot is reused. Test `orphan proof of a SIGKILLed server is killed on restart` (Task 10); real check in Task 14.
4. **Instance that cannot start** (port taken, node of the wrong network, broken `sites.json`) — `start` prints the reason and `status` shows `crashed` with it. Test `start reports a startup failure and status shows it` (Task 10).
5. **`localhost` resolving to ::1** — the DAPP default `http://localhost:3030` must work although the LAN listener is IPv4. Test `LAN listener answers on ::1` (Task 9).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/layout.ts` | directories and base ports of the machine | 1 |
| `src/instance.ts` | `instances/<inst>.env` loading and checks, network constants | 1 |
| `src/log.ts` | JSON Lines logger with size rotation | 2 |
| `src/keys.ts`, `src/config.ts` | key generation/hash; `sites.json` parse, write, live reload | 3 |
| `src/auth.ts`, `src/quota.ts` | key check, IP bans; UTC daily counters | 4 |
| `src/queue.ts` | queue with LAN priority, duration estimate | 5 |
| `src/proc.ts`, `src/slots.ts` | process/port helpers; machine slots, orphan cleanup | 6 |
| `src/prover.ts` | one `snip36` run | 7 |
| `src/service.ts` | admission, scheduling, job lifecycle | 8 |
| `src/validate.ts`, `src/sse.ts`, `src/rpc.ts`, `src/app.ts`, `src/server.ts`, `src/index.ts` | HTTP layer and server process | 9 |
| `src/cli/main.ts`, `src/cli/lifecycle.ts`, `src/cli/caddy.ts`, `proof-server.sh` | CLI, start/stop/status, Caddy process | 10 |
| `src/cli/site.ts`, `src/cli/setup.ts`, `src/cli/caddy.ts` (Caddyfile) | site keys, prover setup, Caddyfile | 11 |
| `src/cli/stats.ts` | statistics | 12 |
| `src/app/server/RequestProof.ts`, `scripts/src/RequestProof.ts` (repo root) | clients | 13 |
| `INSTALL.md`, `README.md`, root `CLAUDE.md` / `README.md` | docs | 15 |

---

### Task 0: Prepare the mini PC

**Files:** none in the repo. Keep `~/proof-server-install-notes.md` (outside the repo): every command run on this machine, what it printed, what failed and how it was fixed. Task 15 turns it into `proofServer/INSTALL.md`.

- [ ] **Step 1: Branch** — ask the owner whether to work on `main` or on a branch (suggest `proof-server-v2`).
- [ ] **Step 2: Check the machine** — `node --version` must print v22 or later (otherwise install Node.js 22 LTS or newer and note the exact method); `git --version`; `free -g` with the nodes running (note `available`: a proof peaks at ~2–3 GB); `df -h .` shows ≥ 15 GB free.
- [ ] **Step 3: Ask the owner** for the networks to serve, the JSON-RPC URL of each node, which instances will be public, and the mini PC's LAN IP.
- [ ] **Step 4: Prover prerequisites** — `git clone https://github.com/starknet-innovation/snip-36-prover-backend proofServer/snip-36-prover-backend`, then install what its `README.md` § Prerequisites requires for `snip36 setup` (Rust stable + the nightly it names, Python 3.12, `build-essential`).
- [ ] **Step 5: Build the prover with the current code**, in the background (~20 min, ~10 GB), and continue with Task 1 meanwhile:
  `cd proofServer && npm install && npm run build && node -e 'require("./dist/build").ensureBuilt()'`
- [ ] **Step 6: Verify** — `proofServer/snip-36-prover-backend/target/release/snip36 doctor` reports every check OK.

### Task 1: Layout, instance files and test scaffolding

**Files:**
- Create: `proofServer/src/layout.ts`, `proofServer/src/instance.ts`, `proofServer/instances/example.env`, `proofServer/test/helpers/home.ts`, `proofServer/test/fixtures/tx.json`, `proofServer/test/layout.test.ts`, `proofServer/test/instance.test.ts`
- Modify: `proofServer/package.json`, `proofServer/.gitignore`

**Interfaces — Produces:**

```ts
// src/layout.ts
export interface Layout {
  packageDir: string;        // where the code lives: path.resolve(__dirname, "..")
  root: string;              // data home: env PROOF_SERVER_HOME ?? packageDir
  instancesDir: string;      // <root>/instances
  sitesFile: string;         // <root>/config/sites.json
  stateDir: string;          // <root>/state
  slotsDir: string;          // <root>/state/slots
  logsDir: string;           // <root>/logs
  tmpDir: string;            // <root>/tmp
  caddyfile: string;         // <root>/deploy/Caddyfile
  repoDir: string;           // env SNIP36_REPO_DIR ?? <root>/snip-36-prover-backend
  slotLockBasePort: number;  // env SLOT_LOCK_BASE_PORT ?? 9800
  runnerBasePort: number;    // env RUNNER_BASE_PORT ?? 9900
}
export function resolveLayout(env?: NodeJS.ProcessEnv): Layout;      // default: process.env
export function layoutEnv(layout: Layout): Record<string, string>;   // PROOF_SERVER_HOME, SNIP36_REPO_DIR, SLOT_LOCK_BASE_PORT, RUNNER_BASE_PORT
export interface InstanceFiles { envFile: string; pidFile: string; usageFile: string; logFile: string; stdoutFile: string; workDir: string }
export function instanceFiles(layout: Layout, inst: string): InstanceFiles;

// src/instance.ts
export type Network = "mainnet" | "sepolia";
export const NETWORKS: readonly Network[];               // ["mainnet", "sepolia"]
export const CHAIN_NAMES: Record<Network, string>;       // { mainnet: "SN_MAIN", sepolia: "SN_SEPOLIA" }
export const CHAIN_IDS: Record<Network, string>;         // { mainnet: "0x534e5f4d41494e", sepolia: "0x534e5f5345504f4c4941" }
export interface InstanceConfig {
  name: string; network: Network; rpcUrl: string;
  lanPort: number; publicEnabled: boolean; publicPort: number | null;
  logMaxBytes: number; logFiles: number; snip36Binary: string;
}
export class InstanceError extends Error {}
export function loadInstance(layout: Layout, name: string): InstanceConfig;
export function listInstances(layout: Layout): string[];  // sorted basenames of instances/*.env, "example" excluded

// test/helpers/home.ts
export interface TestHome {
  root: string; layout: Layout; env: Record<string, string>;
  writeInstance(name: string, vars: Record<string, string | number | boolean>): void;
  writeSites(config: object): void;
  readLog(inst: string): Array<Record<string, unknown>>;
  cleanup(): void;
}
export function makeHome(): Promise<TestHome>;
export function freePort(): Promise<number>;
export function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs?: number, stepMs?: number): Promise<void>; // 5000 / 50; rejects "waitFor timed out"
```

- [ ] **Step 1: `package.json`** — `"version": "2.0.0"`, `"private": true`, `"engines": { "node": ">=22" }`, scripts exactly `"build": "rm -rf dist && tsc"`, `"typecheck": "tsc --noEmit"`, `"test": "node --import tsx --test --test-concurrency=1 \"test/**/*.test.ts\""`. The old `start` and `dev` scripts go (they start the old single server). Dependencies unchanged for now.
- [ ] **Step 2: `.gitignore`** — append:

```
# proof server v2: machine-specific files
instances/*.env
!instances/example.env
config/sites.json
state/
logs/
deploy/Caddyfile
```

- [ ] **Step 3: Fixture** — `test/fixtures/tx.json` = the JSON transaction of `proofServer/README.md` § "Example of transaction" (still the old README), verbatim. Check: `calldata[6]` is `0x46834de20fe71e56d6cda4502646f55e85e3ec51057913e5774c69bbe184483` and `signature[0]` is `0x784ee0ec157e7a28ad43138377787489274513c70f4f6f00934faa7787c5612`; Task 9 searches the log for both.
- [ ] **Step 4: Helpers** — `test/helpers/home.ts` per the interface: temp dir with prefix `proof-home-`; `env` = `PROOF_SERVER_HOME` + two `freePort()` values for the base ports; `layout = resolveLayout(env)`; `writeInstance` writes `KEY=value` lines; `writeSites` writes JSON to `layout.sitesFile` (creates `config/`); `readLog` parses the lines of `logs/<inst>.log` (missing file → `[]`).
- [ ] **Step 5: Write the failing tests**

```ts
// test/layout.test.ts
test("defaults: data home is the package dir, ports 9800/9900", () => {
  const l = resolveLayout({});
  assert.equal(path.basename(l.packageDir), "proofServer");
  assert.equal(l.root, l.packageDir);
  assert.equal(l.sitesFile, path.join(l.root, "config", "sites.json"));
  assert.equal(l.caddyfile, path.join(l.root, "deploy", "Caddyfile"));
  assert.equal(l.repoDir, path.join(l.root, "snip-36-prover-backend"));
  assert.equal(l.slotLockBasePort, 9800);
  assert.equal(l.runnerBasePort, 9900);
});
test("env overrides; layoutEnv recreates the same layout", () => {
  const l = resolveLayout({ PROOF_SERVER_HOME: "/tmp/h", SNIP36_REPO_DIR: "/opt/p", SLOT_LOCK_BASE_PORT: "21000", RUNNER_BASE_PORT: "22000" });
  assert.equal(l.logsDir, "/tmp/h/logs");
  assert.equal(l.repoDir, "/opt/p");
  assert.deepEqual(resolveLayout(layoutEnv(l)), l);
});
test("instanceFiles", () => {
  assert.deepEqual(instanceFiles(resolveLayout({ PROOF_SERVER_HOME: "/h" }), "sepolia"), {
    envFile: "/h/instances/sepolia.env", pidFile: "/h/state/sepolia.pid", usageFile: "/h/state/sepolia/usage.json",
    logFile: "/h/logs/sepolia.log", stdoutFile: "/h/logs/sepolia.stdout", workDir: "/h/tmp/sepolia",
  });
});

// test/instance.test.ts — each test: const h = await makeHome(); t.after(() => h.cleanup());
const full = { NETWORK: "sepolia", STARKNET_RPC_URL: "http://127.0.0.1:9545/rpc/v0_9", LAN_PORT: 3030, PUBLIC_ENABLED: true, PUBLIC_PORT: 4030 };
test("loads a complete instance file", ...)  // writeInstance("sepolia", full) →
  // deepEqual { name: "sepolia", network: "sepolia", rpcUrl: full.STARKNET_RPC_URL, lanPort: 3030, publicEnabled: true,
  //   publicPort: 4030, logMaxBytes: 5 * 1024 * 1024, logFiles: 3, snip36Binary: path.join(h.layout.repoDir, "target/release/snip36") }
test("PUBLIC_ENABLED defaults to false; publicPort is then null", ...)
test("bad files name the variable", ...)  // each case: assert.throws(() => loadInstance(h.layout, "x"), e => e instanceof InstanceError && re.test(e.message))
  //   NETWORK=goerli → /NETWORK/; STARKNET_RPC_URL missing → /STARKNET_RPC_URL/; STARKNET_RPC_URL=localhost:9545 → /STARKNET_RPC_URL/;
  //   LAN_PORT=0 → /LAN_PORT/; PUBLIC_ENABLED=true without PUBLIC_PORT → /PUBLIC_PORT/; PUBLIC_PORT=LAN_PORT → /PUBLIC_PORT/
test("missing file says how to create it", ...)    // loadInstance(h.layout, "nope") → /instances\/nope\.env/ and /example\.env/
test("instance names must be URL-safe", ...)        // "Sepolia_1" → InstanceError /name/
test("listInstances skips example.env", ...)        // example, sepolia, mainnet written → ["mainnet", "sepolia"]
test("the committed example.env is valid", ...)     // loadInstance(resolveLayout({}), "example").network === "sepolia"
test("CHAIN_IDS are the hex short strings of CHAIN_NAMES", ...)
  // for each n of NETWORKS: CHAIN_IDS[n] === "0x" + Buffer.from(CHAIN_NAMES[n]).toString("hex")
```

- [ ] **Step 6: Run** `npm test` — expected FAIL: `Cannot find module '../src/layout'`.
- [ ] **Step 7: Implement `src/layout.ts` and `src/instance.ts`.** Parse with `dotenv.parse` (never touch `process.env`). Name `/^[a-z0-9][a-z0-9-]*$/`; ports integers 1–65535, `PUBLIC_PORT` ≠ `LAN_PORT`; `PUBLIC_ENABLED` `true`|`false` (default false; when false `publicPort` is null); `STARKNET_RPC_URL` starts with `http://` or `https://`; `LOG_MAX_MB` positive number (default 5) → bytes; `LOG_FILES` integer ≥ 1 (default 3); `SNIP36_BINARY` default `<repoDir>/target/release/snip36`. Messages name file and variable, e.g. `instances/sepolia.env: LAN_PORT must be an integer between 1 and 65535`; missing file: `instances/<name>.env not found — copy instances/example.env to instances/<name>.env`.
- [ ] **Step 8: Create `instances/example.env`:**

```
# Copy this file to instances/<name>.env, e.g. instances/sepolia.env.
# <name> (lowercase letters, digits, dashes) is the instance name; behind Caddy it is the URL prefix /<name>/.

# Network proven by this instance: mainnet or sepolia. It must match the node below.
NETWORK=sepolia
# JSON-RPC URL of a Pathfinder node (>= 0.22.2) of that network — the URL of your old proofServer/.env.
STARKNET_RPC_URL=http://127.0.0.1:9545/rpc/v0_9

# LAN listener: no key, no quota. Never forward this port on the Freebox.
LAN_PORT=3030

# Public listener, bound to 127.0.0.1 and reached only through Caddy: key and quota required.
PUBLIC_ENABLED=false
PUBLIC_PORT=4030

# Optional
# LOG_MAX_MB=5
# LOG_FILES=3
# SNIP36_BINARY=/path/to/snip36
```

- [ ] **Step 9: Run** `npm test` → PASS; `npm run typecheck` → exit 0.
- [ ] **Step 10: Commit checkpoint** — `chore(proofServer): add layout, instance files and test scaffolding`; stage `proofServer/package.json`, `proofServer/.gitignore`, `proofServer/src/layout.ts`, `proofServer/src/instance.ts`, `proofServer/instances/example.env`, `proofServer/test/`.

### Task 2: JSON Lines log with rotation

**Files:** Create `proofServer/src/log.ts`, `proofServer/test/log.test.ts`

**Interfaces — Produces:**

```ts
export const LOG_EVENTS: readonly ["request", "reject", "queued", "start", "done", "fail", "abort", "timeout", "ban", "config_reload", "config_error", "startup", "shutdown"];
export type LogEvent = (typeof LOG_EVENTS)[number];
export interface LogRecord { ts: string; inst: string; ev: LogEvent; reqId?: string; site?: string; ip?: string; reason?: string; waitMs?: number; durMs?: number; queueLen?: number; msg?: string }
export type LogFields = Omit<LogRecord, "ts" | "inst" | "ev">;
export class JsonlLogger {
  constructor(opts: { file: string; inst: string; maxBytes: number; maxFiles: number; now?: () => Date });
  write(ev: LogEvent, fields?: LogFields): void;
}
export function logFileSet(file: string, maxFiles: number): string[];  // existing files, oldest first: file.N … file.1, file
```

- [ ] **Step 1: Write the failing tests** (`file` = a path in a temp dir, `at = () => new Date("2026-10-28T10:00:00.000Z")`)

```ts
test("one JSON object per line, ts/inst/ev first", () => {
  const log = new JsonlLogger({ file, inst: "sepolia", maxBytes: 1e6, maxFiles: 3, now: at });
  log.write("request", { reqId: "r1", site: "voty", ip: "1.2.3.4" });
  assert.equal(fs.readFileSync(file, "utf8"),
    '{"ts":"2026-10-28T10:00:00.000Z","inst":"sepolia","ev":"request","reqId":"r1","site":"voty","ip":"1.2.3.4"}\n');
});
test("fields outside LogRecord are dropped", () => {
  log.write("done", { reqId: "r", tx: { calldata: ["0xdead"] } } as never);
  assert.ok(!fs.readFileSync(file, "utf8").includes("0xdead"));
});
test("rotation keeps maxFiles old files of at most maxBytes", () => {
  const log = new JsonlLogger({ file, inst: "i", maxBytes: 300, maxFiles: 2, now: at });
  for (let i = 0; i < 40; i++) log.write("request", { reqId: `r${i}`.padEnd(40, "x") });
  assert.deepEqual(logFileSet(file, 2), [`${file}.2`, `${file}.1`, file]);
  assert.ok(!fs.existsSync(`${file}.3`));
  for (const f of logFileSet(file, 2)) assert.ok(fs.statSync(f).size <= 300);
  assert.match(fs.readFileSync(file, "utf8"), /r39x/);
});
test("creates the log directory", ...)   // file under a directory that does not exist yet
```

- [ ] **Step 2: Run** `node --import tsx --test test/log.test.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement `src/log.ts`.** Keys copied in the fixed order `reqId, site, ip, reason, waitMs, durMs, queueLen, msg` (undefined skipped, anything else ignored). `fs.appendFileSync`; size tracked from `statSync` at construction. Before appending, if `size > 0 && size + lineBytes > maxBytes`: delete `file.<maxFiles>`, rename `file.k` → `file.k+1` from k = maxFiles−1 down to 1, rename `file` → `file.1`. `write` never throws: on error, print `log write failed: <message>` to stderr.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit checkpoint** — `feat(proofServer): add rotating JSON Lines log`; stage `proofServer/src/log.ts`, `proofServer/test/log.test.ts`.

### Task 3: Site keys and the live sites config

**Files:** Create `proofServer/src/keys.ts`, `proofServer/src/config.ts`, `proofServer/config/sites.example.json`, `proofServer/test/keys.test.ts`, `proofServer/test/config.test.ts`

**Interfaces — Consumes:** `Network`, `NETWORKS` (Task 1). **Produces:**

```ts
// src/keys.ts
export function generateKey(): string;          // crypto.randomBytes(32).toString("base64url") — 43 characters
export function hashKey(key: string): string;   // SHA-256 of the UTF-8 key, lowercase hex
// src/config.ts
export interface Limits { machineSlots: number; queueMax: number; perSiteQueueMax: number; maxWaitSec: number; proofTimeoutSec: number; maxBodyKB: number; badKey: { maxFailures: number; windowMin: number; banMin: number } }
export interface Site { keySha256: string; enabled: boolean; perDay: Partial<Record<Network, number>>; note?: string }
export interface SitesConfig { limits: Limits; sites: Record<string, Site> }
export const DEFAULT_LIMITS: Limits;
export function emptyConfig(): SitesConfig;     // { limits: copy of DEFAULT_LIMITS, sites: {} }
export function parseSitesConfig(text: string): { ok: true; config: SitesConfig } | { ok: false; error: string };
export function readSitesFile(file: string): SitesConfig;                // missing → emptyConfig(); invalid → throws Error("<file>: <error>")
export function writeSitesFile(file: string, config: SitesConfig): void; // 2-space JSON + "\n", tmp file + rename, creates the directory
export function siteAllowed(config: SitesConfig, site: string, network: Network): boolean; // exists, enabled, perDay[network] defined
export class ConfigStore extends EventEmitter {  // events: "reload" (config: SitesConfig), "error" (message: string)
  constructor(file: string, opts?: { pollMs?: number; debounceMs?: number });  // 5000, 200
  start(): SitesConfig;  // creates the directory, first read (throws like readSitesFile), fs.watch on the directory, unref'd poll timer
  get(): SitesConfig;
  reloadNow(): void;     // synchronous re-read with the same rules
  stop(): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/keys.test.ts
test("hashKey matches the SHA-256 reference value", () =>   // FIPS 180-2, appendix B.1: SHA-256("abc")
  assert.equal(hashKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
test("generateKey: 43 base64url characters, never twice the same", () => {
  const a = generateKey(), b = generateKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
});

// test/config.test.ts
test("defaults", () => {
  assert.deepEqual(DEFAULT_LIMITS, { machineSlots: 1, queueMax: 10, perSiteQueueMax: 2, maxWaitSec: 900, proofTimeoutSec: 600, maxBodyKB: 256, badKey: { maxFailures: 10, windowMin: 10, banMin: 60 } });
  const r = parseSitesConfig("{}"); assert.ok(r.ok); assert.deepEqual(r.config, emptyConfig());
});
test("partial limits are merged; enabled defaults to true", ...)
  // '{"limits":{"queueMax":3},"sites":{"voty":{"keySha256":"<64 hex>","perDay":{"sepolia":5}}}}'
  // → limits.queueMax 3, limits.maxWaitSec 900, sites.voty.enabled true
test("invalid configs name the faulty path", ...)   // each → ok false and error matches:
  // "{ bad" → /JSON/i; keySha256 "xyz" → /keySha256/; perDay {goerli: 1} → /goerli/; perDay {sepolia: -1} → /sepolia/;
  // two sites with one keySha256 → /same key/; machineSlots 0 → /machineSlots/; a site named "lan" → /reserved/
test("the committed sites.example.json is valid", ...)   // parseSitesConfig(read config/sites.example.json).ok === true
test("write then read round-trips; a missing file reads as emptyConfig()", ...)
test("siteAllowed", ...)   // allowed → true; disabled → false; network absent → false; unknown site → false
test("reload on change", async (t) => {
  writeSitesFile(file, emptyConfig());
  const store = new ConfigStore(file); store.start(); t.after(() => store.stop());
  const reloaded = once(store, "reload");
  const next = emptyConfig(); next.limits.queueMax = 3; writeSitesFile(file, next);
  const [cfg] = await reloaded;
  assert.equal(cfg.limits.queueMax, 3); assert.equal(store.get().limits.queueMax, 3);
});
test("an invalid file keeps the previous config", ...)   // write "{ bad" → "error" event matching /sites\.json/; get().limits.queueMax still 10
test("editor-style save (truncate, then write) ends on the new config", async () => {
  fs.writeFileSync(file, ""); await setTimeout(20);
  fs.writeFileSync(file, JSON.stringify({ limits: { queueMax: 7 } }));
  await waitFor(() => store.get().limits.queueMax === 7, 3000);
});
test("reloadNow applies a change synchronously", ...)
```

- [ ] **Step 2: Run** both files — expected FAIL (modules missing).
- [ ] **Step 3: Implement.** Validation: top level object; `limits` optional, each field optional and merged over `DEFAULT_LIMITS`; integers with `machineSlots` 1–8, `queueMax` ≥ 0, `perSiteQueueMax` ≥ 1, `maxWaitSec` ≥ 1, `proofTimeoutSec` ≥ 1, `maxBodyKB` 1–10240, each `badKey` field ≥ 1; `sites` optional; site name `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` and not `lan` (reserved for LAN requests in the log); `keySha256` `/^[0-9a-f]{64}$/`; `enabled` boolean (default true); `perDay` keys in `NETWORKS`, values integers ≥ 0; `note` string; duplicate `keySha256` → error. Errors name the path, e.g. `sites.voty.perDay.goerli: unknown network`. ConfigStore: a watch event (filename `sites.json` or null) is debounced; the poll compares the file text; the state is "text" or "missing"; unchanged state → nothing; valid → replace + `reload`; invalid or missing → keep the previous config + `error` with `<file>: <reason>`.
- [ ] **Step 4: Create `config/sites.example.json`:**

```json
{
  "limits": {
    "machineSlots": 1, "queueMax": 10, "perSiteQueueMax": 2,
    "maxWaitSec": 900, "proofTimeoutSec": 600, "maxBodyKB": 256,
    "badKey": { "maxFailures": 10, "windowMin": 10, "banMin": 60 }
  },
  "sites": {
    "example-site": {
      "keySha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "enabled": false,
      "perDay": { "sepolia": 10 },
      "note": "Placeholder. Create real sites with: ./proof-server.sh site add <name> --sepolia 100"
    }
  }
}
```

- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit checkpoint** — `feat(proofServer): add site keys and live sites config`; stage the five files.

### Task 4: Authentication, IP bans and daily quotas

**Files:** Create `proofServer/src/auth.ts`, `proofServer/src/quota.ts`, `proofServer/test/auth.test.ts`, `proofServer/test/quota.test.ts`

**Interfaces — Consumes:** `hashKey` (Task 3), `SitesConfig`, `Limits` (Task 3), `Network` (Task 1). **Produces:**

```ts
// src/auth.ts
export type AuthFailure = "missing_key" | "unknown_key" | "site_disabled" | "network_not_allowed";
export type AuthResult = { ok: true; site: string } | { ok: false; status: 401 | 403; reason: AuthFailure };
export function authenticate(authorization: string | undefined, network: Network, config: SitesConfig): AuthResult;
export class BanList {
  constructor(now?: () => number);
  isBanned(ip: string): boolean;
  recordFailure(ip: string, rule: Limits["badKey"]): boolean;  // true when this failure starts a ban
}
// src/quota.ts
export function utcDay(d: Date): string;
export function secondsUntilUtcMidnight(d: Date): number;      // Math.ceil, ≥ 1
export class QuotaStore {
  constructor(file: string, now?: () => Date);
  used(site: string): number;      // proofs launched today (UTC)
  increment(site: string): void;   // +1, persisted atomically as {"day":"YYYY-MM-DD","used":{"<site>":n}}
  snapshot(): { day: string; used: Record<string, number> };
}
```

- [ ] **Step 1: Write the failing tests** (config: `voty` = `{ keySha256: hashKey("K"), enabled: true, perDay: { sepolia: 2 } }`)

```ts
test("authenticate", () => {
  assert.deepEqual(authenticate(undefined, "sepolia", cfg), { ok: false, status: 401, reason: "missing_key" });
  assert.deepEqual(authenticate("Basic K", "sepolia", cfg), { ok: false, status: 401, reason: "missing_key" });
  assert.deepEqual(authenticate("Bearer ", "sepolia", cfg), { ok: false, status: 401, reason: "missing_key" });
  assert.deepEqual(authenticate("bearer K", "sepolia", cfg), { ok: true, site: "voty" });
  assert.deepEqual(authenticate("Bearer nope", "sepolia", cfg), { ok: false, status: 401, reason: "unknown_key" });
  assert.deepEqual(authenticate("Bearer K", "mainnet", cfg), { ok: false, status: 403, reason: "network_not_allowed" });
  // voty disabled → { ok: false, status: 403, reason: "site_disabled" }; perDay { sepolia: 0 } → ok (the quota rejects later)
});
test("BanList: 10 failures within 10 min ban for 60 min", ...)
  // clock at 0: 9× recordFailure → false and not banned; 10th → true, isBanned true; clock 60 min + 1 ms → isBanned false
test("BanList: failures spread beyond the window never ban", ...)   // 10 failures 2 min apart → isBanned false at the end
test("utcDay and secondsUntilUtcMidnight", () => {
  assert.equal(utcDay(new Date("2026-10-28T23:59:59Z")), "2026-10-28");
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-28T23:00:00Z")), 3600);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-28T23:59:59.500Z")), 1);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-29T00:00:00Z")), 86400);
});
test("QuotaStore counts per site and persists", ...)   // 2× increment("voty") → used("voty") 2, used("x") 0; a new QuotaStore on the file → 2
test("QuotaStore resets at 00:00 UTC", ...)            // clock 23:59:59Z then 2026-10-29T00:00:00Z → used 0, snapshot().day "2026-10-29"
test("a file from an older day reads as zero", ...)     // file {"day":"2026-10-27","used":{"voty":5}} read on 2026-10-28 → 0
```

- [ ] **Step 2: Run** both files — expected FAIL.
- [ ] **Step 3: Implement.** `Bearer` scheme case-insensitive, key trimmed, empty → `missing_key`. Failures per IP kept only within the last `windowMin`; reaching `maxFailures` bans until `failureTime + banMin` and clears the list. QuotaStore keeps the day it holds; a day change (on any call) resets the counters.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit checkpoint** — `feat(proofServer): add key auth, IP bans and UTC daily quotas`; stage the four files.

### Task 5: Queue and wait estimate

**Files:** Create `proofServer/src/queue.ts`, `proofServer/test/queue.test.ts`

**Interfaces — Produces:**

```ts
export interface Queued { reqId: string; site: string; lan: boolean }
export class ProofQueue<T extends Queued> {
  enqueue(item: T): void;            // LAN items after the last LAN item, external items at the end
  shift(): T | undefined;
  remove(reqId: string): T | undefined;
  removeWhere(pred: (item: T) => boolean): T[];
  position(reqId: string): number;   // 1-based run order, 0 if absent
  size(): number;
  countBySite(site: string): number;
  items(): readonly T[];             // run order
}
export class DurationEstimator {
  constructor(windowSize?: number, initialMs?: number);   // 10, 60_000
  add(ms: number): void;
  averageMs(): number;               // mean of the last windowSize values; initialMs when empty
}
export function estimateWaitSec(jobsAhead: number, averageMs: number): number;  // Math.ceil(jobsAhead * averageMs / 1000)
```

- [ ] **Step 1: Write the failing tests**

```ts
test("LAN jobs go before external ones, in arrival order", () => {
  // enqueue ext a, ext b, lan c, lan d, ext e
  assert.deepEqual(q.items().map(i => i.reqId), ["c", "d", "a", "b", "e"]);
  assert.equal(q.position("a"), 3); assert.equal(q.position("zz"), 0);
  assert.equal(q.shift()!.reqId, "c"); assert.equal(q.remove("b")!.reqId, "b"); assert.equal(q.size(), 3);
});
test("countBySite and removeWhere", ...)
test("DurationEstimator: initial value, then a sliding window of 10", () => {
  const e = new DurationEstimator(); assert.equal(e.averageMs(), 60000);
  for (let i = 1; i <= 10; i++) e.add(i * 1000); assert.equal(e.averageMs(), 5500);
  e.add(20000); assert.equal(e.averageMs(), 7400);
});
test("estimateWaitSec", () => {
  assert.equal(estimateWaitSec(0, 44000), 0); assert.equal(estimateWaitSec(3, 44000), 132); assert.equal(estimateWaitSec(1, 1500), 2);
});
```

- [ ] **Step 2: Run** — expected FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit checkpoint** — `feat(proofServer): add proof queue with LAN priority`; stage the two files.

### Task 6: Process helpers and machine slots

**Files:** Create `proofServer/src/proc.ts`, `proofServer/src/slots.ts`, `proofServer/test/slots.test.ts`, `proofServer/test/helpers/hold-slot.ts`, `proofServer/test/helpers/procs.ts`

**Interfaces — Consumes:** `Layout` (Task 1). **Produces:**

```ts
// src/proc.ts
export function isProcessAlive(pid: number): boolean;   // process.kill(pid, 0); EPERM counts as alive
export function isGroupAlive(pgid: number): boolean;    // process.kill(-pgid, 0)
export function killGroup(pgid: number, signal: NodeJS.Signals): void;  // process.kill(-pgid, signal); ESRCH ignored
export function isPortFree(port: number, host?: string): Promise<boolean>;  // tries to listen; host default "127.0.0.1"
export function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs?: number): Promise<boolean>; // step 100; false on timeout
// src/slots.ts
export interface SlotInfo { ownerPid: number; inst: string; pgid: number; since: string }
export interface SlotLock {
  readonly index: number;
  readonly runnerPort: number;                 // layout.runnerBasePort + index
  recordProof(pgid: number, inst: string): void;  // writes <slotsDir>/slot-<index>.json (ownerPid = process.pid)
  release(): Promise<void>;                    // deletes that file, closes the lock socket
}
export function tryAcquireSlot(layout: Layout, machineSlots: number): Promise<SlotLock | null>;
export function killOrphanProofs(layout: Layout): Promise<number>;
// test/helpers/procs.ts
export function pgrepF(pattern: string): number[];   // pids from `pgrep -f`, [] when none
```

- [ ] **Step 1: Write the failing tests**

```ts
test("one slot: busy until released", async () => {
  const a = await tryAcquireSlot(l, 1);
  assert.equal(a!.index, 0); assert.equal(a!.runnerPort, l.runnerBasePort);
  assert.equal(await tryAcquireSlot(l, 1), null);
  await a!.release(); assert.equal((await tryAcquireSlot(l, 1))!.index, 0);
});
test("two slots give indexes 0 and 1", ...)   // second lock: index 1, runnerPort runnerBasePort + 1
test("the kernel frees a slot when its holder dies", ...)
  // spawn `node --import tsx test/helpers/hold-slot.ts` with env layoutEnv(l); wait for "held" on its stdout;
  // tryAcquireSlot(l, 1) → null; SIGKILL the child; waitUntil(acquire succeeds, 3000) → true
test("taking a slot kills the orphan proof recorded for it", ...)
  // deadPid = pid of a process that already exited; orphan = spawn("sleep", ["60"], { detached: true });
  // write slot-0.json { ownerPid: deadPid, inst: "x", pgid: orphan.pid, since };
  // tryAcquireSlot(l, 1) → isGroupAlive(orphan.pid) false, slot-0.json gone
test("killOrphanProofs kills dead owners' groups only", ...)
  // slot-0.json with a dead owner and a live group → returns 1, group dead, file gone;
  // slot-1.json with ownerPid = process.pid → untouched
test("proc helpers", ...)   // killGroup on a dead group does not throw; isPortFree true, then false while a server listens
```

`test/helpers/hold-slot.ts`: `tryAcquireSlot(resolveLayout(), 1)`, print `held` or `busy`, then stay alive (`setInterval(() => {}, 1000)`).

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** Slot k is a `net.Server` listening on `127.0.0.1:(slotLockBasePort + k)`, `unref()`'d; `EADDRINUSE` → try k + 1; other listen errors are thrown. Right after acquiring slot k: if `slot-<k>.json` exists, its owner is gone — kill its group with SIGKILL when alive, `waitUntil(isPortFree(runner port), 5000)`, delete the file. `killOrphanProofs` does the same for every `slot-*.json` whose `ownerPid` is dead and returns the number of groups it killed.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit checkpoint** — `feat(proofServer): add machine slots and orphan proof cleanup`; stage the five files.

### Task 7: Running one proof

**Files:** Create `proofServer/src/prover.ts`, `proofServer/test/fake-snip36.sh` (executable: `chmod +x`), `proofServer/test/helpers/fake.ts`, `proofServer/test/prover.test.ts`. `test/helpers/fake.ts` exports `FAKE_SNIP36` (absolute path of `test/fake-snip36.sh`) and `FAKE_OUT` (below); Tasks 9, 10 and 13 use both.

**Interfaces — Consumes:** `Network`, `CHAIN_NAMES` (Task 1); `killGroup`, `isGroupAlive` (Task 6). **Produces:**

```ts
export interface L2ToL1Message { from_address: string; to_address: string; payload: string[] }
export interface ProofOutput { proof: string; proofFacts: string[]; l2ToL1Messages?: L2ToL1Message[] }
export type KillReason = "timeout" | "abort" | "shutdown";
export type ProverResult =
  | { kind: "done"; output: ProofOutput; durMs: number }
  | { kind: "fail"; exitCode: number | null; signal: string | null; reason: string; stderrTail: string; durMs: number }
  | { kind: "killed"; reason: KillReason; durMs: number };
export interface ProofSpec {
  binary: string; repoDir: string; workDir: string; jobId: string;
  network: Network; rpcUrl: string; blockNumber: number; tx: unknown;
  runnerPort: number; timeoutMs: number;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}
export interface ProofRun { readonly pgid: number | null; readonly result: Promise<ProverResult>; kill(reason: KillReason): void }
export function startProof(spec: ProofSpec): ProofRun;
export function sanitizeReason(stderrTail: string): string;
export const KILL_GRACE_MS = 5000;
```

- [ ] **Step 1: Create the fake prover** `test/fake-snip36.sh`:

```bash
#!/usr/bin/env bash
# Test double for `snip36 prove virtual-os`. Behaviour from the environment:
#   FAKE_MODE  ok (default) | fail | hang     FAKE_SLEEP seconds before finishing (default 0.2)
#   FAKE_TRACE file receiving "start <ms> port=<p>", "env …" and "end <ms>" lines
set -u
out="" port="" tx=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --tx-json) tx="$2"; shift 2 ;;
    *) shift ;;
  esac
done
trace() { [[ -n "${FAKE_TRACE:-}" ]] && echo "$*" >> "$FAKE_TRACE"; return 0; }
trace "start $(date +%s%3N) port=$port"
trace "env chain=${STARKNET_CHAIN_ID:-} account=${STARKNET_ACCOUNT_ADDRESS:-} project=${SNIP36_PROJECT_DIR:-} txmode=$(stat -c %a "$tx") cwd=$PWD"
echo "Running virtual OS..."
echo "progress: step 1/2" >&2
case "${FAKE_MODE:-ok}" in
  fail)
    echo "Error: Transaction execution failed: Vote is not open" >&2
    trace "end $(date +%s%3N)"
    exit 3 ;;
  hang)
    node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$port" fake-runner &
    sleep 3600 ;;
esac
sleep "${FAKE_SLEEP:-0.2}"
base="${out%.proof}"
printf 'FAKEPROOF' > "$base.proof"
printf '["0x1","0x2"]' > "$base.proof_facts"
printf '{"l2_to_l1_messages":[{"from_address":"0xa","to_address":"0xb","payload":["0x1"]}]}' > "$base.raw_messages.json"
trace "end $(date +%s%3N)"
exit 0
```

- [ ] **Step 2: Write the failing tests** (`spec` = binary `test/fake-snip36.sh` resolved to an absolute path, temp `workDir` and `repoDir`, `runnerPort = await freePort()`, `timeoutMs` 10000, tx = fixture)

```ts
// test/helpers/fake.ts
export const FAKE_SNIP36 = path.resolve(__dirname, "../fake-snip36.sh");
export const FAKE_OUT: ProofOutput = { proof: "FAKEPROOF", proofFacts: ["0x1", "0x2"], l2ToL1Messages: [{ from_address: "0xa", to_address: "0xb", payload: ["0x1"] }] };
// test/prover.test.ts
test("ok: returns the outputs and deletes the job files", ...)
  // result { kind: "done", output: FAKE_OUT }; fs.readdirSync(workDir) is []; onLine got ("stdout", "Running virtual OS...") and ("stderr", "progress: step 1/2")
test("passes port, chain, dummy account and project dir; the tx file is private", ...)
  // network "mainnet", FAKE_TRACE set → trace has `port=<runnerPort>` and
  // `env chain=SN_MAIN account=0x1 project=<repoDir> txmode=600 cwd=<repoDir>`
test("fail: a non-zero exit gives a sanitized reason", ...)
  // FAKE_MODE=fail → kind "fail", exitCode 3, reason "Error: Transaction execution failed: Vote is not open", stderrTail includes "progress: step 1/2"
test("timeout kills the whole group and frees the runner port", ...)
  // FAKE_MODE=hang, timeoutMs 1500; waitFor(port busy, 3000) → result { kind: "killed", reason: "timeout" };
  // isGroupAlive(run.pgid!) false; await isPortFree(runnerPort) true; pgrepF(`${runnerPort} fake-runner`) is []
test("kill('abort') stops a running proof", ...)   // FAKE_SLEEP=30, kill after 300 ms → { kind: "killed", reason: "abort" }, durMs < 10000
test("a missing binary fails cleanly", ...)        // binary "/nonexistent/snip36" → kind "fail", run.pgid null, reason /ENOENT/
test("sanitizeReason", () => {
  assert.equal(sanitizeReason("\x1b[31mError\x1b[0m at /home/u/proofServer/x.rs:12: Vote is not open\n\n"), "Error at <path>:12: Vote is not open");
  assert.equal(sanitizeReason("x".repeat(400)).length, 300);
  assert.equal(sanitizeReason(""), "");
});
```

- [ ] **Step 3: Run** — expected FAIL.
- [ ] **Step 4: Implement `startProof`.**
  - tx written to `<workDir>/<jobId>.tx.json` with mode `0o600`; output base `<workDir>/<jobId>`.
  - Command: `<binary> prove virtual-os --block-number <n> --tx-json <txFile> --rpc-url <rpcUrl> --output <base>.proof --port <runnerPort>`; `spawn` options `{ cwd: repoDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STARKNET_RPC_URL: rpcUrl, STARKNET_CHAIN_ID: CHAIN_NAMES[network], STARKNET_ACCOUNT_ADDRESS: "0x1", STARKNET_PRIVATE_KEY: "0x1", SNIP36_PROJECT_DIR: repoDir } }`; `pgid = child.pid ?? null`.
  - Output split into lines (partial lines buffered) → `onLine`; the last 50 stderr lines form `stderrTail`.
  - Timeout → `kill("timeout")`. `kill`: first call wins; SIGTERM to the group, SIGKILL after `KILL_GRACE_MS` if still alive.
  - On the child's `exit`, SIGKILL the group anyway (ESRCH ignored): nothing from the group may outlive `snip36`. Resolve on `close`.
  - Result: `killed` if `kill` was called; exit 0 → read `<base>.proof` (ascii, trimmed), `<base>.proof_facts` (JSON string array), `<base>.raw_messages.json` when present (its `l2_to_l1_messages`) → `done`, or `fail` with reason `prover output missing: <file basename>`; non-zero exit → `fail` with `reason = sanitizeReason(stderrTail) || "exit code <n>"`; spawn error → `fail` with the error message.
  - Delete the four job files before resolving, whatever happened.
  - `sanitizeReason`: last non-empty line; strip `/\x1b\[[0-9;]*[A-Za-z]/g`; replace `/(?:\/[\w.@+-]+){2,}/g` with `<path>`; trim; cut to 300 characters.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit checkpoint** — `feat(proofServer): run snip36 in its own process group`; stage the four files.

### Task 8: Proof service

**Files:** Create `proofServer/src/service.ts`, `proofServer/test/service.test.ts`, `proofServer/test/helpers/fake-run.ts`

**Interfaces — Consumes:** `InstanceConfig`, `Network` (Task 1); `Layout`, `instanceFiles` (Task 1); `JsonlLogger` (Task 2); `ConfigStore`, `SitesConfig`, `Limits`, `siteAllowed` (Task 3); `QuotaStore`, `secondsUntilUtcMidnight` (Task 4); `ProofQueue`, `DurationEstimator`, `estimateWaitSec` (Task 5); `tryAcquireSlot`, `SlotLock` (Task 6); `startProof`, `ProofSpec`, `ProofRun`, `ProverResult` (Task 7). **Produces:**

```ts
export type SseEvent = "queued" | "started" | "log" | "done" | "error";
export interface SseSink { send(event: SseEvent, data: object): void; close(): void; readonly closed: boolean }
export interface ProveJob { reqId: string; site: string; lan: boolean; ip: string; blockNumber: number; tx: unknown; sse: SseSink; enqueuedAt: number }
export type ServiceReject = "quota_exceeded" | "site_busy" | "queue_full" | "wait_too_long" | "shutting_down";
export type Admission = { ok: true } | { ok: false; status: 429 | 503; reason: ServiceReject; message: string; retryAfterSec?: number };
export interface HealthPayload { ok: boolean; network: Network; queueLength: number; running: number }
export interface StatusPayload {
  inst: string; network: Network;
  running: Array<{ reqId: string; site: string; runningSec: number }>;
  queue: Array<{ reqId: string; site: string; waitingSec: number }>;
  usage: { day: string; used: Record<string, number> };
  limits: Limits;
  sites: Array<{ name: string; enabled: boolean; perDay: Partial<Record<Network, number>> }>;
}
export interface ServiceDeps { inst: InstanceConfig; layout: Layout; config: ConfigStore; quota: QuotaStore; log: JsonlLogger; startProof?: (spec: ProofSpec) => ProofRun; now?: () => number }
export class ProofService {
  constructor(deps: ServiceDeps);   // subscribes to config "reload"; unref'd 1 s timer calling pump()
  admit(site: string, lan: boolean): Admission;
  submit(job: ProveJob): void;
  cancel(reqId: string): void;
  health(): HealthPayload;
  status(): StatusPayload;
  shutdown(graceMs: number): Promise<void>;
}
// test/helpers/fake-run.ts
export interface FakeProver { start: (spec: ProofSpec) => ProofRun; specs: ProofSpec[]; finish(index: number, result: ProverResult): void; killed: Array<{ index: number; reason: KillReason }> }
export function fakeProver(): FakeProver;   // pgid null; result settles on finish(), or on kill() as { kind: "killed", reason }
export class RecordingSink implements SseSink { events: Array<{ event: string; data: any }>; closed: boolean }
```

Rules:
- `admit`: shutting down → 503 `shutting_down` (LAN too). LAN → ok. External (`cfg = config.get()`, `perDay = cfg.sites[site].perDay[network] ?? 0`, `running` = jobs running in this instance, `avg = estimator.averageMs()`), in this order:
  1. `quota.used(site) + queue.countBySite(site) >= perDay` → 429 `quota_exceeded`, `retryAfterSec = secondsUntilUtcMidnight(now)`;
  2. queued + running jobs of the site `>= perSiteQueueMax` → 429 `site_busy`;
  3. `queue.size() >= queueMax` → 503 `queue_full`, `retryAfterSec = estimateWaitSec(queue.size() + running, avg)`;
  4. `eta = estimateWaitSec(queue.size() + running, avg) > maxWaitSec` → 503 `wait_too_long`, `retryAfterSec = eta`.
- `submit`: enqueue; log `queued` {reqId, site, queueLen}; send `queued` {position, etaSec} to the new job and to every queued job whose position changed (`etaSec = estimateWaitSec(position − 1 + running, avg)`); `pump()`.
- `pump` never runs twice at once (a call during a pass schedules one more pass): while the queue is not empty, `tryAcquireSlot(layout, limits.machineSlots)`; null → stop; else start the head job.
- Start: external → `quota.increment(site)`; log `start` {waitMs}; send `started` {}; `startProof({ binary: inst.snip36Binary, repoDir: layout.repoDir, workDir: instanceFiles(layout, inst.name).workDir, jobId: reqId, network: inst.network, rpcUrl: inst.rpcUrl, blockNumber, tx, runnerPort: lock.runnerPort, timeoutMs: proofTimeoutSec × 1000, onLine: LAN jobs only → send log {stream, line} })`; `lock.recordProof(pgid, inst.name)` when pgid is not null.
- End: `done` → send `done` (the ProofOutput), log `done` {durMs}, `estimator.add(durMs)`; `fail` → send `error` {message: `Proof generation failed: <reason>`} plus `stderr: stderrTail` for LAN jobs only, log `fail` {durMs, reason}; killed `timeout` → send `error` {message: `Proof timed out after <proofTimeoutSec> s`}, log `timeout` {durMs}; killed `abort` → log `abort` {durMs, reason: "client_disconnected"}; killed `shutdown` → send `error` {message: "Server is shutting down"}, log `abort` {reason: "shutdown"}. Then release the slot, close the sink, refresh positions, `pump()`.
- `cancel`: queued → remove, log `abort` {reason: "client_disconnected"}, refresh positions; running → `kill("abort")`.
- Config `reload`: external queued jobs with `!siteAllowed(cfg, site, network)` → `error` {message: "Access for this site was revoked"}, closed, log `reject` {reason: "site_revoked"}; refresh positions; `pump()`.
- `shutdown`: flag; stop the timer; queued jobs → `error` {message: "Server is shutting down"}, closed, log `abort` {reason: "shutdown"}; wait until nothing runs or `graceMs` elapsed; then `kill("shutdown")` the remaining runs and await their end handling.
- Every log write carries `reqId` and `site`. `status()` never includes transaction data or key hashes.

- [ ] **Step 1: Write the failing tests.** Setup for each test: `makeHome()`; `InstanceConfig` literal (`sepolia`, `snip36Binary` unused); sites file `{ voty: { keySha256: hashKey("K"), enabled: true, perDay: { sepolia: 2 } } }` plus per-test limits; `ConfigStore` started; `QuotaStore` and `ProofService` with `now = () => Date.parse("2026-10-28T23:00:00Z")`; `fakeProver()`; jobs with `RecordingSink`. Starting a job is asynchronous: `await waitFor(() => fake.specs.length === n)`.

```ts
test("a LAN job gets queued, started, then done", ...)
  // events [queued {position: 1, etaSec: 0}, started]; finish(0, done) → last event "done" with the output; sink closed; quota.used("lan") 0
test("LAN jobs are admitted even when the queue is full", ...)          // queueMax 0 → admit("x", true) ok; admit("voty", false) → 503 queue_full
test("quota counts launched and queued jobs", ...)
  // A runs, B queued → admit("voty", false) deepEqual { ok: false, status: 429, reason: "quota_exceeded", message: <any>, retryAfterSec: 3600 } (compare reason/status/retryAfterSec)
test("site_busy when the site already has perSiteQueueMax jobs", ...)    // perDay 100, perSiteQueueMax 2: A runs, B queued → 429 site_busy
test("queue_full", ...)                                                  // perDay 100, perSiteQueueMax 5, queueMax 1: A runs, B queued → 503 queue_full, retryAfterSec 120
test("wait_too_long counts jobs ahead", ...)
  // perDay 100, perSiteQueueMax 5, maxWaitSec 100: A runs → admit ok (60 s); B queued → admit → 503 wait_too_long, retryAfterSec 120
test("LAN jobs jump ahead of external ones", ...)                        // A ext runs, B ext queued, C LAN queued; finish A → specs[1].jobId === C.reqId
test("quota is counted at launch, not at admission", ...)                // B queued → used 1; finish A → B launched → used 2
test("cancel while queued removes the job without counting it", ...)    // B never gets "started"; log has abort client_disconnected; used stays 1
test("cancel while running kills the proof", ...)                        // fake.killed deepEqual [{ index: 0, reason: "abort" }]; used stays 1
test("failure and timeout messages", ...)
  // external fail { reason: "Vote is not open", stderrTail: "x\nVote is not open" } → error { message: "Proof generation failed: Vote is not open" } without stderr;
  // LAN fail → error has stderr; killed timeout → error { message: "Proof timed out after 600 s" }, log ev "timeout"
test("disabling a site rejects its queued jobs", ...)
  // A runs, B queued (voty); write voty enabled false; config.reloadNow() → B error "Access for this site was revoked", closed; log reject site_revoked; fake.killed is []
test("shutdown rejects queued jobs, lets the running one finish, then refuses new jobs", ...)
  // p = shutdown(5000) → B error "Server is shutting down"; admit → 503 shutting_down; finish(0, done) → await p; A got "done"
test("shutdown kills a run that outlives the grace", ...)                // shutdown(200) → fake.killed [{ index: 0, reason: "shutdown" }]; A got error "Server is shutting down"
test("a slot held elsewhere delays the job", ...)
  // hold = await tryAcquireSlot(layout, 1); submit A → after 300 ms specs.length 0; hold.release() → waitFor(specs.length === 1, 2500)
test("status lists jobs without transaction data", ...)                  // JSON.stringify(status()) includes A.reqId, excludes fixture calldata[6] and "keySha256"
```

- [ ] **Step 2: Run** — expected FAIL. **Step 3: Implement `src/service.ts` and the helper.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit checkpoint** — `feat(proofServer): add proof service (admission, scheduling, job lifecycle)`; stage the three files.

### Task 9: HTTP layer and server process

**Files:**
- Create: `proofServer/src/validate.ts`, `proofServer/src/sse.ts`, `proofServer/src/rpc.ts`, `proofServer/src/app.ts`, `proofServer/src/server.ts`, `proofServer/test/validate.test.ts`, `proofServer/test/app-helpers.test.ts`, `proofServer/test/server.test.ts`, `proofServer/test/helpers/rpc.ts`, `proofServer/test/helpers/sse.ts`, `proofServer/test/helpers/server.ts`
- Replace: `proofServer/src/index.ts`
- Delete: `proofServer/src/build.ts`, `proofServer/src/prove.ts`
- Modify: `proofServer/package.json` (remove the `starknet` dependency, then `npm install`)

**Interfaces — Consumes:** Tasks 1–8. **Produces:**

```ts
// src/validate.ts
export const MAX_CALLDATA = 5000;
export type BodyCheck = { ok: true; blockNumber: number; tx: INVOKE_TXN_V3 } | { ok: false; message: string };  // INVOKE_TXN_V3 from "@starknet-io/starknet-types-0101"
export function validateProveBody(body: unknown): BodyCheck;
// src/sse.ts
export class SseStream implements SseSink {
  constructor(res: express.Response, opts?: { pingMs?: number; onDisconnect?: () => void });  // ping 15000
  send(event: SseEvent, data: object): void;   // "event: <e>\ndata: <json>\n\n"; no-op once closed
  close(): void;
  get closed(): boolean;
}
// src/rpc.ts
export function fetchChainId(rpcUrl: string, timeoutMs?: number): Promise<string>;  // JSON-RPC starknet_chainId, 10000 ms
// src/app.ts
export type HttpReject = AuthFailure | ServiceReject | "not_private" | "banned" | "body_too_large" | "invalid_json" | "invalid_body";
export interface AppDeps { inst: InstanceConfig; service: ProofService; config: ConfigStore; bans: BanList; log: JsonlLogger }
export function createLanApp(deps: AppDeps): express.Express;
export function createPublicApp(deps: AppDeps): express.Express;
export function isLanAddress(addr: string | undefined): boolean;  // 127/8, 10/8, 172.16/12, 192.168/16, ::1, and ::ffff:<those IPv4>
export function clientIp(xForwardedFor: string | undefined, socketAddr: string | undefined): string;  // last X-Forwarded-For entry, else socket, else "unknown"
// src/server.ts
export class StartupError extends Error {}
export interface RunningServer { inst: InstanceConfig; lanUrl: string; publicUrl: string | null; service: ProofService; stop(graceMs?: number): Promise<void> }
export function startServer(layout: Layout, instName: string): Promise<RunningServer>;
export const SHUTDOWN_GRACE_MS = 60_000;
// test/helpers/rpc.ts
export function startFakeRpc(chainIdHex: string): Promise<{ url: string; close(): Promise<void> }>;  // answers every POST with { jsonrpc, id, result }
// test/helpers/sse.ts
export interface SseRec { event: string; data: any }
export interface ProveResponse { status: number; retryAfter: string | null; json: any; events: SseRec[] }
export function prove(baseUrl: string, body: unknown, opts?: { key?: string; signal?: AbortSignal; onEvent?: (e: SseRec) => void; rawBody?: string }): Promise<ProveResponse>;
  // parses SSE like the clients (split on "\n\n", "event:" / "data:" lines, comments ignored); an abort resolves with the events so far
// test/helpers/server.ts
export const TEST_KEY: string;   // "test-key-0123456789"
export interface TestServer { home: TestHome; server: RunningServer; lanUrl: string; publicUrl: string; close(): Promise<void> }
export function startTestServer(opts?: { limits?: Partial<Limits>; perDay?: number; chainId?: string }): Promise<TestServer>;
  // instance "sepolia": LAN + public on free ports, fake RPC answering opts.chainId ?? CHAIN_IDS.sepolia, SNIP36_BINARY = absolute test/fake-snip36.sh;
  // sites { voty: { keySha256: hashKey(TEST_KEY), enabled: true, perDay: { sepolia: opts.perDay ?? 2 } } }
```

HTTP rules:
- LAN app: every route first checks `isLanAddress(req.socket.remoteAddress)`, else 403 `not_private`. Public app: every route first computes `ip = clientIp(req.headers["x-forwarded-for"], socket address)`; `bans.isBanned(ip)` → 403 `banned`.
- `GET /health` → `service.health()`. `GET /status` → LAN only (`service.status()`); public → 404. Unknown routes → 404 `{ error: "Not found" }`.
- `POST /prove`: `reqId = randomUUID()`. Public: `authenticate(req.headers.authorization, network, config.get())`; on `missing_key`/`unknown_key`, `bans.recordFailure(ip, limits.badKey)` and log `ban` {ip} when it returns true; reject. Then log `request` {reqId, site — `"lan"` on the LAN listener —, ip}. Parse JSON from the handler with `express.json({ limit: maxBodyKB * 1024 })` (live limit): error type `entity.too.large` → 413 `body_too_large`, other parse errors → 400 `invalid_json`. `validateProveBody` → 400 `invalid_body` with its message. `service.admit` → its status, reason, message, `Retry-After`. Accepted → `new SseStream(res, { onDisconnect: () => service.cancel(reqId) })`, `service.submit(...)`.
- Every rejection: `res.status(s)`, `Retry-After` when known, `.json({ error: <message>, reason })`, and log `reject` {reqId, site?, ip, reason}. Statuses: `missing_key`/`unknown_key` 401; `site_disabled`/`network_not_allowed`/`banned`/`not_private` 403; `body_too_large` 413; `invalid_json`/`invalid_body` 400; `quota_exceeded`/`site_busy` 429; `queue_full`/`wait_too_long`/`shutting_down` 503.
- Validation: body object; `blockNumber` non-negative safe integer, or a string of decimal or `0x`-hex digits converting to one; `tx.type` `"INVOKE"`, `tx.version` `"0x3"`; `sender_address`, `nonce`, `tip` match `/^0x[0-9a-fA-F]{1,64}$/`; `calldata` (≤ `MAX_CALLDATA`), `signature`, `paymaster_data`, `account_deployment_data` arrays of such strings; `resource_bounds.{l1_gas, l2_gas, l1_data_gas}.{max_amount, max_price_per_unit}` such strings; `nonce_data_availability_mode` and `fee_data_availability_mode` `"L1"` or `"L2"`. Messages name the field, e.g. `tx.calldata: expected an array of at most 5000 hex strings`.

Startup (`startServer`), in order; each failure is a `StartupError` saying what to do:
1. `loadInstance` (InstanceError message reused).
2. Binary executable (`fs.accessSync(…, X_OK)`) → `snip36 not found at <path> — run ./proof-server.sh setup`.
3. `readSitesFile(layout.sitesFile)` → its message (contains `sites.json`).
4. `fetchChainId(rpcUrl)` → unreachable: `node <rpcUrl> unreachable: <cause>`; `BigInt` mismatch: `node <rpcUrl> is on <name>, but instances/<inst>.env says NETWORK=<network> (<CHAIN_NAMES[network]>)`, where `<name>` is the ASCII decoding of the returned id when printable, else the hex.
5. Create `logsDir`, `state/<inst>`, `slotsDir`, `workDir` (mode `0o700`, then `chmod 0o700`); empty `workDir`.
6. `killOrphanProofs(layout)`.
7. `JsonlLogger`; `ConfigStore.start()` with `reload` → log `config_reload`, `error` → log `config_error` {msg}; `QuotaStore(usageFile)`; `BanList`; `ProofService`.
8. Listen: LAN app on `0.0.0.0:lanPort` and `[::1]:lanPort` (`EADDRNOTAVAIL`/`EAFNOSUPPORT` on ::1 ignored); public app on `127.0.0.1:publicPort` when enabled. `EADDRINUSE` → `port <n> is already in use (another instance, or the old proof server?)`.
9. Log `startup` {msg: `network=<n> lan=<port> public=<port|off>`}; print one console line with the URLs.

`stop(graceMs = SHUTDOWN_GRACE_MS)`: log `shutdown`; stop accepting (`close()` every listener); `await service.shutdown(graceMs)`; `config.stop()`; `closeIdleConnections()`.

`src/index.ts`: `node dist/index.js <instance>` → `startServer(resolveLayout(), process.argv[2])`. `StartupError` → `console.error(message)`, exit 1; other error → stack, exit 1. SIGTERM/SIGINT → `await stop()`, delete `instanceFiles(…).pidFile` if it holds this pid, exit 0. `uncaughtException`/`unhandledRejection` → `console.error`, exit 1 (the pid file stays, so `status` reports `crashed`).

- [ ] **Step 1: Write the failing tests** (server tests: `const s = await startTestServer(...)`, `t.after(() => s.close())`; `body = { blockNumber: 123, tx: fixture }`; `FAKE_*` cleared in `afterEach`)

```ts
// test/validate.test.ts
test("the fixture is valid; blockNumber accepts decimal and hex strings", ...)  // 123 → 123; "0x7b" → 123; "12" → 12
test("invalid bodies name the field", ...)
  // blockNumber -1, 1.5, "abc" → /blockNumber/; tx.type "DEPLOY_ACCOUNT" → /tx\.type/; tx.version "0x1" → /tx\.version/;
  // 5001 calldata elements → /tx\.calldata/; calldata ["xyz"] → /tx\.calldata/; no resource_bounds.l2_gas → /tx\.resource_bounds/;
  // nonce_data_availability_mode "L3" → /nonce_data_availability_mode/; body null → ok false

// test/app-helpers.test.ts
test("isLanAddress", ...)
  // true: "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "::1", "::ffff:192.168.1.20"
  // false: "172.32.0.1", "8.8.8.8", "2a01:e0a::1", "", undefined
test("clientIp", ...)   // ("1.2.3.4", "127.0.0.1") → "1.2.3.4"; ("9.9.9.9, 1.2.3.4", x) → "1.2.3.4"; (undefined, "127.0.0.1") → "127.0.0.1"; (undefined, undefined) → "unknown"

// test/server.test.ts
test("LAN: full proof flow", ...)
  // 200; events[0..1] are queued, started; some "log"; last "done" with data deepEqual FAKE_OUT (Task 7)
test("public: key required, no prover lines", ...)
  // no key → 401 { reason: "missing_key" }; "wrong" → 401 unknown_key; TEST_KEY → 200, no "log" event, last "done"
test("public: daily quota", ...)       // perDay 2: two 200s, then 429 quota_exceeded; |Number(retryAfter) − secondsUntilUtcMidnight(new Date())| ≤ 5
test("one proof at a time; others wait their turn", ...)
  // FAKE_SLEEP=1, FAKE_TRACE; LAN request A, then B once A got "started", then C once B got "queued" (fixed arrival order) → all "done";
  // start/end lines of the trace alternate start,end,start,end,start,end; queued positions seen: A [1], B [1], C [2, 1]
test("timeout kills the proof group and frees the runner port", ...)
  // limits.proofTimeoutSec 1, FAKE_MODE=hang → "error" whose message matches /timed out/; log has ev "timeout";
  // isPortFree(home.layout.runnerBasePort) true; pgrepF(`${home.layout.runnerBasePort} fake-runner`) is []
test("limits change while the server runs", ...)
  // perDay 1: 200, then 429; home.writeSites(perDay 3); waitFor(log has config_reload, 7000); then 200
test("bad keys get the IP banned", ...)
  // limits.badKey { maxFailures: 3, windowMin: 10, banMin: 60 }: 3× "wrong" → 401; then TEST_KEY → 403 banned; log has ev "ban"
test("disconnect while queued: removed and not counted", ...)
  // FAKE_SLEEP=2: LAN request runs; public request aborted after its first "queued" → waitFor(log abort, site voty, reason client_disconnected);
  // after the LAN proof: GET LAN /status → usage.used.voty ?? 0 === 0; the trace has a single "start"
test("disconnect while running: proof killed and counted", ...)
  // FAKE_SLEEP=30: public request aborted after "started" → waitFor(log abort site voty); /status usage.used.voty === 1;
  // waitFor(() => pgrepF(home.root).length === 0, 7000)
test("privacy: log holds no tx data or key", ...)
  // LAN proof, public proof, public proof with FAKE_MODE=fail, one "wrong" key → the text of logs/sepolia.log contains none of
  // TEST_KEY, "wrong", fixture calldata[6], fixture signature[0]
test("body checks", ...)
  // limits.maxBodyKB 1: rawBody of 2048 bytes → 413 body_too_large; rawBody "{bad" → 400 invalid_json; tx.version "0x1" → 400 invalid_body, json.error /tx\.version/
test("health and status", ...)
  // LAN /health → 200 { ok: true, network: "sepolia", queueLength: 0, running: 0 }; public /health 200; public /status 404; LAN /status 200, inst "sepolia"
test("LAN listener answers on ::1", ...)   // GET http://[::1]:<lanPort>/health → 200 (t.skip when the machine has no IPv6 loopback)
test("failure reason reaches the site; stderr only the LAN", ...)
  // FAKE_MODE=fail: public error.message /Vote is not open/, no stderr field; LAN error.stderr /progress: step 1\/2/
test("startup failures explain what to do", ...)   // no running server:
  // chainId CHAIN_IDS.mainnet → StartupError /SN_MAIN/ and /NETWORK=sepolia/; SNIP36_BINARY=/nonexistent → /proof-server\.sh setup/;
  // sites.json "{ bad" → /sites\.json/; LAN port already listened on → /already in use/
```

- [ ] **Step 2: Run** the three files — expected FAIL.
- [ ] **Step 3: Implement** the modules and helpers above; replace `src/index.ts`; delete `src/build.ts` and `src/prove.ts`; remove `starknet` from `package.json` dependencies and run `npm install`.
- [ ] **Step 4: Run** `npm test` → PASS; `npm run build` → exit 0, `dist/` holds no `build.js` or `prove.js`.
- [ ] **Step 5: Smoke test with the real prover** (once Task 0 Step 6 passed): create `instances/local.env` (LAN only, a real node URL); `node dist/index.js local` → one line with the URLs; from another shell `curl -s http://127.0.0.1:3030/health` → `{"ok":true,"network":"…","queueLength":0,"running":0}`; Ctrl-C → exits within a second.
- [ ] **Step 6: Commit checkpoint** — `feat(proofServer): new HTTP server with LAN and public listeners`; stage the created files, `proofServer/src/index.ts`, the deleted `proofServer/src/build.ts` and `proofServer/src/prove.ts`, `proofServer/package.json`.

### Task 10: Start, stop, status — the CLI and `proof-server.sh`

**Files:** Create `proofServer/src/cli/main.ts`, `proofServer/src/cli/lifecycle.ts`, `proofServer/src/cli/caddy.ts`, `proofServer/proof-server.sh` (executable), `proofServer/test/fake-caddy.sh` (executable), `proofServer/test/lifecycle.test.ts`

**Interfaces — Consumes:** `Layout`, `layoutEnv`, `instanceFiles`, `loadInstance`, `listInstances` (Task 1); `isProcessAlive`, `killGroup`, `waitUntil`, `killOrphanProofs` (Task 6). Tests also use `makeHome` (Task 1), `pgrepF`, `isGroupAlive`, `isPortFree` (Task 6), `FAKE_SNIP36` (Task 7), `startFakeRpc`, `prove` (Task 9). **Produces:**

```ts
// src/cli/main.ts
export type Out = (line: string) => void;
export type Command = (layout: Layout, args: string[], out: Out) => Promise<number>;   // returns the exit code
export function main(argv: string[], layout?: Layout, out?: Out): Promise<number>;    // setup | start | stop | restart | status | stats | site | caddyfile | help
// src/cli/lifecycle.ts
export type RunState = "running" | "stopped" | "crashed";
export function instanceState(layout: Layout, name: string): { state: RunState; pid: number | null };
export const startCommand: Command;   // args: [<name> | "all"], default "all"
export const stopCommand: Command;
export const restartCommand: Command;
export const statusCommand: Command;
export const START_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 75_000;
// src/cli/caddy.ts (process part; Task 11 adds the Caddyfile)
export function caddyState(layout: Layout): { state: RunState; pid: number | null };   // pid file <stateDir>/caddy.pid
export function startCaddy(layout: Layout, out: Out): Promise<boolean>;
export function stopCaddy(layout: Layout, out: Out): Promise<void>;
```

Rules:
- State: pid file absent → stopped; present and alive → running; present and dead → crashed.
- `start`: unknown name → error listing the instances; `all` with no instance → `No instance: copy instances/example.env to instances/<name>.env`. Running → `<name>: already running (pid N)` (exit 1 when named, skipped for `all`). Otherwise `loadInstance` (error → print, exit 1); truncate `stdoutFile`; spawn detached (own session) with stdout and stderr appended to `stdoutFile`, `cwd` = `packageDir`, env `{ ...process.env, ...layoutEnv(layout) }`, command `process.execPath <packageDir>/dist/index.js <name>`, or `process.execPath --import tsx <packageDir>/src/index.ts <name>` when `PROOF_SERVER_DEV=1`; write the pid file; `unref()`. Poll `GET http://127.0.0.1:<lanPort>/health` every 500 ms up to `START_TIMEOUT_MS`: 200 → `<name>: running (pid N) — LAN http://<first non-internal IPv4>:<lanPort>, public 127.0.0.1:<publicPort>|off`; process gone → `<name>: failed to start:` + the last 20 lines of `stdoutFile`, exit 1.
- End of every `start`: if a public instance runs and Caddy does not → without `layout.caddyfile`: `No deploy/Caddyfile: run ./proof-server.sh caddyfile --domain <your-name>.duckdns.org`, exit 1; else `startCaddy`.
- `startCaddy`: binary `process.env.CADDY_BINARY ?? "caddy"`; spawn detached `run --config <caddyfile> --adapter caddyfile`, output to `logs/caddy.stdout` (truncated), pid in `state/caddy.pid`; alive after 2 s → `caddy: running (pid N)`, true; dead → its last 20 lines, false; ENOENT → `caddy not found: install it (see INSTALL.md)`, false.
- `stop`: not running → `<name>: not running` (crashed: remove the stale pid file and say `was crashed`). Running → SIGTERM; wait up to `STOP_TIMEOUT_MS`; still alive → SIGKILL and `<name>: killed after 75 s`; then `killOrphanProofs(layout)`; remove the pid file. Afterwards, no public instance running and Caddy running → `stopCaddy` (SIGTERM, 10 s, SIGKILL, remove `caddy.pid`).
- `restart` = `stop` then `start` with the same target.
- `status`: per instance: name, network, state, pid, ports; running → `GET /status` (2 s timeout): running proofs, queue length, today's usage `site used/perDay`; crashed → `crashed — last output:` + the last 10 lines of `stdoutFile`. Then `caddy: running|stopped|crashed`. Exit 0.
- `main`: Node major < 22 → message, exit 1; `help` lists every command with one line each; unknown command → help, exit 1; `if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code))`.

`proof-server.sh`:

```bash
#!/usr/bin/env bash
# SNIP-36 proof server — entry point. Run: ./proof-server.sh help
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "node not found: install Node.js 22 or newer (see INSTALL.md)" >&2
  exit 1
fi
if [[ ! -f "$DIR/dist/cli/main.js" ]]; then
  echo "Not built yet: run 'npm install && npm run build' in $DIR" >&2
  exit 1
fi
exec node "$DIR/dist/cli/main.js" "$@"
```

`test/fake-caddy.sh`:

```bash
#!/usr/bin/env bash
# Test double for `caddy run --config <file> --adapter caddyfile`
config=""
while [[ $# -gt 0 ]]; do [[ "$1" == "--config" ]] && config="$2"; shift; done
[[ -f "$config" ]] || { echo "config not found: $config" >&2; exit 1; }
exec sleep 3600
```

- [ ] **Step 1: Write the failing tests.** File-level: `process.env.PROOF_SERVER_DEV = "1"`, `process.env.CADDY_BINARY = <absolute test/fake-caddy.sh>`; each test: `makeHome()`, fake RPC (sepolia), instances written with free ports and `SNIP36_BINARY` = fake; `t.after(async () => { await stopCommand(home.layout, ["all"], () => {}); home.cleanup(); })`; `out` collects lines.

```ts
test("help and unknown commands", ...)           // main(["help"]) → 0, output mentions start, stop, status, site, stats, caddyfile, setup; main(["nope"]) → 1
test("start, start again, restart, status, stop", ...)
  // start a → 0, /a: running/; start a → 1, /already running/; restart a → 0 with a new pid; status → /a/ and /running/;
  // stop a → 0; instanceState → stopped; pid file gone
test("start reports a startup failure and status shows it", ...)
  // fake RPC answering CHAIN_IDS.mainnet → start a → 1, output /NETWORK=sepolia/; status → /crashed/ and /NETWORK=sepolia/
test("two instances share the machine slot", ...)
  // instances a and b; FAKE_SLEEP=1, FAKE_TRACE; one LAN proof on each in parallel → both "done"; trace start/end lines alternate
test("stop during a proof lets it finish and leaves no process", ...)
  // FAKE_SLEEP=2; proof running ("started" seen) → stopCommand(a) → the proof's last event is "done"; state stopped;
  // pgrepF(home.root) is []; logs/a.stdout contains neither fixture calldata[6] nor signature[0]
test("orphan proof of a SIGKILLed server is killed on restart", ...)
  // FAKE_MODE=hang; proof running → pgid from state/slots/slot-0.json; SIGKILL the server pid (pid file) → status /crashed/;
  // isGroupAlive(pgid) true; start a → isGroupAlive(pgid) false and isPortFree(runnerBasePort) true
test("Caddy follows the public instances", ...)
  // instance p with PUBLIC_ENABLED=true: start → 1, /caddyfile --domain/, p running; write any deploy/Caddyfile; start → 0, caddyState running;
  // stop all → caddyState stopped
test("stop with nothing running", ...)            // stop all → 0, /not running/
```

- [ ] **Step 2: Run** `node --import tsx --test test/lifecycle.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** `main.ts` (only `help`, `start`, `stop`, `restart`, `status` wired for now), `lifecycle.ts`, the process part of `caddy.ts`, the two scripts (`chmod +x`).
- [ ] **Step 4: Run** → PASS; `npm run build`; `./proof-server.sh help` prints the command list.
- [ ] **Step 5: Real check** — `./proof-server.sh start local` (instance from Task 9 Step 5) → running; `./proof-server.sh status`; close the terminal, open a new one: `./proof-server.sh status` still shows it running; `./proof-server.sh stop` → stopped.
- [ ] **Step 6: Commit checkpoint** — `feat(proofServer): add proof-server.sh with start, stop, restart and status`; stage the six files (check that both scripts are staged with mode 100755).

### Task 11: Site keys, Caddyfile and setup commands

**Files:** Create `proofServer/src/cli/site.ts`, `proofServer/src/cli/setup.ts`, `proofServer/deploy/Caddyfile.example`, `proofServer/test/site.test.ts`, `proofServer/test/caddyfile.test.ts`; Modify `proofServer/src/cli/caddy.ts`, `proofServer/src/cli/main.ts`

**Interfaces — Consumes:** `generateKey`, `hashKey`, `readSitesFile`, `writeSitesFile`, `emptyConfig` (Task 3); `utcDay` (Task 4); `listInstances`, `loadInstance`, `instanceFiles` (Task 1); `Command`, `Out` (Task 10). **Produces:**

```ts
export const siteCommand: Command;      // add | set | enable | disable | remove | rotate-key | list
export function renderCaddyfile(layout: Layout, domain: string, instances: InstanceConfig[]): string;
export const caddyfileCommand: Command; // --domain <name> → writes layout.caddyfile
export const setupCommand: Command;
```

Rules:
- `site add <name> [--sepolia N] [--mainnet N] [--note TEXT]`: error if the site exists; `key = generateKey()`; stores `{ keySha256: hashKey(key), enabled: true, perDay: <given networks only>, note }`; prints the key alone on an indented line, with a sentence saying to send it privately and that it cannot be shown again.
- `site set <name> [--sepolia N|off] [--mainnet N|off] [--note TEXT]` (`off` removes the network); `site enable|disable|remove <name>`; `site rotate-key <name>` (prints the new key the same way); `site list`: name, enabled, per network `used/perDay` (used = sum over the instances of that network of today's `state/<inst>/usage.json`).
- Each change: `readSitesFile` → modify → `writeSitesFile`, then `Saved config/sites.json — running instances apply it within 5 s.` Errors (exit 1): unknown site, existing site on `add`, quota not an integer ≥ 0 or `off`, missing name. Options parsed with `util.parseArgs`.
- `caddyfile --domain <name>`: domain `/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i` else exit 1; public instances only (none → `No public instance (PUBLIC_ENABLED=true) in instances/`, exit 1); writes `layout.caddyfile`; prints the path, one `https://<domain>/<inst>/prove` per instance and `Freebox: forward TCP 443 to this machine, port 8443.`
- `renderCaddyfile` output, one `handle_path` block per public instance sorted by name:

```
# Generated by ./proof-server.sh caddyfile — do not edit, run the command again instead.
{
	http_port 8080
	https_port 8443
	admin localhost:2019
	storage file_system {
		root <stateDir>/caddy
	}
	log {
		output file <logsDir>/caddy.log {
			roll_size 5MiB
			roll_keep 3
		}
	}
}

<domain> {
	tls {
		issuer acme {
			disable_http_challenge
		}
	}
	request_body {
		max_size 1MB
	}
	handle_path /<inst>/* {
		reverse_proxy 127.0.0.1:<publicPort> {
			flush_interval -1
		}
	}
	handle {
		respond "Not found" 404
	}
}
```

- `setup` (logic of the deleted `src/build.ts`, in `layout.repoDir`): clone `https://github.com/starknet-innovation/snip-36-prover-backend` if missing; `cargo build --release -p snip36-cli` if `target/release/snip36` is missing; `<binary> setup` (cwd `repoDir`) if `<repoDir>/deps` is missing; then `<binary> doctor`. Each step announced, output inherited; exit code of the first failing command; `git`/`cargo` missing → message pointing to INSTALL.md.
- `deploy/Caddyfile.example` = `renderCaddyfile` for domain `myproof.duckdns.org`, instances `sepolia` (4030) and `mainnet` (4031), root `/home/you/secure-voty/proofServer`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/site.test.ts — out collects lines; key = the line matching /^\s+([A-Za-z0-9_-]{43})$/
test("add prints the key once and stores only its hash", ...)
  // site add voty --sepolia 100 --note "Secure voty" → 0; sites.voty deepEqual
  // { keySha256: hashKey(key), enabled: true, perDay: { sepolia: 100 }, note: "Secure voty" }; sites.json text does not contain key
test("add refuses an existing site", ...)                   // → 1
test("set changes quotas; off removes a network", ...)      // set voty --mainnet 5 --sepolia off → perDay { mainnet: 5 }
test("disable, enable, remove", ...)
test("rotate-key replaces the hash", ...)                   // new key ≠ old; keySha256 === hashKey(new key)
test("bad quotas are refused", ...)                         // --sepolia -1 → 1; --sepolia abc → 1
test("list shows today's usage per network", ...)
  // instance sepolia (NETWORK=sepolia); usage file { day: utcDay(new Date()), used: { voty: 3 } } → output has "voty" and "3/100"

// test/caddyfile.test.ts
test("renderCaddyfile routes each public instance", ...)
  // instances sepolia (public 4030), mainnet (public 4031), local (LAN only) → contains "https_port 8443", "myproof.duckdns.org {",
  // "handle_path /mainnet/* {", "reverse_proxy 127.0.0.1:4031 {", "handle_path /sepolia/* {", "reverse_proxy 127.0.0.1:4030 {",
  // "disable_http_challenge", "flush_interval -1", `root ${layout.stateDir}/caddy`; no "/local/"; the mainnet block comes first
test("caddyfile command checks its input", ...)
  // no --domain → 1; --domain "my proof" → 1; no public instance → 1; valid → 0 and layout.caddyfile written
```

- [ ] **Step 2: Run** both files — expected FAIL.
- [ ] **Step 3: Implement**; wire `site`, `caddyfile`, `setup` in `main.ts`; generate `deploy/Caddyfile.example` with `renderCaddyfile` and commit it as is.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Real check** — `npm run build && ./proof-server.sh setup` → every step reports "already done", `doctor` OK.
- [ ] **Step 6: Commit checkpoint** — `feat(proofServer): add site, caddyfile and setup commands`; stage the seven files.

### Task 12: Statistics

**Files:** Create `proofServer/src/cli/stats.ts`, `proofServer/test/stats.test.ts`, `proofServer/test/fixtures/stats.log`; Modify `proofServer/src/cli/main.ts`

**Interfaces — Consumes:** `LogRecord` (Task 2); `utcDay` (Task 4); `Command` (Task 10). `readLogRecords` finds `<inst>.log` and `<inst>.log.<n>` by listing `logsDir` (it does not know `LOG_FILES`, so it does not use `logFileSet`). **Produces:**

```ts
export type RejectCategory = "auth" | "quota" | "overload" | "invalid";
export const REJECT_CATEGORY: Record<string, RejectCategory>;
export interface StatsOptions { since?: Date; day?: string; site?: string; instance?: string }
export interface SiteDayStats {
  day: string; site: string; requests: number; done: number; failed: number; timeouts: number; aborted: number;
  rejected: Record<RejectCategory, number>;
  durMedianMs: number | null; durP95Ms: number | null; waitMedianMs: number | null; waitMaxMs: number | null;
}
export interface GlobalStats { peakQueue: number; timeouts: number; busiestHour: string | null }   // "YYYY-MM-DDTHH", UTC
export interface StatsResult { rows: SiteDayStats[]; global: GlobalStats }
export function readLogRecords(logsDir: string, instance?: string): LogRecord[];  // per instance: <inst>.log.N … <inst>.log; malformed lines skipped
export function computeStats(records: LogRecord[], opts?: StatsOptions): StatsResult;
export function percentile(values: number[], p: number): number | null;          // nearest rank: sorted[ceil(p / 100 × n) − 1]
export function formatStats(result: StatsResult): string;
export const statsCommand: Command;   // --since <N>d|<N>h, --day YYYY-MM-DD, --site, --instance, --json
```

Rules: `REJECT_CATEGORY` = auth: `missing_key`, `unknown_key`, `banned`, `site_disabled`, `network_not_allowed`, `site_revoked`; quota: `quota_exceeded`, `site_busy`; overload: `queue_full`, `wait_too_long`, `shutting_down`; invalid: `invalid_json`, `invalid_body`, `body_too_large`, `not_private`. A record without `site` counts under `(unknown)`. Filters on `ts` (`since`: ts ≥ since; `day`: `utcDay(ts)`), `site`, `inst`. Rows sorted by day, then site. Durations from `done.durMs`, waits from `start.waitMs`, `aborted` from `abort`, `timeouts` from `timeout`. `peakQueue` = max `queueLen`; `busiestHour` = hour with the most `request` events (earliest on ties). The text table layout is free.

- [ ] **Step 1: Create the reference log** `test/fixtures/stats.log` (expected values below are computed by hand from it):

```
{"ts":"2026-10-28T10:00:00.000Z","inst":"sepolia","ev":"request","reqId":"a","site":"voty","ip":"1.1.1.1"}
{"ts":"2026-10-28T10:00:00.010Z","inst":"sepolia","ev":"queued","reqId":"a","site":"voty","queueLen":1}
{"ts":"2026-10-28T10:00:00.020Z","inst":"sepolia","ev":"start","reqId":"a","site":"voty","waitMs":20}
{"ts":"2026-10-28T10:00:44.020Z","inst":"sepolia","ev":"done","reqId":"a","site":"voty","durMs":44000}
{"ts":"2026-10-28T10:01:00.000Z","inst":"sepolia","ev":"request","reqId":"b","site":"voty","ip":"1.1.1.1"}
{"ts":"2026-10-28T10:01:00.010Z","inst":"sepolia","ev":"queued","reqId":"b","site":"voty","queueLen":2}
{"ts":"2026-10-28T10:01:30.000Z","inst":"sepolia","ev":"start","reqId":"b","site":"voty","waitMs":30000}
{"ts":"2026-10-28T10:02:20.000Z","inst":"sepolia","ev":"done","reqId":"b","site":"voty","durMs":50000}
{"ts":"2026-10-28T11:00:00.000Z","inst":"sepolia","ev":"request","reqId":"c","site":"voty","ip":"1.1.1.1"}
{"ts":"2026-10-28T11:00:00.001Z","inst":"sepolia","ev":"reject","reqId":"c","site":"voty","ip":"1.1.1.1","reason":"quota_exceeded"}
{"ts":"2026-10-28T11:05:00.000Z","inst":"sepolia","ev":"reject","reqId":"d","ip":"6.6.6.6","reason":"unknown_key"}
{"ts":"2026-10-29T09:00:00.000Z","inst":"sepolia","ev":"request","reqId":"e","site":"lan","ip":"192.168.1.20"}
{"ts":"2026-10-29T09:00:00.010Z","inst":"sepolia","ev":"queued","reqId":"e","site":"lan","queueLen":1}
{"ts":"2026-10-29T09:00:00.020Z","inst":"sepolia","ev":"start","reqId":"e","site":"lan","waitMs":10}
{"ts":"2026-10-29T09:00:30.000Z","inst":"sepolia","ev":"fail","reqId":"e","site":"lan","durMs":29980,"reason":"Vote is not open"}
this line is not JSON
```

- [ ] **Step 2: Write the failing tests**

```ts
const zero = { auth: 0, quota: 0, overload: 0, invalid: 0 };
const EXPECTED_ROWS = [
  { day: "2026-10-28", site: "(unknown)", requests: 0, done: 0, failed: 0, timeouts: 0, aborted: 0, rejected: { ...zero, auth: 1 }, durMedianMs: null, durP95Ms: null, waitMedianMs: null, waitMaxMs: null },
  { day: "2026-10-28", site: "voty", requests: 3, done: 2, failed: 0, timeouts: 0, aborted: 0, rejected: { ...zero, quota: 1 }, durMedianMs: 44000, durP95Ms: 50000, waitMedianMs: 20, waitMaxMs: 30000 },
  { day: "2026-10-29", site: "lan", requests: 1, done: 0, failed: 1, timeouts: 0, aborted: 0, rejected: zero, durMedianMs: null, durP95Ms: null, waitMedianMs: 10, waitMaxMs: 10 },
];
test("percentile is nearest-rank", () => {
  assert.equal(percentile([], 50), null); assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40); assert.equal(percentile([7], 95), 7);
});
test("computeStats on the reference log", () => {
  const r = computeStats(records);   // records = readLogRecords of the fixture copied to logs/sepolia.log
  assert.deepEqual(r.rows, EXPECTED_ROWS);
  assert.deepEqual(r.global, { peakQueue: 2, timeouts: 0, busiestHour: "2026-10-28T10" });
});
test("filters", ...)   // { day: "2026-10-29" } → [EXPECTED_ROWS[2]]; { site: "voty" } → [EXPECTED_ROWS[1]]; { since: new Date("2026-10-29T00:00:00Z") } → [EXPECTED_ROWS[2]]
test("readLogRecords reads rotated files oldest first, all instances", ...)
  // first 8 fixture lines in logs/sepolia.log.1, the rest in logs/sepolia.log, one record in logs/mainnet.log → 16 records,
  // sepolia ones in fixture order; readLogRecords(dir, "mainnet") → 1 record
test("stats command", ...)   // --json → JSON.parse(output) deepEqual computeStats(records); --since 2x → exit 1
```

- [ ] **Step 3: Run** — expected FAIL. **Step 4: Implement**; wire `stats` in `main.ts`. **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit checkpoint** — `feat(proofServer): add stats command`; stage the four files.

### Task 13: DAPP and scripts clients

**Files:** Modify `src/app/server/RequestProof.ts`, `scripts/src/RequestProof.ts`, `.env-example` (repo root); Create `proofServer/test/client-compat.test.ts`

**Interfaces — Consumes:** `startTestServer`, `TEST_KEY` (Task 9). **Produces:** `requestProof(currentBlock, tx)` unchanged in signature, in both files.

Rules (both files, the DAPP file keeps its 4-space style):
- URL `` `${(process.env.PROOF_SERVER_URL ?? "http://localhost:3030").replace(/\/+$/, "")}/prove` ``, read inside `requestProof`.
- `Authorization: Bearer <PROOF_SERVER_API_KEY>` only when the variable is non-empty.
- Non-2xx response → read the JSON body when there is one and throw `Error("Proof server refused the request: <status> <reason> — <error>[; retry after <n> s]")`.
- Log `queued` (position, etaSec) and `started` events next to the existing `log` handling; keep the existing parsing and `done`/`error` handling.
- Root `.env-example`, appended:

```
# Proof server. Default http://localhost:3030; public instance behind Caddy: https://<name>.duckdns.org/<instance>
PROOF_SERVER_URL=http://localhost:3030
# Only for a public proof server: the key its owner gave you
PROOF_SERVER_API_KEY=
```

- [ ] **Step 1: Write the failing tests** (`proofServer/test/client-compat.test.ts`, imports `../../src/app/server/RequestProof` and `../../scripts/src/RequestProof`; the env vars are restored after each test)

```ts
test("DAPP client gets a proof from the LAN listener", ...)    // PROOF_SERVER_URL = s.lanUrl, no key → resolves deepEqual FAKE_OUT
test("DAPP client sends the key to the public listener", ...)  // PROOF_SERVER_URL = s.publicUrl, PROOF_SERVER_API_KEY = TEST_KEY → FAKE_OUT
test("DAPP client reports a refusal", ...)                      // key "wrong" → rejects /401/ and /unknown_key/
test("scripts client behaves the same", ...)                    // scripts' requestProof with s.lanUrl → FAKE_OUT
```

- [ ] **Step 2: Run** `node --import tsx --test test/client-compat.test.ts` — expected FAIL (the clients ignore `PROOF_SERVER_URL`).
- [ ] **Step 3: Implement** both clients and `.env-example`.
- [ ] **Step 4: Run** → PASS; at the repo root, `npm run lint` reports nothing new (if the DAPP dependencies are not installed on this machine, say so instead).
- [ ] **Step 5: Commit checkpoint** — `feat: proof server URL and key from environment in DAPP and scripts`; stage `src/app/server/RequestProof.ts`, `scripts/src/RequestProof.ts`, `.env-example`, `proofServer/test/client-compat.test.ts`.

### Task 14: Deploy on the mini PC and verify for real

**Files:** none (instances, sites, Caddyfile are git-ignored); update `proofServer/deploy/Caddyfile.example` only if the real one needed changes. Do it with the owner; record every step in `~/proof-server-install-notes.md`.

- [ ] **Step 1: Instances** — one `instances/<network>.env` per network (LAN 3030, 3031…; public 4030, 4031… with `PUBLIC_ENABLED=true` for public ones; node URLs from Task 0). First remove `instances/local.env` used for the smoke tests of Tasks 9–10 (it takes port 3030). `./proof-server.sh start` → each `running`. From the dev PC: `curl -s http://<mini-PC-IP>:3030/health` → `{"ok":true,…}`.
- [ ] **Step 2: Real proof over the LAN** — on a machine with `scripts/.env` configured: `cd scripts && PROOF_SERVER_URL=http://<mini-PC-IP>:3030 npx ts-node ./src/4.getProof.ts` → a proof comes back with prover lines. During the proof, `pgrep -a -g <pgid from state/slots/slot-0.json>` lists `snip36` and `starknet_transaction_prover` in one group; afterwards `pgrep -f starknet_transaction_prover` finds nothing. `./proof-server.sh stats` shows one LAN `done` with its duration.
- [ ] **Step 3: Kill check with the real prover** — start a proof, run `./proof-server.sh stop` during it → the proof finishes, the instance stops, `pgrep -f starknet_transaction_prover` finds nothing. Start again.
- [ ] **Step 4: Site key** — `./proof-server.sh site add secure-voty --sepolia 100`; the key goes to the owner only.
- [ ] **Step 5: DuckDNS (owner)** — account, subdomain, Freebox IPv4 (check the IPv4 is "full-stack", not shared, in the Free subscriber area). `getent hosts <name>.duckdns.org` → the Freebox IPv4.
- [ ] **Step 6: Freebox (owner)** — static DHCP lease for the mini PC; forwarding TCP 443 → mini PC 8443; Freebox OS remote access not on 443; no DMZ.
- [ ] **Step 7: Caddy** — install from the official Caddy apt repository; `sudo systemctl disable --now caddy`; `./proof-server.sh caddyfile --domain <name>.duckdns.org`; `caddy validate --config deploy/Caddyfile --adapter caddyfile` → `Valid configuration`; `./proof-server.sh restart` → `caddy: running`; `logs/caddy.log` reports the certificate obtained for the domain.
- [ ] **Step 8: From outside** (phone 4G tethering):
  - `curl -s https://<name>.duckdns.org/sepolia/health` → `{"ok":true,"network":"sepolia",…}`
  - `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<name>.duckdns.org/sepolia/prove` → `401`
  - `PROOF_SERVER_URL=https://<name>.duckdns.org/sepolia PROOF_SERVER_API_KEY=<key> npx ts-node ./src/4.getProof.ts` (in `scripts/`) → proof received, no prover lines
  - `./proof-server.sh site set secure-voty --sepolia 1` → the next proof gets 429 `quota_exceeded`; set it back
  - `curl -m 5 http://<Freebox IPv4>:3030/health` → times out (LAN port not exposed)
- [ ] **Step 9: Reboot drill** — `./proof-server.sh stop` → everything stopped; reboot; `./proof-server.sh status` → everything stopped; `./proof-server.sh start` → everything running; the external health check answers again.
- [ ] **Step 10: Stats** — `./proof-server.sh stats --since 1d` shows the proofs above and the rejections by category.
- [ ] **Step 11: Dev PC (owner)** — after `git pull` on the dev PC: stop the old proof server; `cd proofServer && npm install && npm run build`; create `instances/local.env` from the old `proofServer/.env` (`NETWORK`, `STARKNET_RPC_URL`, `LAN_PORT=3030`, `PUBLIC_ENABLED=false`); `./proof-server.sh setup` (the existing prover checkout is reused, only `doctor` runs); `./proof-server.sh start local`; at the repo root `npm run dev` and vote with the test credentials of `CLAUDE.md` → proof received and vote counted; `./proof-server.sh stats` shows the proof; `./proof-server.sh stop`.
- [ ] **Step 12: Commit checkpoint** — only if `deploy/Caddyfile.example` changed: `chore(proofServer): adjust Caddyfile example after deployment`.

### Task 15: Documentation

**Files:** Rewrite `proofServer/README.md`; Create `proofServer/INSTALL.md`; Delete `proofServer/.env.example`; Modify root `CLAUDE.md`, root `README.md`

- [ ] **Step 1: `INSTALL.md`** — beginner level, built from `~/proof-server-install-notes.md`, following the 8 parts of the spec § "Installation guide". Each step: why (one sentence), exact commands, expected output, what to do otherwise. Include: how to create, send, rotate and revoke a site key (and the manual `openssl` / `sha256sum` way); the ports table; the migration "old `proofServer/.env` → `instances/local.env`"; a troubleshooting section with the problems met in Tasks 0 and 14.
- [ ] **Step 2: `README.md`** (proofServer) — what it is; quick local start (setup, instance, start); one line per command; API (request, `Authorization` header, rejection table with statuses and reasons, SSE events); file layout (`instances/`, `config/`, `state/`, `logs/`, `deploy/`); link to INSTALL.md. Delete `.env.example` (replaced by `instances/example.env`).
- [ ] **Step 3: Root `CLAUDE.md`** — the sentence about the local proof server at port 3030 → the DAPP reaches the proof server at `PROOF_SERVER_URL` (default `http://localhost:3030`), possibly a public instance behind Caddy with `PROOF_SERVER_API_KEY`; the `proofServer/` row → "TypeScript proof server (queue, site keys, quotas) wrapping the snip36 prover; prover checkout ~10 GB, git-ignored"; § Proof Server commands → `./proof-server.sh setup`, `start`, `status`, `stop` + link to INSTALL.md; data-flow step 3 → "POSTs tx to the proof server (`PROOF_SERVER_URL`) via SSE stream"; remove the "Work in progress" section.
- [ ] **Step 4: Root `README.md`** — the proof server install/start part and the "port 3030" / `requestProof` part → point to `proofServer/INSTALL.md` and the two env vars.
- [ ] **Step 5: Check** — every command quoted in the docs appears in `./proof-server.sh help`; relative links resolve; `grep -rn "npm run start" proofServer/README.md proofServer/INSTALL.md CLAUDE.md README.md` finds no instruction for the old server; `npm test` → PASS; `npm run build` → exit 0.
- [ ] **Step 6: Commit checkpoint** — `docs: proof server install guide and reference`; stage `proofServer/README.md`, `proofServer/INSTALL.md`, `proofServer/.env.example` (deleted), `CLAUDE.md`, `README.md`.

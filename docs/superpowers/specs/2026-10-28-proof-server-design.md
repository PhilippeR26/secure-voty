# Internet-facing SNIP-36 proof server — design

Date: 2026-10-28
Status: approved by the owner, then refined while planning (see "Refinements made while planning").
Implementation happens on the mini PC, following `docs/superpowers/plans/2026-10-28-proof-server.md`.

## Context

The current server in `proofServer/src/` (3 files, ~190 lines) exposes `POST /prove` as an SSE stream and spawns
`snip36 prove virtual-os` for every request. It has no queue, no access control and no usable log.

Facts found in the code that shape this design:

- `snip36 prove virtual-os` starts an internal runner on `--port` (default **9900**) and **refuses to start** if
  that port is already taken. Two concurrent proofs on one machine therefore fail today.
- `snip36` relies on `kill_on_drop` to stop its runner. If `snip36` itself is killed by a signal, the runner
  (`starknet_transaction_prover`) can survive and keep port 9900, blocking every later proof.
- `snip36` does not put its runner in a separate process group: killing the process group of `snip36` also
  kills the runner.
- `snip36` reads `STARKNET_CHAIN_ID` (default `SN_SEPOLIA`) and passes it to the runner as `--chain-id`; a mainnet
  instance must therefore set `SN_MAIN`. It requires `STARKNET_ACCOUNT_ADDRESS` and `STARKNET_PRIVATE_KEY` to exist
  even when only proving. It finds its dependencies in `<SNIP36_PROJECT_DIR or working directory>/deps`, and loads a
  `.env` file from its working directory without overriding variables that are already set.
- `snip36` has its own 600 s internal timeout on the prover call.
- Temporary files are named with `Date.now()`: two requests in the same millisecond collide.
- The transaction sent to the server contains private data. In secure-voty, the `create_proof()` calldata carries
  the voter's `secret` and Merkle proof in clear. The proof server necessarily sees it; it must never persist it.
- Clients: `src/app/server/RequestProof.ts` (DAPP) and `scripts/src/RequestProof.ts` (scripts) both hard-code
  `http://localhost:3030/prove` and ignore the HTTP status.

## Goal

Replace that server — same folder `proofServer/`, same language TypeScript/Node — with a server that:

- runs continuously on the owner's mini PC (Linux Mint, 24 GB RAM, already running 3 Starknet nodes, wired to an
  old Freebox that manages port forwarding);
- is reachable from the Internet by a whitelist of authorized sites, each with a daily proof limit;
- is reachable without any restriction from the local network;
- queues requests and handles overload;
- lets the owner change the limits while it runs, with immediate effect;
- writes a size-bounded log that a command can turn into statistics;
- is launched easily from bash;
- can also run on the owner's development PC for local use, without disturbing the mini PC.

## Decisions made by the owner

- **External callers are the sites' servers** (like secure-voty's Next.js server actions), not browsers. Each site
  is identified by a **secret API key**, not by the `Origin` header (absent or forgeable server-side).
- **One instance per network** (e.g. `mainnet`, `sepolia`), each with its own port, node URL and log.
- **HTTPS through a free subdomain** (DuckDNS, e.g. `myproof.duckdns.org`) pointing to the Freebox IPv4.
- **Caddy in front** for TLS: a single public port on the Freebox, automatic Let's Encrypt certificate, routing
  `/mainnet/*` and `/sepolia/*` to the Node instances, which stay plain HTTP.
- **Daily quotas are counted in UTC** (reset at 00:00 UTC).
- **No automatic launch**: not at boot, not through a service, no restart after a crash. Stopping, rebooting and
  restarting by hand must be easy.
- Local network: **no restriction** (no key, no quota).
- **Beginner-level installation guide**, in English.
- **All repository texts in English** (code, comments, logs, CLI output, docs), like the rest of the repo.

## Designer's calls (accepted with the plan)

1. **Machine-wide slots shared by instances.** On one machine, at most `machineSlots` proofs run at the same time
   across all instances (default 1). This protects the mini PC's RAM and CPU, which the nodes also use. Slot `k` is
   held by an exclusive TCP bind on `127.0.0.1:(9800 + k)`: the kernel releases it when the holder dies, so a slot
   lock can never go stale. The proof on slot `k` uses runner port `9900 + k`. The slot holder records the proof's
   process group in `state/slots/slot-<k>.json`; whoever takes the slot next first kills that group if its owner
   died (server killed by `stop`'s SIGKILL or by the OOM killer).
2. **Local vs external is decided by the listening socket, never by IP or header.** Each instance opens two
   listeners:
   - **LAN listener** (`LAN_PORT`, e.g. 3030) bound to `0.0.0.0` (IPv4 only, so not exposed through the Freebox's
     global IPv6) and to `[::1]` (IPv6 loopback only, so that `http://localhost:3030` works whichever address
     `localhost` resolves to first). It rejects (403) any source address outside 127/8, 10/8, 172.16/12,
     192.168/16 and `::1`. No key, no quota.
   - **Public listener** (`PUBLIC_PORT`, e.g. 4030) bound to `127.0.0.1`: only Caddy can reach it. Key and quotas
     are mandatory. The client IP is the last entry of `X-Forwarded-For` set by Caddy — trusted on this listener only.
3. **One sites file shared by all instances of a machine** (`config/sites.json`), with a daily quota per network:
   "site X may run 100 proofs/day on sepolia and 5 on mainnet". A network missing from a site's quotas means the
   site is not allowed on that network. One key per site covers all networks.
4. **Quota semantics**: counted per site, per network, per UTC day. **Every launched proof counts**, successful or
   not (a failing transaction costs as much CPU). A request rejected before launch does not count. With `used` =
   proofs launched today (the running one included), a request is admitted if `used + queued(site) < quota`.
   Counters are persisted on disk.
5. **Priority**: within an instance, LAN requests go before external ones. Between external sites, first come
   first served, with at most `perSiteQueueMax` (default 2) requests queued or running per site. **LAN requests are
   never rejected for load**: `queueMax` and `maxWaitSec` apply to external requests only.
6. **External sites never receive raw prover output** (paths, versions): only `queued`, `started`, `done`,
   `error`. When a proof fails, their `error` message carries a short sanitized reason — the last non-empty error
   line of the prover, ANSI codes removed, absolute paths replaced by `<path>`, at most 300 characters — so that the
   site, and the owner in the log, can see why (e.g. `Vote is not open`). LAN clients receive everything, as today,
   including the stderr tail.
7. **Request and response format kept**: body `{blockNumber, tx}`, SSE events `log`/`done`/`error`, plus new
   events `queued` and `started`. Every accepted request receives at least one `queued` event before `started`.
   secure-voty only needs a configurable URL and an optional key.
8. **No restart after a crash** (consistent with "no automation"): `status` reports an instance that died (PID
   file present, process gone) and shows the tail of its console output.
9. **Caddy is started and stopped by the bash script, as the regular user, on port 8443.** The Freebox forwards
   public port 443 to mini PC port 8443, so no sudo is needed day to day. The script runs `caddy run` in its own
   session (like the instances), so closing the terminal does not stop it; its PID is kept in `state/caddy.pid`.
   The system Caddy service installed by `apt` is disabled once (`sudo systemctl disable --now caddy`).
10. **Prover installation unchanged** (build from source, low-memory prover), but moved out of server startup into
    an explicit `setup` command. `start` fails immediately with a clear message if the binary is missing.
11. **Wait estimate** = jobs ahead × moving average of the last 10 real proof durations (60 s before any proof).
    Jobs ahead = queued jobs before this one + proofs running in this instance. An idle server estimates 0 s.

## Refinements made while planning

Points the approved design left open or got slightly wrong, settled while writing the plan:

- `snip36` environment set by the server (chain name from `NETWORK`, dummy account, project directory) — see
  "Load and safety rules".
- Slot locks are exclusive TCP binds plus a record of the proof's process group (call 1), instead of lock files
  holding a PID, which can go stale and race.
- The LAN listener also answers on `[::1]` (call 2).
- LAN requests are never rejected for load (call 5).
- External sites get a sanitized failure reason (call 6).
- Every accepted request gets a `queued` event first (call 7).
- Caddy runs in its own session through `caddy run` (call 9); its domain is given once to
  `./proof-server.sh caddyfile --domain <name>`.
- The wait estimate counts jobs ahead, so that an idle server estimates 0 s (call 11).

## Architecture

```
Internet ── Freebox :443 ──► Caddy (mini PC :8443, TLS for the DuckDNS name, started by the script)
                                ├─ /sepolia/* ──► 127.0.0.1:4030  (sepolia instance, public listener)
                                └─ /mainnet/* ──► 127.0.0.1:4031  (mainnet instance, public listener)
LAN (192.168.x.x) ──────────────► mini PC :3030 / :3031 (LAN listeners, no key)
                                         │
                         instance queue ──► machine slot k (exclusive bind 127.0.0.1:9800+k)
                                         │
                         snip36 prove virtual-os --port 9900+k  (own process group)
                                         │
                                  Pathfinder node of that network
Dev PC: same code, instance "local", PUBLIC_ENABLED=false, LAN listener :3030 only, no Caddy.
```

The old `src/build.ts`, `src/index.ts`, `src/prove.ts` are replaced. New layout of `proofServer/`:

| Path | Role |
|---|---|
| `proof-server.sh` | bash entry point → `node dist/cli/main.js`: `setup`, `start\|stop\|restart [inst\|all]`, `status`, `stats …`, `site …`, `caddyfile --domain …` |
| `src/layout.ts` | directories and base ports of the machine (environment overrides for tests) |
| `src/instance.ts` | reads and checks `instances/<inst>.env` |
| `src/log.ts` | JSON Lines log with size-based rotation |
| `src/keys.ts` | key generation and SHA-256 hashing |
| `src/config.ts` | `config/sites.json`: validation, atomic writes, live reload |
| `src/auth.ts` | key check, IP ban after repeated failures |
| `src/quota.ts` | persisted UTC daily counters (`state/<inst>/usage.json`) |
| `src/queue.ts` | queue with LAN priority, wait estimate |
| `src/proc.ts` | process, process-group and port helpers |
| `src/slots.ts` | machine slots and orphan-proof cleanup |
| `src/prover.ts` | one `snip36` run in its own process group: timeout, kill of the whole group, outputs, cleanup |
| `src/service.ts` | admission rules, scheduling, job lifecycle |
| `src/validate.ts` | request body checks |
| `src/sse.ts` | SSE events + `: ping` comment every 15 s (keeps queued connections alive) |
| `src/rpc.ts` | `starknet_chainId` check |
| `src/app.ts` | LAN and public Express apps |
| `src/server.ts`, `src/index.ts` | startup checks, listeners, graceful stop; process entry |
| `src/cli/main.ts` | CLI dispatcher |
| `src/cli/lifecycle.ts` | `start`, `stop`, `restart`, `status` |
| `src/cli/caddy.ts` | Caddyfile generation, Caddy start and stop |
| `src/cli/site.ts`, `src/cli/stats.ts`, `src/cli/setup.ts` | `site`, `stats`, `setup` commands |
| `instances/example.env`, `config/sites.example.json`, `deploy/Caddyfile.example` | committed templates; the real files are git-ignored |
| `INSTALL.md`, `README.md` | complete beginner installation guide; reference |
| `test/` | `node:test` tests, fake `snip36` and fake `caddy` |

`instances/<inst>.env` holds `NETWORK` (`mainnet` | `sepolia`), `LAN_PORT`, `PUBLIC_PORT`, `PUBLIC_ENABLED`,
`STARKNET_RPC_URL`, and optionally `LOG_MAX_MB` (default 5), `LOG_FILES` (default 3), `SNIP36_BINARY`. The
instance name is the file name and becomes the URL prefix behind Caddy (`/<inst>/`). Changing a port or a node URL
needs a restart. Migration: the old `proofServer/.env` becomes `instances/local.env` (documented in README and
INSTALL).

All instances of a machine run from the same checkout and share one `snip36` installation (~10 GB).

## API

### `POST /prove`

Body unchanged: `{ blockNumber, tx }`, `tx` being an `INVOKE_TXN_V3`. On the public listener the request must
carry `Authorization: Bearer <key>`.

Rejections happen **before** the SSE stream starts, as JSON `{ error, reason }`:

| Status | Cases (`reason`) |
|---|---|
| 400 | invalid JSON (`invalid_json`), invalid body (`invalid_body`) |
| 401 | missing key (`missing_key`), unknown key (`unknown_key`) |
| 403 | site disabled (`site_disabled`), network not allowed for this site (`network_not_allowed`), banned IP (`banned`), non-local source on the LAN listener (`not_private`) |
| 413 | body larger than `maxBodyKB` (`body_too_large`) |
| 429 | daily quota used up (`quota_exceeded`, `Retry-After` until 00:00 UTC), too many requests queued or running for this site (`site_busy`) |
| 503 | queue full (`queue_full`), estimated wait > `maxWaitSec` (`wait_too_long`), server shutting down (`shutting_down`); `Retry-After` = estimate when known |

Then the SSE stream:

- `queued { position, etaSec }` — at least once, then again whenever the position changes;
- `started {}`;
- `log { stream, line }` — LAN listener only;
- `done { proof, proofFacts, l2ToL1Messages? }` — same payload as today;
- `error { message }` — plus `stderr` (tail of the prover's error output) for LAN clients.

If the client disconnects while queued, the request leaves the queue. If it disconnects while its proof runs,
the proof is killed (as today) and still counts against the quota.

Body validation: `type === "INVOKE"`, `version === "0x3"`, required fields present, hex strings where expected,
`calldata` ≤ 5,000 elements, `blockNumber` integer ≥ 0, body size ≤ `maxBodyKB`.

### `GET /health`

Both listeners: `{ ok, network, queueLength, running }`.

### `GET /status`

LAN listener only: running proofs, queue content (site, waiting time — no transaction data), today's usage per
site, active limits, sites without their key hashes.

## Load and safety rules

`config/sites.json`, reloaded while running:

```json
{
  "limits": {
    "machineSlots": 1, "queueMax": 10, "perSiteQueueMax": 2,
    "maxWaitSec": 900, "proofTimeoutSec": 600, "maxBodyKB": 256,
    "badKey": { "maxFailures": 10, "windowMin": 10, "banMin": 60 }
  },
  "sites": {
    "secure-voty": {
      "keySha256": "…", "enabled": true,
      "perDay": { "sepolia": 100, "mainnet": 5 },
      "note": "contact…"
    }
  }
}
```

- Wait estimate: see designer's call 11.
- `snip36` environment: the server sets `STARKNET_RPC_URL`, `STARKNET_CHAIN_ID` (`SN_MAIN` / `SN_SEPOLIA` from
  `NETWORK`), dummy `STARKNET_ACCOUNT_ADDRESS` and `STARKNET_PRIVATE_KEY` (`0x1`), `SNIP36_PROJECT_DIR` = the prover
  checkout, and runs `snip36` with that checkout as working directory.
- Proof timeout (`proofTimeoutSec`) → kill the **whole process group** (`spawn` with `detached: true`, then
  `process.kill(-pid)`), so that no `starknet_transaction_prover` runner is ever left holding port 9900+k. When
  `snip36` exits, whatever remains of its group is killed too. At startup, orphan proofs of dead servers are killed.
- Startup checks: binary present, config valid, node reachable, and `starknet_chainId` matching `NETWORK`
  (`SN_MAIN` / `SN_SEPOLIA`). Any failure stops the server with a clear message.
- Graceful shutdown (SIGTERM, sent by `stop`): new requests get 503, queued requests get an `error` event, the
  running proof gets up to 60 s to finish and is then killed, the slot is released. `stop` sends SIGKILL if the
  process is still alive after 75 s, then kills the orphan proof if any.
- Temporary transaction file: random name, mode 0600, inside a 0700 directory, deleted on every path; the
  directory is purged at startup. **The transaction, the key and the signature are never written to the log.**
- The queue lives in memory (lost on stop; clients see their connection close). Quota counters are persisted.

## Live configuration changes

- Watch the **directory** `config/` (editors replace the file rather than write into it), plus a fallback re-read
  every 5 s.
- Invalid or missing file → keep the previous configuration, write a `config_error` event to the log.
- Immediate effect: the next request sees the new limits; queued requests of a site that was disabled or removed
  are rejected with an `error` event; a proof already running continues; a lower `machineSlots` applies as soon as
  a slot frees up.
- Two ways to change it: edit the JSON by hand, or use the `site` commands below.

## Site keys

- `./proof-server.sh site add <name> [--sepolia N] [--mainnet N] [--note "…"]` draws 32 random bytes
  (`crypto.randomBytes`), encodes them as base64url, **prints the key once**, and stores only its SHA-256 hash in
  `config/sites.json`. Reading that file does not reveal any key.
- `site set <name> --sepolia 100 --mainnet 5` (`off` removes a network), `site disable|enable|remove <name>`,
  `site rotate-key <name>` (new key, the old one is refused immediately), `site list` (with today's usage).
- Without the command: `openssl rand -base64 32` makes a key, `printf %s "<key>" | sha256sum` gives its hash.
- Site side: the key goes into the `PROOF_SERVER_API_KEY` environment variable of the site's server. The owner
  sends it through a private channel (never a git repository, never a plain email). `INSTALL.md` explains all of it.

## Log and statistics

- One file per instance, `logs/<inst>.log`, JSON Lines, rotated at `LOG_MAX_MB` (5 MB) keeping `LOG_FILES` (3)
  old files → at most 20 MB per instance. The background process console output goes to `logs/<inst>.stdout`,
  truncated at each `start` (startup messages and crashes only).
- One line per event with `ts, inst, ev, reqId, site | "lan", ip, reason, waitMs, durMs, queueLen, msg`.
  Events: `request`, `reject`, `queued`, `start`, `done`, `fail`, `abort`, `timeout`, `ban`, `config_reload`,
  `config_error`, `startup`, `shutdown`.
- `./proof-server.sh stats [--since 7d | --day 2026-10-28] [--site X] [--instance sepolia] [--json]` reads the
  current and rotated files and prints, per site and per UTC day: requests, successful proofs, failures,
  rejections by category (auth, quota, overload, invalid), median and p95 duration, median and max wait. Globally:
  peak queue length, timeouts, busiest hour.

## Operations (manual only)

- `./proof-server.sh setup`: clones and builds `snip36` and its dependencies (~10 GB, ~20 min), once per machine.
- `./proof-server.sh start [inst|all]`: starts the instance(s) from `instances/*.env` in the background, each in its
  own session (PID in `state/<inst>.pid`); waits for `/health` and prints the result; refuses to start an instance
  that is already running. Then, if at least one public instance runs, starts Caddy — or, without
  `deploy/Caddyfile`, says to run `./proof-server.sh caddyfile --domain <name>` first.
- `./proof-server.sh stop [inst|all]`: graceful stop (see above); Caddy is stopped when no public instance is left
  running. `restart` = `stop` + `start`.
- `./proof-server.sh status`: for each instance, running / stopped / crashed, ports, queue, running proof, today's
  usage; Caddy state.
- After a reboot nothing runs: `./proof-server.sh start` brings everything back.
- `./proof-server.sh caddyfile --domain myproof.duckdns.org`: generates `deploy/Caddyfile` from `instances/*.env`
  (port 8443, body size limit, rotated Caddy log, certificate storage under `state/caddy`).
- **Freebox**: forward TCP public 443 → mini PC 8443 (Let's Encrypt TLS-ALPN challenge; port 80 not needed).
- **Ports used on the machine**: LAN listeners (3030, 3031…), public listeners on 127.0.0.1 (4030, 4031…), slot
  locks 9800+k and runners 9900+k on 127.0.0.1, Caddy 8443 (HTTPS), 8080 (HTTP, not forwarded) and 2019 (admin,
  localhost). Only 443 → 8443 is forwarded.
- **Dev PC**: `instances/local.env` with `PUBLIC_ENABLED=false`, `LAN_PORT=3030`. Its slots and queue belong to
  that PC; it does not touch the mini PC (except RPC reads if its node URL points to a mini PC node).

## Installation guide (`proofServer/INSTALL.md`, English, beginner level)

Step by step, every command ready to copy-paste, with the expected output and what to do if it differs.
Nodes are out of scope.

1. What you will get (diagram); what you need (Linux Mint, free RAM, 10 GB disk, Pathfinder node ≥ 0.22.2).
2. Prerequisites: `git`, `build-essential`, Node.js ≥ 22 (exact install method), the Rust stable and nightly
   toolchains required by `snip36`, Python 3.12.
3. Get the repository, `npm install`, `npm run build`, `./proof-server.sh setup`.
4. Create an instance (`instances/example.env` → `instances/sepolia.env`); first LAN test with `curl`.
5. Add a site and generate its key; send it; change a quota while the server runs.
6. Go public: DuckDNS account + subdomain + Freebox IPv4; Freebox OS port forwarding 443 → mini PC 8443; fixed LAN
   IP for the mini PC (static DHCP lease on the Freebox); install Caddy with `apt`, disable its service,
   `./proof-server.sh caddyfile --domain …`. Checks: "full-stack" (not shared) IPv4 in the Free subscriber area;
   port 443 not used by Freebox OS remote access; no DMZ pointing to the mini PC.
7. Start, stop, restart after a reboot; test from outside (phone 4G tethering).
8. Read stats and log; common problems (port 9900 busy, node unreachable, chainId mismatch, certificate not
   obtained, quota exhausted).

## DAPP, scripts and docs

- `src/app/server/RequestProof.ts` and `scripts/src/RequestProof.ts`: URL from `PROOF_SERVER_URL` (default
  `http://localhost:3030`), optional `PROOF_SERVER_API_KEY` → `Authorization` header, clear error on a non-2xx
  response (reason + `Retry-After`), log `queued` / `started` events.
- Root `.env-example`: these two variables.
- `proofServer/README.md` rewritten (points to `INSTALL.md`); `CLAUDE.md` and root `README.md` updated where they
  describe the proof server (port 3030, start commands, data flow).

## Out of scope

- Any automatic launch (boot, service, restart after crash).
- Self-service site registration, web admin interface, billing.
- Batching several transactions into one proof (a SNIP-36 virtual block holds one transaction); "pooling" means the
  queue.
- A queue that survives a stop.
- Securing the Pathfinder nodes themselves.
- Switching to prebuilt binaries (`snip36 setup --prebuilt`) — possible later improvement.

## Left to the builder

Exact wording of messages, layout of the `stats` and `status` output.

## Verification

- **Unit tests**: config validation and reload; quota across 00:00 UTC and across a restart; LAN priority, per-site
  cap, wait estimate; key hashing and IP ban; log rotation; stats on a hand-made log (expected numbers computed by
  hand in the test).
- **Integration tests with a fake `snip36`** (`SNIP36_BINARY=test/fake-snip36.sh`: waits N s then writes the three
  output files, or fails, or never ends): full SSE flow; 3 requests → one at a time, the others get `queued`;
  timeout → process group killed, port freed; two instances on the same machine → one proof at a time; editing
  `sites.json` while running → quota applied to the next request; 10 wrong keys → ban; `start` twice → refused;
  `stop` during a proof → graceful stop, no `snip36` or runner process left (`pgrep`); server killed with SIGKILL
  during a proof → orphan killed at the next start.
- **Real, on the dev PC**: `./proof-server.sh start local`, then a secure-voty vote (`npm run dev`, test credentials
  from `CLAUDE.md`) → proof received and vote counted; `./proof-server.sh stats` shows the proof.
- **Real, on the mini PC** (check free RAM first with `free -g`, nodes running): two instances + Caddy started by
  `start`; from outside (phone 4G tethering)
  `curl -N -H "Authorization: Bearer <key>" https://myproof.duckdns.org/sepolia/prove -d @tx.json`
  → `queued` / `started` / `done`; without key → 401; quota set to 1 → second request gets 429;
  `curl http://<mini-PC-LAN-IP>:3030/health` from the dev PC → 200; the same address from outside → unreachable;
  `stop`, reboot, `start` → everything comes back.

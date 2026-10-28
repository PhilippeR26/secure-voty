# SNIP-36 proof server

A server that executes a signed Starknet transaction **virtually** and returns a zero-knowledge proof of that
execution (SNIP-36). It is generic: it proves any V3 `INVOKE` transaction. It wraps
the `snip36` prover of [snip-36-prover-backend](https://github.com/starknet-innovation/snip-36-prover-backend).

It is meant to be run by hand on a machine you control, and can be opened to the Internet:

- one **instance** per Starknet network (`mainnet`, `sepolia`), each with its own node and ports;
- a **LAN listener** (your local network only: no key, no quota) and an optional **public listener** (through
  HTTPS: an API key per **site** and a daily quota per network);
- a **queue**: one proof at a time on the machine (setting `machineSlots`), local requests first;
- a **JSON Lines log** with a `stats` command, and a Caddy configuration generator for HTTPS.

Nothing starts by itself (not at boot, not after a crash). You start and stop it with `./proof-server.sh`.

**Linux only.** It relies on features of Linux (`/proc`) and was tested on Linux Mint 22.3 (Ubuntu 24.04 base).
macOS and Windows are not supported.

> **Full installation guide, step by step, from a blank Linux machine to a public HTTPS server: [INSTALL.md](INSTALL.md).**
> This README is the reference: what each command does, the API, and the layout of the files.

## Architecture

```
Internet ── your box :443 ──► Caddy (this machine :8443, HTTPS certificate)
                                ├─ /sepolia/* ──► 127.0.0.1:4030  (instance "sepolia", public listener: key + quota)
                                └─ /mainnet/* ──► 127.0.0.1:4031  (instance "mainnet", public listener: key + quota)
Local network ──────────────► this machine :3030 / :3031 (LAN listeners: no key, no quota)
                                          │
                       queue ──► machine slot ──► snip36 prove (own process group)
                                          │
                                   your Starknet node of that network
```

### Processes

| Process | Started by | Role |
|---|---|---|
| `./proof-server.sh <command>` | you | the commands; it exits when the command is done |
| `node dist/index.js <instance>` | `start` (one per instance, in the background) | one network: its two listeners, its queue, its log; pid in `state/<instance>.pid` |
| `caddy` | `start`, when an instance is public | HTTPS on port 8443, one route `/<instance>/*` per public instance; pid in `state/caddy.pid` |
| `snip36 prove virtual-os` | an instance, for each proof | the prover, in its own process group with its runner (port 9900 + slot number); the whole group is stopped together |

The two listeners of an instance are chosen by the socket a request arrives on, never by a header: the LAN listener
on `LAN_PORT` of all IPv4 addresses and of `::1` (private callers only), the public listener on `127.0.0.1:PUBLIC_PORT` (Caddy only).

The **machine slots** are shared by all instances: a slot is held by binding the port 9800 + slot number on
`127.0.0.1`, which the system frees when the holder dies, so a crashed instance never keeps its slot. With
`machineSlots` = 1, the machine runs one proof at a time, whatever the number of instances.

### Life of a request

1. The listener receives `POST /prove`. On the public listener, the key is checked (`401`, `403 banned` after too many
   wrong keys), then the site's permission for this network (`403`).
2. The body is checked: size, JSON, fields of a V3 `INVOKE` transaction (`413`, `400`). Only the known fields are
   kept.
3. Admission, public requests only: daily quota, requests of the site, queue length, estimated wait (`429`, `503`).
   Local requests are never refused for load.
4. The request enters the queue (local requests first) and receives `queued` events with its position and estimated
   wait.
5. When a machine slot is free, the instance writes the transaction to a private file in `tmp/<instance>/`, runs
   `snip36 prove virtual-os` at the requested block against its node, and sends `started`.
6. At the end, it reads the files the prover wrote, deletes them, and sends `done` with the proof, or `error` with a
   cleaned reason. The log gets one line per step (`request`, `queued`, `start`, `done`, `fail`…), never the
   transaction.

`config/sites.json` is read again within 5 seconds of a change; the instance files are read only at start.

## Quick start (local network only)

Requires Linux, Node.js 22 or newer, Rust, and a Starknet node. The prerequisites are listed in
[INSTALL.md](INSTALL.md#2-prerequisites).

```bash
cd proofServer
npm install && npm run build
./proof-server.sh setup                              # once: builds the prover (about 8 GB, 20 to 30 minutes)
cp instances/example.env instances/sepolia.env       # then set NETWORK and STARKNET_RPC_URL in it
./proof-server.sh start sepolia
curl http://127.0.0.1:3030/health                    # {"ok":true,"network":"sepolia","queueLength":0,"running":0}
```

Then point the client at it. The DAPP and the scripts of this repository read two environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PROOF_SERVER_URL` | `http://localhost:3030` | base address of the instance, without `/prove`. For a public instance: `https://<name>/sepolia` |
| `PROOF_SERVER_API_KEY` | none | key of the site; sent as `Authorization: Bearer <key>`. Not needed on the LAN listener. |

## Commands

Every command is `./proof-server.sh <command> [arguments]`. `./proof-server.sh help` lists them.
`<instance>` is the name of a file of `instances/` without `.env`; `all` (the default) means every instance.

### `setup`

Builds the prover. Run it **once per machine**, after `npm install` and `npm run build`. It runs four steps and
tells which one it is on:

1. clones `snip-36-prover-backend` into `proofServer/snip-36-prover-backend/` (git-ignored);
2. builds its command-line tool `snip36` (`cargo build --release -p snip36-cli`);
3. runs `snip36 setup`: Rust toolchains, proving utilities, sequencer, Python virtual environment, Sierra compiler
   (about 8 GB of disk, 20 to 30 minutes), only if something is missing;
4. checks everything with `snip36 doctor`. A working installation ends with `RESULT: PROVING STACK READY`.

It can be run again at any time: it skips what is done and resumes an interrupted installation.
It **never updates** `snip36` or the prover. To update them: `stop`, delete `snip-36-prover-backend/`, run `setup`
again, then `start` and check with one real proof; details in
[INSTALL.md, section 9](INSTALL.md#9-updating-snip36-and-the-prover). To lower the load
on a machine that also runs nodes: `CARGO_BUILD_JOBS=4 nice -n 19 ./proof-server.sh setup`. When a step fails, the
last lines say why; the failures already met are in [INSTALL.md, section 8](INSTALL.md#8-statistics-logs-and-common-problems).

### `start [<instance>|all]`

Starts the instance (or all of them) in the background, then waits up to 60 seconds for it to answer. Before it
starts serving, the instance checks that:

- `snip36` is built (`setup` was run);
- `config/sites.json` is valid when it exists (without it: no site, default limits);
- its node answers, at `STARKNET_RPC_URL` of `instances/<instance>.env`;
- **the node is on the network set by `NETWORK`** in the same file: the instance asks the node for its chain ID
  (`starknet_chainId`) and compares it with the one of that network (`SN_SEPOLIA` or `SN_MAIN`). A node of the other
  network would give proofs that are useless on-chain;
- its ports are free.

If a check fails, the instance does not start and the reason is printed, for instance
`node http://127.0.0.1:6060/v0_10 is on SN_MAIN, but instances/sepolia.env says NETWORK=sepolia (SN_SEPOLIA)`.
On success:

```
sepolia: running (pid 1263179) — LAN http://192.168.1.26:3030, public 127.0.0.1:4030
caddy: running (pid 1263186)
```

When at least one started instance has `PUBLIC_ENABLED=true`, Caddy is started too (it needs `deploy/Caddyfile`:
see [`caddyfile`](#caddyfile---domain-name)). A proof left behind by a server that died is stopped first. Starting an instance that is already
running changes nothing.

### `stop [<instance>|all]`

Stops gracefully. **A proof that is running is allowed to finish** (up to 60 seconds, then it is stopped); requests
waiting in the queue receive an error (`Server is shutting down`). The command returns when the instance has
stopped. Caddy stops when no public instance is left running, so `stop sepolia` leaves Caddy up while `mainnet`
is public and running.

### `restart [<instance>|all]`

`stop`, then `start`, with the same arguments. Needed after editing `instances/<name>.env` (the instance files are
read at start; `config/sites.json` is not concerned, see [`site`](#site-command)).

### `status`

State of every instance and of Caddy:

```
mainnet (mainnet): running, pid 1263167 — LAN port 3031, public 127.0.0.1:4031
  proofs running: 0, queue: 0
sepolia (sepolia): running, pid 1263179 — LAN port 3030, public 127.0.0.1:4030
  proofs running: 0, queue: 0
  today (UTC): secure-voty 1/100
caddy: running (pid 1263186)
```

An instance is `running`, `stopped`, or `crashed` (its process is gone but it was not stopped by `stop`): the last
lines of its console output are then shown, and `start` repairs it. `today (UTC)` gives, for each site, the proofs
used out of its quota on that network.

### `stats [options]`

Statistics read from `logs/*.log`, one line per day and per site.

| Option | Effect |
|---|---|
| (none) | everything kept in the logs |
| `--since 7d` or `--since 12h` | the last 7 days / 12 hours |
| `--day 2026-10-28` | one UTC day. `--since` and `--day` cannot be combined. |
| `--site <name>` | only that site (`lan` is the pseudo-site of the calls from your local network) |
| `--instance <name>` | only that instance |
| `--json` | the same figures as JSON, for a script |

```
day         site         requests  done  failed  timeouts  aborted  rejected  duration med / p95  wait med / max
2026-10-28  (unknown)    0         0     0       0         0        3/0/0/0   - / -               - / -
2026-10-28  lan          3         2     1       0         0        0/0/0/0   42.4 s / 48.7 s     1 ms / 1 ms
2026-10-28  secure-voty  1         1     0       0         0        0/0/0/0   38.2 s / 38.2 s     1 ms / 1 ms

rejected = authentication / quota / overload / invalid request
peak queue: 1, timeouts: 0, busiest hour: 2026-10-28T16 UTC
```

`(unknown)` groups the requests refused before a site could be identified (no key, wrong key). `duration` is the time
of a proof, `wait` the time spent in the queue (median / 95th percentile, or median / maximum). The log of Caddy is
not counted.

### `site <command>`

Manages the sites allowed to use the **public** listener. A site has a secret key and a daily quota (UTC day) per
network. The result is written to `config/sites.json`, which stores only a SHA-256 hash of each key. **Running
instances apply the change within 5 seconds, without a restart**; the whole file is checked before it is written.

| Command | Effect |
|---|---|
| `site add <name> [--sepolia N] [--mainnet N] [--note TEXT]` | creates the site with `N` proofs per day (a whole number, 0 or more) on each network given. The key is **shown once** on the screen: copy it at once and send it to the site owner through a private channel. Without `--sepolia` or `--mainnet`, the site exists but may use no network. Refused if the name already exists (use `set` or `rotate-key`). |
| `site set <name> [--sepolia N\|off] [--mainnet N\|off] [--note TEXT]` | changes a quota; `off` removes the permission for that network. Options not given are unchanged. |
| `site enable <name>` / `site disable <name>` | restores / cuts the access without losing the settings. A disabled site is refused with `site_disabled`. |
| `site remove <name>` | deletes the site. Its key stops working. |
| `site rotate-key <name>` | creates a new key (shown once) and **refuses the old one at once**. Use it when a key is lost or has leaked. |
| `site list` | each site, `enabled` or `disabled`, and today's use of its quotas: `secure-voty  enabled  sepolia 1/100` |

For `disable`, `remove` and for a quota set to `off`, the requests of that site that are **waiting in the queue**
(public listener) are cancelled (`Access for this site was revoked`); a proof already running goes on. After
`rotate-key`, only the new key is accepted, but requests already accepted keep their place.

The same file holds the `limits` of the machine (queue, timeouts, bans), edited by hand: see
[`config/sites.json`](#configsitesjson) below. The key can also be made and hashed without the command: see
[INSTALL.md, section 5](INSTALL.md#5-sites-keys-and-quotas).

### `caddyfile --domain <name>`

Generates `deploy/Caddyfile`, the configuration of Caddy, from the instance files: one route
`/<instance>/*` to the public port of each instance that has `PUBLIC_ENABLED=true`. `<name>` is your public name,
for instance `myproof.duckdns.org`. It prints the public addresses and reminds you to forward the TCP port 443 of
your box to port 8443 of this machine. Run it again whenever a public instance is added or removed, then
`restart`. An example of the result is [deploy/Caddyfile.example](deploy/Caddyfile.example). The whole public
setup (DuckDNS, box, Caddy) is described in [INSTALL.md, section 6](INSTALL.md#6-go-public-duckdns-your-box-caddy).

### `help`

Prints the list of commands.

## API

Each instance serves the same routes on its two listeners. The LAN listener is `http://<machine>:<LAN_PORT>`; the
public one is `https://<name>/<instance>` (through Caddy), so `https://myproof.duckdns.org/sepolia/prove`.

| Route | Listener | Role |
|---|---|---|
| `POST /prove` | both | asks for a proof; the answer is a stream of events |
| `GET /health` | both | `{"ok":true,"network":"sepolia","queueLength":0,"running":0}` |
| `GET /status` | LAN only | queue, running proofs, sites and their use today (used by `status`) |

The listener is chosen by the **socket** the request arrives on, never by a header. The LAN listener refuses a
caller that is not on a private address (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `::1`) with `403 not_private`.
The public listener only accepts connections from the machine itself (Caddy).

### Request

```
POST /prove
Content-Type: application/json
Authorization: Bearer <key of the site>      (public listener only)

{ "blockNumber": 123456, "tx": { …signed INVOKE V3 transaction… } }
```

- `blockNumber`: the block whose state the virtual transaction starts from (an integer).
- `tx`: a signed transaction of type `INVOKE_TXN_V3`. In JavaScript, `account.getSignedTransaction()` of
  starknet.js builds it without sending it. Only the known fields are read; hex values must be felts.
- Only `Content-Type: application/json` is parsed (a web page cannot reach the key-less LAN listener with a
  plain form post).

Example of `tx`:

```json
{
  "type": "INVOKE",
  "sender_address": "0x0304c822792da45bf6f8e6957aa9515bd7b365f05b5c1678f61ae0c46213251c",
  "calldata": ["0x1", "0x62751c14ff5d186f1ec837c7c45345fe555b8eba5e89c641bcb429d748f8f6a", "0x1ebfe9bbcb97616537f1b99138aa084dcca02847d532d6c382752811a326f3", "0x0"],
  "signature": [
    "0x784ee0ec157e7a28ad43138377787489274513c70f4f6f00934faa7787c5612",
    "0x1723332a3c546a15cc5397e9ab950ca214b49c6754040232806e889dd5904c"
  ],
  "nonce": "0x1c6",
  "resource_bounds": {
    "l2_gas": { "max_amount": "0x1ef0e4", "max_price_per_unit": "0x2cb417800" },
    "l1_gas": { "max_amount": "0xacfe", "max_price_per_unit": "0x51bff50bf0f0" },
    "l1_data_gas": { "max_amount": "0xc0", "max_price_per_unit": "0x266b20e4fcc" }
  },
  "tip": "0x0",
  "paymaster_data": [],
  "nonce_data_availability_mode": "L1",
  "fee_data_availability_mode": "L1",
  "account_deployment_data": [],
  "version": "0x3"
}
```

In TypeScript, the client of this repository does all of it: [scripts/src/RequestProof.ts](../scripts/src/RequestProof.ts)
(`requestProof(currentBlock, tx)`), which reads `PROOF_SERVER_URL` and `PROOF_SERVER_API_KEY`.

### Answer: refusal

A request that is refused gets a JSON body `{"reason": "…", "error": "…"}` before any stream, with the header
`Retry-After` (seconds) when the delay is known.

| Status | `reason` | Meaning |
|---|---|---|
| 400 | `invalid_json`, `invalid_body` | not JSON, or not a valid proof request (the message names the field, never its value) |
| 401 | `missing_key`, `unknown_key` | no `Authorization` header, or a key the server does not know |
| 403 | `site_disabled` | the site is disabled |
| 403 | `network_not_allowed` | the site has no quota on this network |
| 403 | `banned` | the address sent too many wrong keys (banned for 60 min by default) |
| 403 | `not_private` | LAN listener called from a non-private address |
| 413 | `body_too_large` | larger than `maxBodyKB` |
| 429 | `quota_exceeded` | daily quota used up; `Retry-After` runs to 00:00 UTC |
| 429 | `site_busy` | the site already has `perSiteQueueMax` requests waiting or running |
| 503 | `queue_full`, `wait_too_long`, `shutting_down` | the server is busy or stopping |

### Answer: stream of events

An accepted request gets `200` with `Content-Type: text/event-stream`: lines `event: <name>` then `data: <JSON>`,
separated by a blank line.

| Event | `data` | Sent |
|---|---|---|
| `queued` | `{"position": 2, "etaSec": 90}` | when the request waits; again when its position changes |
| `started` | `{}` | the proof begins |
| `log` | `{"stream": "stdout"\|"stderr", "line": "…"}` | the output of the prover, **LAN listener only** |
| `done` | `{"proof": "…", "proofFacts": ["0x…"], "l2ToL1Messages": […]}` | the proof is ready (`l2ToL1Messages` when the transaction sent some) |
| `error` | `{"message": "…"}`, plus `"stderr"` on the LAN listener | the proof failed, timed out, was cancelled, or the server stops |

`etaSec` is the number of jobs ahead multiplied by the average of the last 10 proof times (60 s until a first
proof is done). A proof takes 38 to 49 seconds on the reference machine.

Take the proof and `proofFacts` from `done` and pass them to the contract: in secure-voty,
`account.execute(verify_vote calldata, { proof, proofFacts })`.

## Configuring an instance

`instances/<name>.env`; the name of the file is the name of the instance (lowercase letters, digits, dashes; `caddy`
is reserved). Start from [instances/example.env](instances/example.env).

| Variable | Meaning | Default |
|---|---|---|
| `NETWORK` | `mainnet` or `sepolia`; must be the network of the node | required |
| `STARKNET_RPC_URL` | JSON-RPC address of your node, spec 0.10 | required |
| `LAN_PORT` | port of the LAN listener: a free port of your choice (e.g. `3030`, `3031` for a second instance); the one clients of your local network call | required |
| `PUBLIC_ENABLED` | `true` opens the public listener | `false` |
| `PUBLIC_PORT` | port of the public listener: a free port of your choice (e.g. `4030`), different from `LAN_PORT`. Bound to `127.0.0.1`, so only Caddy reaches it; `caddyfile` reads it (run it again after a change). Never forward it on your box | required when public |
| `LOG_MAX_MB`, `LOG_FILES` | size of a log file, number of old files kept | 5, 3 |
| `SNIP36_BINARY` | another `snip36` program | the one built by `setup` |

## `config/sites.json`

The sites allowed on the public listeners, and the limits of the whole machine. One file for all instances. It is
written by `./proof-server.sh site …`, but you may edit it by hand: every running instance reads it again within 5
seconds of a change. Start from [config/sites.example.json](config/sites.example.json).

```json
{
  "limits": {
    "machineSlots": 1, "queueMax": 10, "perSiteQueueMax": 2,
    "maxWaitSec": 900, "proofTimeoutSec": 600, "maxBodyKB": 256,
    "badKey": { "maxFailures": 10, "windowMin": 10, "banMin": 60 }
  },
  "sites": {
    "secure-voty": {
      "keySha256": "3f9a…64 hexadecimal characters…",
      "enabled": true,
      "perDay": { "sepolia": 100, "mainnet": 5 },
      "note": "my voting demo"
    }
  }
}
```

### `limits`

Every field is optional; a missing one takes its default.

| Field | Default | Accepted | Meaning |
|---|---|---|---|
| `machineSlots` | 1 | 1 to 8 | proofs at the same time on the whole machine, all instances together. A proof used up to 1.6 GB of memory. |
| `queueMax` | 10 | 0 or more | requests waiting on one instance, **local ones included**. When it is reached, public requests are refused (`503 queue_full`); local ones are always accepted. |
| `perSiteQueueMax` | 2 | 1 or more | requests of one site waiting **or running** on one instance. Above it: `429 site_busy`. |
| `maxWaitSec` | 900 | 1 or more | a public request is refused (`503 wait_too_long`) when its estimated wait is longer |
| `proofTimeoutSec` | 600 | 1 or more | a proof is stopped after this time |
| `maxBodyKB` | 256 | 1 to 10240 | largest request accepted (`413 body_too_large`) |
| `badKey.maxFailures`, `badKey.windowMin`, `badKey.banMin` | 10, 10, 60 | 1 or more | `maxFailures` wrong keys from one address within `windowMin` minutes ban it for `banMin` minutes (`403 banned`) |

`queueMax` and `perSiteQueueMax` do not overlap: with 2 sites, the public requests can never exceed 2 × 2 = 4, so
`queueMax` is a ceiling for the day there are more sites (or many local requests waiting).

### `sites`

The name of each entry is the name of the site: letters, digits, `.`, `_` and `-`, at most 64 characters, starting
with a letter or a digit.

| Field | Required | Meaning |
|---|---|---|
| `keySha256` | yes | SHA-256 of the key, 64 lowercase hexadecimal characters. The key itself is stored nowhere. |
| `enabled` | yes | `false` refuses the site (`403 site_disabled`) without losing its settings |
| `perDay` | yes | proofs per UTC day on each network: `sepolia`, `mainnet`. A network that is absent is not allowed (`403 network_not_allowed`). The requests already waiting count against the quota. |
| `note` | no | free text, shown by `site list` |

### Rules of reading

- An **unknown field is refused**, so that a misspelling (`"enable"` for `"enabled"`) does not go unnoticed.
- When the file is not valid, the error is written to the log of each running instance (event `config_error`) and
  **the previous settings stay in force**.
- Requests already waiting of a site that is disabled, removed, or no longer allowed on the network are cancelled; a
  running proof goes on.
- The file is not in git: keep a copy of it with your backups.

## Files

| Path | Content | In git |
|---|---|---|
| `src/` | the server and its commands (TypeScript), built into `dist/` | yes |
| `test/` | tests (`npm test`) with a fake prover and a fake Caddy | yes |
| `proof-server.sh` | the entry point of all commands | yes |
| `instances/` | `<name>.env`, one per instance; `example.env` is the template | only `example.env` |
| `config/` | `sites.json` (limits, sites, hashes of keys); `sites.example.json` | only the example |
| `deploy/` | `Caddyfile` generated by `caddyfile`; `Caddyfile.example` | only the example |
| `state/` | process numbers, daily counters, slot records, Caddy's certificate and keys | no |
| `logs/` | `<instance>.log` (JSON Lines), `<instance>.stdout` (startup and crashes), `caddy.log` | no |
| `tmp/` | temporary files of the proofs running | no |
| `snip-36-prover-backend/` | the prover, built by `setup` (about 8 GB) | no |

Development: `npm test` runs the tests, `npm run build` compiles to `dist/` (the commands need it).
`PROOF_SERVER_DEV=1 ./proof-server.sh start` starts the instances from the TypeScript sources of `src/`, so a change
is taken into account without a build.

## Privacy

A transaction holds secrets (in secure-voty, the voter's secret is in the calldata). The transaction, the
signatures and the keys are **never** written to `logs/`, nor to the console. The file given to the prover is
readable by your user only and deleted when the proof ends. The reason of a failure is cleaned before it is logged
(paths replaced, transaction values masked, 300 characters at most). The public listener never returns the output
of the prover, only a short reason.

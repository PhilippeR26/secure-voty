# Installing the SNIP-36 proof server

This guide installs the proof server of this repository on a Linux machine, step by step, and (optionally) makes
it reachable from the Internet. It assumes that you can open a terminal and type commands, nothing more.

Every step says **why** you do it, gives the **exact commands**, shows **what you should see**, and tells you
**what to do if you see something else**. The outputs shown were obtained on the machine the server was built
on (Linux Mint 22.3, 16 cores, 23 GB of RAM).

Contents

1. [What you will get, what you need](#1-what-you-will-get-what-you-need)
2. [Prerequisites](#2-prerequisites)
3. [Get the code and build the prover](#3-get-the-code-and-build-the-prover)
4. [Create an instance and test it on your network](#4-create-an-instance-and-test-it-on-your-network)
5. [Sites, keys and quotas](#5-sites-keys-and-quotas)
6. [Go public: DuckDNS, your box, Caddy](#6-go-public-duckdns-your-box-caddy)
7. [Daily use: start, stop, restart](#7-daily-use-start-stop-restart)
8. [Statistics, logs, and common problems](#8-statistics-logs-and-common-problems)
9. [Updating snip36 and the prover](#9-updating-snip36-and-the-prover)
10. [Appendix: ports, files, migration from the old server](#10-appendix-ports-files-migration-from-the-old-server)

Parts 1 to 4 give a working server **on your local network** only. Parts 5 to 7 are needed only if sites
outside your network must use it.

## 1. What you will get, what you need

A **proof server** receives a signed Starknet transaction, executes it virtually, and returns a zero-knowledge
proof of that execution (SNIP-36). The transaction can hold secrets (in secure-voty, the voter's secret), so the
server must be under your control. It is generic: it proves any V3 invoke transaction.

```
Internet ── your box :443 ──► Caddy (this machine :8443, HTTPS certificate)
                                ├─ /sepolia/* ──► 127.0.0.1:4030  (instance "sepolia", public listener: key + quota)
                                └─ /mainnet/* ──► 127.0.0.1:4031  (instance "mainnet", public listener: key + quota)
Local network ──────────────► this machine :3030 / :3031 (LAN listeners: no key, no quota)
                                          │
                       queue ──► one proof at a time ──► snip36 prove (own process group)
                                          │
                                   your Starknet node of that network
```

Words used below:

| Word | Meaning |
|---|---|
| **instance** | one server process for one network (`sepolia`, `mainnet`). Its name is the name of its file in `instances/`. |
| **LAN listener** | the port of an instance open to your local network only: no key, no quota. |
| **public listener** | the port reachable only through Caddy: a key and a daily quota are required. |
| **site** | a program allowed to use the public listener (for example the server of secure-voty). Each site has a secret key and a daily quota per network. |
| **node** | a Starknet node (Pathfinder or Juno) that you run yourself. Installing nodes is out of scope here. |
| **Caddy** | a web server that obtains and renews the HTTPS certificate by itself and routes `/sepolia/…` and `/mainnet/…` to the instances. |
| **DuckDNS** | a free service that gives you a name such as `myproof.duckdns.org` pointing to the public address of your box. |

What you need:

- A Linux machine. Tested: Linux Mint 22.3 (Ubuntu 24.04 base). The commands use `apt`.
- Memory: a proof used up to **1.6 GB** (peak seen on the runner process, sampled every 2 seconds). Keep at least
  4 GB free, more if your nodes run on the same machine.
- Disk: **8 GB** for the prover once built (7.1 GB of it in `deps/`). Keep 10 GB free.
- Time: the build of the prover takes **20 to 30 minutes** on a 16-core machine.
- One Starknet node per network you want to serve, with a JSON-RPC **0.10** address. Tested: Pathfinder
  (`http://127.0.0.1:9545/rpc/v0_10`, Sepolia, complete proofs) and Juno (`http://127.0.0.1:6060/v0_10`, mainnet,
  state reads and transaction checks only: a complete proof on mainnet has not been tried).
- For parts 5 to 7 only: a box that can forward a port, and an email address or account to sign in to DuckDNS.

A proof took 38 to 49 seconds and used about 30% of the processor of the machine. The server runs **one proof at
a time**; the other requests wait in a queue.

## 2. Prerequisites

### 2.1 System packages

*Why:* the prover is compiled from source, and its Python part needs a virtual environment.

```bash
sudo apt update
sudo apt install -y git curl build-essential pkg-config libssl-dev protobuf-compiler openssl \
  python3.12 python3.12-venv python3.12-dev libgmp-dev libffi-dev libclang-dev
```

*Notes:*

- `python3.12-venv` is required: without it the setup stops with `No module named ensurepip`.
- `python3.12-dev`, `libgmp-dev` and `libffi-dev` are precautions (pip may need them to compile a library).
- `libclang-dev` is the standard remedy for a build failure seen on the reference machine (`'stdarg.h' file not
  found`, see [section 8](#8-statistics-logs-and-common-problems)). On that machine the build was completed with
  another workaround, so the installation with `libclang-dev` has **not been tried**.
- The reference machine already had the other packages of the list.
- The README of the prover requires Python 3.12. If your distribution has another version, install 3.12 first.

### 2.2 Node.js 22 or newer

*Why:* the server and its commands are written in TypeScript and run on Node.js.

With `nvm` (a tool that installs Node.js in your home directory, no `sudo`):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Close the terminal and open a new one, then:

```bash
nvm install node
nvm alias default node
node --version
```

*You should see:* `v22.x.x` or a higher number. If the number is lower than 22, or `node` is not found, run
`nvm install node` again in a new terminal. You may use any other way to install Node.js 22 or newer.

### 2.3 Rust

*Why:* the prover is written in Rust.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Follow the on-screen instructions (the default choice is fine), then open a new terminal and check:

```bash
rustc --version
cargo --version
```

*You should see* two version lines. The second Rust toolchain that the prover needs (`nightly-2026-01-15`) is
installed by the setup in the next part: do not install it yourself.

## 3. Get the code and build the prover

*Why:* to have the server and the prover (about 8 GB) on the machine.

```bash
git clone <URL of this repository>
cd secure-voty/proofServer
npm install
npm run build
./proof-server.sh setup
```

`npm install` and `npm run build` take a minute. `./proof-server.sh setup` clones the prover
(`starknet-innovation/snip-36-prover-backend`), builds its command-line tool, then builds the prover and the
runner from source. Its progress lines look like this:

```
[1/4] Cloning snip-36-prover-backend into …/proofServer/snip-36-prover-backend...
[2/4] Building snip36 (cargo build --release -p snip36-cli)...
[3/4] Running snip36 setup (about 10 GB of disk, 20 to 30 minutes)...
[4/4] Checking the installation (snip36 doctor)...
…
  PASS: stwo-run-and-prove (…)
  PASS: virtual-OS runner (…)
  PASS: starknet-sierra-compile (…)
  PASS: bootloader_program.json
  PASS: prover params template
  PASS: cairo-compile venv
  Passed: 6
  Failed: 0
  RESULT: PROVING STACK READY
```

*You should see:* `RESULT: PROVING STACK READY`. The command can be run again safely: it skips what is done and
finishes an installation that was interrupted. It never updates the prover: see
[section 9](#9-updating-snip36-and-the-prover). To lower the load on a machine that also runs nodes, start it with
`CARGO_BUILD_JOBS=4 nice -n 19 ./proof-server.sh setup`.

*If it fails*, the last lines say why. The two failures met on the reference machine are in
[section 8](#8-statistics-logs-and-common-problems) (`stdarg.h` not found, `ensurepip`).

## 4. Create an instance and test it on your network

*Why:* an instance is the server for one network. Its file holds the address of your node and its ports.

```bash
cp instances/example.env instances/sepolia.env
```

Open `instances/sepolia.env` in an editor and set:

| Variable | Meaning | Example |
|---|---|---|
| `NETWORK` | `mainnet` or `sepolia`. It must be the network of your node. | `sepolia` |
| `STARKNET_RPC_URL` | JSON-RPC address of your node, spec 0.10. | `http://127.0.0.1:9545/rpc/v0_10` |
| `LAN_PORT` | port of the LAN listener (no key). | `3030` |
| `PUBLIC_ENABLED` | `true` to also open the public listener (part 6). | `false` |
| `PUBLIC_PORT` | port of the public listener, on `127.0.0.1` only. | `4030` |
| `LOG_MAX_MB`, `LOG_FILES` | optional: size and number of the log files (default 5 MB, 3 old files). | |
| `SNIP36_BINARY` | optional: another `snip36` program. | |

The name of the file is the name of the instance. Use lowercase letters, digits and dashes. The name `caddy` is
reserved. Make one file per network, with different ports (for instance `mainnet.env` with `LAN_PORT=3031` and
`PUBLIC_PORT=4031`).

Start it:

```bash
./proof-server.sh start sepolia
```

*You should see:*

```
sepolia: running (pid 1254993) — LAN http://192.168.1.26:3030, public off
```

Check it:

```bash
curl http://127.0.0.1:3030/health
```

*You should see:* `{"ok":true,"network":"sepolia","queueLength":0,"running":0}`. From another computer of your
network, use the address printed by `start` (here `192.168.1.26`) instead of `127.0.0.1`.

*If `start` fails*, it prints why. The usual causes are in [section 8](#8-statistics-logs-and-common-problems):
the node is not reachable, the node is on another network than `NETWORK`, a port is already used.

To use it from the DAPP of this repository, put in its `.env` (this variable is optional when the DAPP runs on
the same machine: the default is `http://localhost:3030`):

```
PROOF_SERVER_URL=http://192.168.1.26:3030
```

> **Never forward the LAN ports (3030, 3031…) on your box.** They have no key and no quota: anybody who can
> reach them can use your server.

## 5. Sites, keys and quotas

*Why:* the public listener accepts only the sites you registered. Each one gets a secret key and a maximum number
of proofs per day (UTC) and per network.

```bash
./proof-server.sh site add secure-voty --sepolia 100 --note "my voting demo"
```

*You should see:*

```
Saved config/sites.json — running instances apply it within 5 s.

Key of "secure-voty". Send it through a private channel (never a git repository or a plain email):
it cannot be shown again, only a hash of it is kept.

  OPvzE_QiE1oG1T91nA6CvmpEf85mPuhMfX_0aBQWxhg
```

(The key above is an example. Yours is different.)

- **Copy the key now** into a password manager. The server keeps only a hash of it, so it can never show it again.
- The site puts it in the environment of the program that calls the server, as `PROOF_SERVER_API_KEY` (see
  section 4 for `PROOF_SERVER_URL`). Never put it in a git repository.
- Without `--sepolia` or `--mainnet`, the site is created but may not use any network yet.

Other commands (changes apply within 5 seconds, no restart):

| Command | Effect |
|---|---|
| `./proof-server.sh site list` | each site, enabled or not, and today's use per network (`3/100`) |
| `./proof-server.sh site set secure-voty --sepolia 200 --mainnet 5` | change the daily quotas |
| `./proof-server.sh site set secure-voty --mainnet off` | this network is no longer allowed |
| `./proof-server.sh site disable secure-voty` / `enable` | cut or restore the access without losing the settings |
| `./proof-server.sh site remove secure-voty` | delete the site |
| `./proof-server.sh site rotate-key secure-voty` | new key; **the old one is refused at once** |

Use `rotate-key` if a key is lost or has leaked. Requests already queued by a site that is disabled or removed
are cancelled; a proof already running goes on.

**The same thing by hand.** The file `config/sites.json` stores only the SHA-256 hash of each key. To create a
key without the command:

```bash
openssl rand -base64 32                       # prints a key; keep it
printf %s "THE-KEY-JUST-PRINTED" | sha256sum  # prints the hash: copy the 64 characters before the dash
```

then write the hash as `keySha256` of a new entry in `config/sites.json` (see `config/sites.example.json`). The
server reads the file again by itself when it changes; a mistake in the file is reported in the log and the
previous settings stay in force.

The other limits are in the same file, under `limits` (here with their default values):

| Limit | Default | Meaning |
|---|---|---|
| `machineSlots` | 1 | proofs at the same time on the whole machine, all instances together |
| `queueMax` | 10 | requests waiting on an instance, local ones included; when it is reached, only public requests are refused |
| `perSiteQueueMax` | 2 | requests of one site waiting or running at the same time |
| `maxWaitSec` | 900 | a request is refused when the estimated wait is longer |
| `proofTimeoutSec` | 600 | a proof is stopped after this time |
| `maxBodyKB` | 256 | largest request accepted |
| `badKey` | 10 failures in 10 min | the address is banned for 60 min after 10 wrong keys within 10 minutes |

Requests from your local network are never refused for load, and they go first in the queue.

## 6. Go public: DuckDNS, your box, Caddy

*Why:* to let a site on the Internet use your server, three things are needed: a **name** that points to your
box (DuckDNS), a **door** open on the box to this machine (port forwarding), and a program that speaks **HTTPS**
on that door (Caddy).

### 6.1 A name with DuckDNS

1. Go to <https://www.duckdns.org/> and sign in. The page offers Google, GitHub, Twitter and Reddit accounts.
2. Choose a name (for example `myproof`, which gives `myproof.duckdns.org`) and add it.
3. The page shows your **token**: a long secret, like a password. Do not share it.
4. From the machine of the server, tell DuckDNS to use the address your request comes from (replace `NAME` and
   `TOKEN`):

   ```bash
   curl "https://www.duckdns.org/update?domains=NAME&token=TOKEN&ip="
   ```

   *You should see:* `OK`. (`KO` means a wrong name or token.) An empty `ip=` makes DuckDNS detect the address
   itself, which is the public address of your box.
5. Check:

   ```bash
   getent ahosts NAME.duckdns.org
   ```

   *You should see* the public address of your box (the same as `curl https://ifconfig.me`).

If the public address of your box changes one day, run the `curl` command of step 4 again. Nothing does it
automatically.

### 6.2 Your box

*Why:* the box receives the visits from the Internet. It must send those for the HTTPS port to this machine.

On a Freebox (other boxes work the same way, the menus differ):

1. **Public IPv4 address.** The port forwarding below only works if your box has its own public IPv4 address.
   Free subscribers report on forums that recent lines share one address between several subscribers, which
   blocks port 443, and that the fix is to ask for an **"IPv4 Full Stack"** address in the subscriber area
   (subscribe.free.fr). This is not documented on Free's own pages as far as could be found, so check your
   subscription.
2. In Freebox OS (`mafreebox.freebox.fr`), give this machine a **fixed address** (a static DHCP lease).
3. Add a **port forwarding** rule: protocol TCP, external port **443**, to the address of this machine, port
   **8443**.
4. Make sure Freebox OS itself does not use port 443 for its remote access, and that no DMZ points to this
   machine.

Forward **only** 443. Never forward 3030, 3031 or any other port of this guide.

*Test the forwarding before going on.* This starts, for 15 seconds, a tiny server on port 8443 that answers
`forward-ok`, then calls it through your public name:

```bash
timeout 15 node -e 'require("http").createServer((q,r)=>r.end("forward-ok\n")).listen(8443,"0.0.0.0")' &
sleep 1; curl http://NAME.duckdns.org:443/
```

*You should see:* `forward-ok`. (On the reference Freebox this works from inside the network. If your box
refuses a machine to call its own public address, run the same test from a phone on 4G with Wi-Fi off.)

### 6.3 Caddy

*Why:* Caddy gets the HTTPS certificate from Let's Encrypt for your name, renews it by itself, and sends each
request to the right instance.

Install it from the official repository (<https://caddyserver.com/docs/install>):

```bash
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

The package starts a Caddy service of its own. **Turn it off:** the proof server starts and stops its own Caddy.

```bash
sudo systemctl disable --now caddy
```

(A `failed` state of that service afterwards is harmless.)

### 6.4 Open the public listener and start

1. In `instances/sepolia.env`, set `PUBLIC_ENABLED=true` (and a `PUBLIC_PORT`).
2. Generate the Caddy configuration from your instance files and your name:

   ```bash
   ./proof-server.sh caddyfile --domain NAME.duckdns.org
   ```

   *You should see* the file written, then the public addresses (`https://NAME.duckdns.org/sepolia/prove`…) and
   a reminder to forward 443 to port 8443. Run the command again whenever you add or remove a public instance.
3. Check it (the options are needed):

   ```bash
   caddy validate --config deploy/Caddyfile --adapter caddyfile
   ```

   *You should see* `Valid configuration` on the last line.
4. Start everything:

   ```bash
   ./proof-server.sh start
   ```

   *You should see* each instance `running`, then `caddy: running (pid …)`.
5. Caddy asks for the certificate as soon as it starts. After about 10 seconds:

   ```bash
   grep "certificate obtained" logs/caddy.log
   ```

   *You should see* a line with `certificate obtained successfully`. (Do not search for `error`: that word also
   appears in harmless lines.) If not, see [section 8](#8-statistics-logs-and-common-problems).

### 6.5 Test from outside

With a phone on 4G, Wi-Fi off:

- `https://NAME.duckdns.org/sepolia/health` must show `{"ok":true,"network":"sepolia",…}` without any warning
  about the certificate.
- `http://NAME.duckdns.org:3030/health` must **not** answer.

From a computer, with the key of a site:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://NAME.duckdns.org/sepolia/prove
```

*You should see* `401` (no key). With the key, the DAPP or the scripts of this repository work with:

```
PROOF_SERVER_URL=https://NAME.duckdns.org/sepolia
PROOF_SERVER_API_KEY=<the key of the site>
```

The programs that call the server receive, as events: `queued` (position in the queue and estimated wait),
`started`, `done` (the proof) or `error`. A public caller does not receive the output of the prover, only a
short reason when a proof fails; the output is for your local network.

## 7. Daily use: start, stop, restart

```bash
./proof-server.sh status
```

shows the state of every instance and of Caddy:

```
mainnet (mainnet): running, pid 1263167 — LAN port 3031, public 127.0.0.1:4031
  proofs running: 0, queue: 0
sepolia (sepolia): running, pid 1263179 — LAN port 3030, public 127.0.0.1:4030
  proofs running: 0, queue: 0
  today (UTC): secure-voty 1/100
caddy: running (pid 1263186)
```

An instance is `running`, `stopped`, or `crashed` (its process is gone but it did not stop on request: the last
lines of its console output are shown). `today (UTC)` lists, for each site, the proofs used out of its daily
quota on this network.

| Command | Effect |
|---|---|
| `./proof-server.sh start [instance]` | start one instance, or all of them; also Caddy when a public instance is running |
| `./proof-server.sh stop [instance]` | stop gracefully: **a proof that is running is allowed to finish** (up to 60 seconds, then it is stopped); queued requests receive an error. Without a name, everything stops, Caddy included. With a name, Caddy keeps running while another public instance runs. |
| `./proof-server.sh restart [instance]` | `stop`, then `start` |

Nothing starts by itself: not at boot, not after a crash. This is on purpose.

- **After a reboot of the machine:** start your nodes first, then `./proof-server.sh start`. The certificate is
  kept in `state/caddy`, and Caddy renews it by itself while it is running.
- **After a crash or a power cut:** `status` shows `crashed` and the last lines of the console output of that
  instance. Run `start`: a proof left behind by the dead server is stopped first. If the stale process number of
  the old server was reused by another program, it is recognised and left alone.
- Several instances share the machine: one proof at a time in all (setting `machineSlots`).

## 8. Statistics, logs, and common problems

```bash
./proof-server.sh stats                         # everything kept in the logs
./proof-server.sh stats --since 7d              # or 12h
./proof-server.sh stats --day 2026-10-28 --site secure-voty --instance sepolia
./proof-server.sh stats --json
```

*You should see* one line per day and per site, for instance:

```
day         site         requests  done  failed  timeouts  aborted  rejected  duration med / p95  wait med / max
2026-10-28  (unknown)    0         0     0       0         0        3/0/0/0   - / -               - / -
2026-10-28  lan          3         2     1       0         0        0/0/0/0   42.4 s / 48.7 s     1 ms / 1 ms
2026-10-28  secure-voty  1         1     0       0         0        0/0/0/0   38.2 s / 38.2 s     1 ms / 1 ms

rejected = authentication / quota / overload / invalid request
peak queue: 1, timeouts: 0, busiest hour: 2026-10-28T16 UTC
```

- `lan` groups the calls from your local network (they have no key, so no site name).
- `(unknown)` groups the requests refused before a site could be identified (no key, or a wrong key).
- `duration` is the time of a proof (median / 95th percentile), `wait` the time spent in the queue.

Logs are in `logs/`, one file per instance (`sepolia.log`, JSON, one event per line), limited to 5 MB and 3 old
files by default. `logs/<instance>.stdout` holds only the startup messages and the crashes; `logs/caddy.log` is
Caddy's.

**Privacy.** The transaction (which holds the secrets of your users), the signatures and the keys are **never**
written to a log or to the console. A proof's temporary file is private to your user and deleted as soon as the
proof ends. A failure reason shown in the log is cleaned: paths are replaced and any value found in the
transaction is masked.

### Problems

**`setup` stops with `fatal error: 'stdarg.h' file not found` (while building `mdbx-sys`).**
The compiler helper cannot find the C headers. Either install the standard package, then run the setup again:
`sudo apt install -y libclang-dev` (not tried on the reference machine), or run it with the workaround that
worked there: `BINDGEN_EXTRA_CLANG_ARGS="-I$(gcc -print-file-name=include)" ./proof-server.sh setup`. The
setup resumes where it stopped.

**`setup` fails on `python3.12 -m venv` or says `No module named ensurepip`.**
`sudo apt install -y python3.12-venv`, then run the setup again.

**`snip36 setup` says the sequencer "no longer pins stwo … Regenerate the patches".**
The first run of `snip36 setup` rewrote a lock file that the next run then refuses. `./proof-server.sh setup`
puts the file back by itself before it tries again; if you run `snip36 setup` by hand, first run
`git -C snip-36-prover-backend/deps/sequencer checkout -- Cargo.lock`.

**`start`: `snip36 not found at … — run ./proof-server.sh setup`.** The prover is not built: run the setup.

**`start`: `node http://… unreachable: connect ECONNREFUSED …`.** Your node is not running, or the address in
`instances/<name>.env` is wrong. Test it: `curl -s -X POST -H 'Content-Type: application/json' -d
'{"jsonrpc":"2.0","id":1,"method":"starknet_chainId"}' <the address>`.

**`start`: `node … is on SN_MAIN, but instances/sepolia.env says NETWORK=sepolia`.** The node and the file
disagree on the network. Fix `NETWORK` or the address.

**`start`: `port 3030 is already in use (another instance, or the old proof server?)`.** Another program listens
there: another instance with the same port, or the old proof server. Change the port or stop that program.

**`start`: `No deploy/Caddyfile: run ./proof-server.sh caddyfile --domain …`.** A public instance is running but
Caddy has no configuration yet: part 6.4. (The instances run anyway.)

**`caddy not found: install it (see INSTALL.md)`.** Part 6.3.

**`caddy validate` says `input file required when there is no Caddyfile in current directory`.** Add the options:
`caddy validate --config deploy/Caddyfile --adapter caddyfile`.

**The certificate is not obtained** (no `certificate obtained successfully` in `logs/caddy.log`). Check in this
order: the name points to your box (`getent ahosts NAME.duckdns.org`); your box has its own public IPv4 address
(part 6.2); the forwarding of 443 to port 8443 exists, with the test of part 6.2; Freebox OS does not use 443;
no DMZ. Let's Encrypt limits repeated failed attempts, so correct the cause before starting Caddy again.

**A caller gets an error.** The answer is JSON with a `reason`:

| Status | `reason` | Meaning and remedy |
|---|---|---|
| 400 | `invalid_json`, `invalid_body` | the request is not a valid proof request; the message names the field |
| 401 | `missing_key`, `unknown_key` | no key, or a key the server does not know (it may have been rotated) |
| 403 | `site_disabled`, `network_not_allowed`, `banned`, `not_private` | site cut, network not in its quotas, address banned for an hour after wrong keys, or a LAN port called from outside the local network |
| 413 | `body_too_large` | larger than `maxBodyKB` |
| 429 | `quota_exceeded` | daily quota used up; `Retry-After` says when (00:00 UTC), or raise it with `site set` |
| 429 | `site_busy` | the site already has `perSiteQueueMax` requests waiting or running |
| 503 | `queue_full`, `wait_too_long`, `shutting_down` | the server is busy or stopping; try again after `Retry-After` |

**secure-voty: `Vote is not open`.** The voting round in `src/app/constants.ts` was not opened on-chain: see the
README at the root of the repository.

**A request is slow.** Look at `./proof-server.sh status`: the proofs running, the queue. One proof takes about 40
to 50 seconds on the reference machine.

## 9. Updating snip36 and the prover

Two programs produce the proofs. Both come from one repository, `snip-36-prover-backend`, cloned in
`proofServer/snip-36-prover-backend/`:

- **`snip36`**, the command-line tool the server runs (`target/release/snip36`);
- **the prover**, made of `stwo-run-and-prove` and the runner `starknet_transaction_prover`, in `deps/`. `snip36 setup`
  builds them. The versions of their sources are written inside `snip36` itself, so the prover is not updated on its
  own: **you update both by installing a newer version of the repository**.

`./proof-server.sh setup` **never updates anything**: it skips every step whose result already exists (`already
cloned`, `already built`, `already installed`). To update, delete the folder and run it again (9.2).

### 9.1 Which version do I have, which one exists

```bash
git -C snip-36-prover-backend describe --tags
git -C snip-36-prover-backend ls-remote --tags --sort=-v:refname origin 'v*' | head -3
```

*You should see* the version you have, then the three latest ones (commit number, then the name):

```
v1.3.1
46ad98b8099ca6e1787a008c566a1138ba115fc6	refs/tags/v1.3.1
077ff27a028e52a8b0595d21adf34b59a5c84fb5	refs/tags/v1.3.0
6c6dedde48b5986a48b2a6843fad2d335e6ddcca	refs/tags/v1.2.5
```

(Seen on 2026-10-28: the version installed here, `v1.3.1`, was the latest.) If your version is the first of the
list, you are up to date.

*Do not update without a reason.* `v1.3.1` is the version this server was tested with: real proofs of 38 to 49
seconds on Sepolia. Good reasons are a fix you need, or a Starknet network upgrade after which the proofs of an older
version are refused on-chain. The "Networks" table in the README of the prover gives, for each network, the last
version that passed a real on-chain test; it can be behind the newest release.

### 9.2 Update

```bash
cd proofServer
./proof-server.sh stop               # no proof must run while the files are replaced
rm -rf snip-36-prover-backend        # about 8 GB
./proof-server.sh setup              # clones the latest version and builds it again: 20 to 30 minutes
./proof-server.sh start
```

*You should see* the four steps of part 3, ending with `RESULT: PROVING STACK READY`. If it fails, see
[section 8](#8-statistics-logs-and-common-problems).

**Then check with a real proof.** `setup` and its final check do not run a proof, and the server depends on how
`snip36` is called and on the files it writes (`.proof`, `.proof_facts`, `.raw_messages.json`), which a new release
can change. Ask for one proof, from the DAPP or from the scripts, then run `./proof-server.sh stats`: it must show one
more proof `done`, of about 40 to 50 seconds on the reference machine.

Two variants:

- **A precise version.** `setup` clones the latest commit of the main branch, which can be ahead of the last
  release. To install a published version instead, clone it yourself before `setup`, which then prints
  `already cloned` and goes on:

  ```bash
  git clone https://github.com/starknet-innovation/snip-36-prover-backend snip-36-prover-backend
  git -C snip-36-prover-backend checkout v1.3.1
  ./proof-server.sh setup
  ```

  This is also the way back to an older version.
- **Keep the old copy to go back at once.** Instead of `rm -rf`, move it outside the repository (instant on the same
  disk, 8 GB more): `mv snip-36-prover-backend ~/snip-36-prover-backend.old`. To go back: stop, delete the new
  folder, move the old one back to the same place, start.

### 9.3 Updating the proof server itself

This is the code of this repository (not the prover):

```bash
git pull
cd proofServer
npm install
npm run build
./proof-server.sh restart
```

`restart` lets a running proof finish before it stops. Your files `instances/*.env` and `config/sites.json` are not in
git, so the update does not touch them.

## 10. Appendix: ports, files, migration from the old server

### Ports

| Port | Who | Reachable from | Role |
|---|---|---|---|
| 3030, 3031… | each instance, LAN listener (`LAN_PORT`) | local network only | no key, no quota. **Never forward.** |
| 4030, 4031… | each instance, public listener (`PUBLIC_PORT`) | this machine only (`127.0.0.1`) | key and quota; only Caddy reaches it |
| 8443 | Caddy, HTTPS | the box forwards the public port 443 here | the only door open to the Internet |
| 8080 | Caddy, HTTP | not forwarded | unused |
| 2019 | Caddy, admin | this machine only | |
| 9800 + k | locks of the machine slots | this machine only | one proof at a time on the machine |
| 9900 + k | runner of the proof in slot k | this machine only | |

### Files and folders of `proofServer/`

| Path | Content | In git |
|---|---|---|
| `instances/<name>.env` | one instance | no (`example.env` yes) |
| `config/sites.json` | limits, sites, hashes of the keys | no (`sites.example.json` yes) |
| `deploy/Caddyfile` | generated Caddy configuration | no (`Caddyfile.example` yes) |
| `state/` | process numbers, daily counters, slot records, Caddy's certificate and keys | no |
| `logs/` | the logs | no |
| `tmp/` | files of the proofs that are running | no |
| `snip-36-prover-backend/` | the prover (8 GB) | no |

To save your configuration, copy `instances/`, `config/sites.json` and `state/caddy` (it holds the private key
of the certificate: keep the copy private).

### Migrating from the old proof server

The old server was started with `npm run start` and configured by `proofServer/.env`. Now:

| Old `.env` | New `instances/local.env` |
|---|---|
| `PORT=3030` | `LAN_PORT=3030` |
| `STARKNET_RPC_URL=…` | `STARKNET_RPC_URL=…` (the same address) |
| `STARKNET_CHAIN_ID="SN_SEPOLIA"` | `NETWORK=sepolia` (`SN_MAIN` becomes `mainnet`) |
| `STARKNET_ACCOUNT_ADDRESS`, `STARKNET_PRIVATE_KEY` | not used any more: delete them |
| | `PUBLIC_ENABLED=false` |

Then stop the old server, run `npm install`, `npm run build` and `./proof-server.sh setup` (the prover already
cloned is reused, only `snip36 doctor` runs), and start with `./proof-server.sh start local`. The DAPP needs no
change: its default address is still `http://localhost:3030`.

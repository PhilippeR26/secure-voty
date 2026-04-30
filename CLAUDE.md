# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Secure-Voty** is a demo DAPP showcasing SNIP-36 (Starknet proofs). It implements a privacy-preserving voting system: votes are stored on-chain without revealing who voted what, while guaranteeing each voter is whitelisted and can only vote once.

The core innovation is **off-chain proof generation**: a signed transaction calling `create_proof()` is executed virtually in a proof server (not broadcast to the network), producing a ZK proof. That proof is then submitted on-chain to `verify_vote()`, which verifies it and tallies the vote.
This demo is used only locally,with a local proof server waiting at port 3030.

## Project Structure

The repo has four distinct sub-projects:

| Directory | Purpose |
|-----------|---------|
| `src/` | Next.js 16 frontend + Server Actions (the main app) |
| `cairoContract/voty/` | Cairo 2.17 smart contract (Scarb project) |
| `scripts/` | Standalone Node.js scripts for setup and testing |
| `proofServer/` | Rust-based SNIP-36 proof server (separate repo, ~10 GB) |

## Commands

### Frontend (Next.js)
```bash
npm install        # install dependencies
npm run dev        # start dev server on http://localhost:3000
npm run build      # production build
npm run lint       # run eslint
```

### Cairo Contract
```bash
# Requires: scarb 2.17.0-rc.4 and starknet-foundry 0.58.0 (see cairoContract/.tool-versions)
cd cairoContract/voty
scarb build        # compile contract
snforge test       # run cairo tests
```

### Scripts (Node.js utilities, run from `scripts/`)
```bash
cd scripts
npm install
npx ts-node ./src/1.createTree.ts   # build Merkle tree → writes to src/app/server/
npx ts-node ./src/2.deployVoty.ts   # declare & deploy Cairo contract
npx ts-node ./src/3.createTxProof.ts # build the signed virtual transaction
npx ts-node ./src/4.getProof.ts     # request proof from proof server
npx ts-node ./src/5.sendProof.ts    # submit proof on-chain
npx ts-node ./src/6.getVoteResults.ts # read tallies
```

### Proof Server
```bash
cd proofServer
cp .env.example .env   # fill in STARKNET_RPC_URL; other fields can be placeholder values
npm install
npm run build
npm run start          # listens on http://localhost:3030
```
First launch downloads ~10 GB of Starknet code (≈20 min). Requires ~15 GB free RAM and Rust stable + `nightly-2025-07-14`.

## Environment Setup

Copy `.env-example` to `.env` at project root and fill in:
- `STARKNET_RPC_URL` — Pathfinder v0.22.2+ node required
- `STARKNET_ACCOUNT_ADDRESS` / `ACCOUNT_PRIVATE_KEY` — Starknet account for submitting on-chain tx
- `STARKNET_CHAIN_ID` — e.g. `SN_SEPOLIA`

## Architecture: Data Flow

```
User (browser)
  → [Email.tsx] enters email + secret + vote choice
  → Server Action [voterProofs.ts] checks Merkle whitelist, returns leaf + proof
  → Server Action [getSNProof.ts]:
      1. builds calldata for create_proof()
      2. calls account.getSignedTransaction() — from custom starknet.js fork (PhilippeR26/starknet.js#buildExecute)
      3. POSTs tx to proof server (localhost:3030) via SSE stream
      4. returns { proof, proofFacts, l2ToL1Messages }
  → Server Action [sendVote.ts]:
      1. decodes public outputs from l2ToL1Messages payload
      2. calls account.execute(verify_vote calldata, { proof, proofFacts })
      3. waits for tx receipt
```

## Key Design Decisions

**Custom starknet.js fork**: `getSignedTransaction()` is only available in `github:PhilippeR26/starknet.js#buildExecute`. This method builds a signed V3 INVOKE transaction without broadcasting it — required to send it to the proof server instead.

**SNIP-36 proof pattern**: The `create_proof()` function emits a L2→L1 message containing the public outputs `(round, nullifier, vote)`. The proof server captures this message. On verification, `verify_vote()` reads the message hash from `proof_facts` via `get_execution_info_v3_syscall()` and compares it against the calldata — ensuring the on-chain calldata matches what was proven.

**Nullifier**: Computed as `poseidon([hash_of_members_V1, emailHex, round, secret])`. Prevents double-voting across rounds without revealing voter identity.

## Contract Interface (cairoContract/voty/src/lib.cairo)

- `create_proof(public_input, private_input)` — called virtually (off-chain) to generate the proof
- `verify_vote(public_message: L1L2message)` — called on-chain; verifies proof facts and tallies the vote
- `open_round(round, vote_size)` / `close_round(round)` — admin functions
- `get_tally(round)` — read vote counts

## Updating the Voter List

1. Edit `scripts/src/votersList.json`
2. Run `npx ts-node ./src/1.createTree.ts` from `scripts/` — this overwrites `src/app/server/merkleTree.json` and `src/app/server/secrets.json`
3. Redeploy the contract with the new Merkle root (from `2.deployVoty.ts`)

## Test Credentials

Email: `you@outlook.com` / Secret: `12345678` (committed in `secrets.json` for demo purposes)

To start a new voting round, set `round` in `src/app/constants.ts` to an unused number.

## specificities of this repo
This is a demo. So, some security problems are acceptable for pedagogical purpose:
- src/app/server/secrets.json is public in the repo.
- the `openVote()` server action function is executed automatically at launch (not by an admin).
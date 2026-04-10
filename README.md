# SECURE-VOTY

<p align="center">
  <img src="./src/app/images/vote.png" />
</p>

This demo DAPP demonstrates how Starknet proofs work.  
This technology is illustrated through a voting DAPP.  
The vote is stored on the Starknet blockchain without revealing who voted what, while ensuring that each voter is whitelisted and can vote only once.

## Architecture

The DAPP is a Next.js project deployed on Vercel. It uses two backends:
- A backend to handle the Merkle tree (list of authorized voters).
- A high-performance Starknet proof server. Vercel serverless functions are not powerful enough for proof generation; a dedicated server is required. Public and private data are sent to a Cairo program that computes and returns the proof.

In this demo, both servers run locally:
- The Merkle tree is handled by Next.js Server Actions.
- The proof server is based on an existing repository (see below).

## Requirements
- Approximately 17 GB of free RAM (15 GB for the proof server).
- About 10 GB of storage (mainly for the proof server).
- The more powerful your PC, the faster the proof generation.
- Rust: stable (for workspace crates) + `nightly-2025-07-14` (for the s-two prover).
- Python 3.
- A Starknet RPC node — required for state reads before proof generation. For Pathfinder, v0.22.2 minimum.
- Your contract has to be compiled with Cairo 2.17.0-rc.4 minimum. 

## Servers

### Users Merkle Tree Server
A Merkle tree is used to manage the list of authorized voters. The tree is built and handled using the [starknet-merkle-tree](https://github.com/PhilippeR26/starknetMerkleTree) library.  
The tree is created and tested with this [script](scripts/src/1.createTree.ts).

In the frontend, the user enters their email. The backend checks whether the email exists in the tree and returns the corresponding Merkle proof along with the associated secret value.

> [!NOTE]
> In this repository, the file `src/app/server/secrets.json` is committed. In a production environment, this file must remain private.

### Proof Server

This server must be under your full control, and you must ensure a high level of confidentiality and security. It will receive and process all the secrets of your application.  

> [!IMPORTANT]
> This proof server is generic: it can execute and prove any V3 transaction from any account.

This demo uses the following repository: https://github.com/starknet-innovation/snip-36-prover-backend

To run the proof server:

```bash
cd proofServer
```

Copy `.env.example` to `.env` and adjust the values according to your setup.

> [!NOTE]
> `STARKNET_ACCOUNT_ADDRESS` and `STARKNET_PRIVATE_KEY` are not used but are required fields. You can enter any values.

Launch the server with:

```bash
npm install
npm run build
npm run start
```

The first launch will download, install, and compile approximately 10 GB of Starknet-related code. This process takes about 20 minutes (on my machine).

The server runs locally on port 3030.

## Frontend (Next.js)

In the root of the demo repository:

```bash
npm install && npm run dev
```

Open http://localhost:3000

Make sure you have about 15 GB of RAM available.

**You can test the demo using the email address `you@outlook.com` and the user secret `12345678`.**
In `src/app/constants.ts` , select a round number not yet used (for example a large random number).

## Concept of Usage

Here’s how these powerful proofs work:

1. Declare and deploy a contract that will handle the proof.
2. Build a transaction that can be executed in this contract.
3. The transaction is executed virtually (off-chain) and proved entirely within the proof server. The response includes:
   - the proof
   - the proof facts
   - any L2→L1 messages
4. Declare and deploy a contract capable of verifying the proof and executing authorized actions (this can be the same contract as in step 1, but with separate proof/verification functions).

5. Call the verification function **on-chain**, passing the proof, the proof facts, and the content of the L2→L1 messages as calldata parameters.
6. If the proof corresponds to a reverted virtual transaction, the on-chain transaction will fail. If the proof facts are inconsistent with the calldata, the transaction will also revert. Once these checks pass, the contract can safely execute the authorized actions.

## Vote Use Case

Let’s examine a concrete voting example to better understand each step.

The first step is to clearly define what is public and what is private in your application. For example, in a heavy computation scenario, nothing may be private — you only need a proof that a given calculation with public inputs produces a specific output.

In this voting use case:
- The voter ID must remain **private**.
- The vote choice must be **public** so that votes can be tallied on-chain.
- Private data is needed to prove the voter is whitelisted (handled via a Merkle tree).
- Additional private data is used to generate a public **nullifier** to ensure the voter can vote only once. Voter-specific secrets and hashes are used here (this part should be adapted to each project and the technical level of the target users).
- A public **round number** allows the same DAPP to handle multiple voting rounds.

### 1. Declare/Deploy a Contract That Handles the Proof

The proof must demonstrate the following:
- The vote is currently open (this will be checked again in the verifier contract).
- The vote choice is within the allowed range.
- The voter is whitelisted.
- The nullifier is correctly calculated.

The public outputs of the proof are:
- The round number
- The vote choice
- The nullifier

**Public inputs:**

```rust
merkle_root: felt252, // root of the Merkle tree listing all authorized voters (set in the contract constructor)
vote: u8,             // the voter's choice
nullifier: felt252,   // a hash of voter data — impossible to link back to the voter without the secret
round: u32,           // nonce of this voting round (allows the DAPP to handle multiple votes)
```

**Private inputs** (never sent on-chain after step 3):

```rust
member_leaf: felt252,           // hash of the voter ID
merkle_proof: Array<felt252>,   // Merkle proof for the voter
secret: felt252,                // private secret unique to each voter
```

These private values are related to the user and must never be sent to the public Starknet network along with the vote.

The contract code is available [here](./cairoContract/voty/src/lib.cairo). See the `create_proof()` function.

### 2. Build a Transaction

We need to construct a transaction that calls the `create_proof()` function. This transaction will **not** be executed on-chain — it will be executed and proved virtually in the backend.

The function signature is:

```rust
fn create_proof(
    self: @ContractState,
    public_input: PublicInputsForProof,
    private_input: PrivateInputsForProof,
) {}

struct PublicInputsForProof {
    vote: u8, 
    round: u32 
}

struct PrivateInputsForProof {
    member_leaf: felt252, 
    merkle_proof: Array<felt252>, 
    secret: felt252 
}
```

`member_leaf` and `merkle_proof` are provided by the Merkle tree backend.  
`vote` and `round` are provided by the frontend.

The transaction is built using a special fork of starknet.js. See the implementation in [this script](./scripts/src/3.createTxProof.ts):

```ts
const tx = await myAccount.getSignedTransaction(myCalldata);
```

The result is:

```json
{
  "type": "INVOKE",
  "sender_address": "0x0304c822792da45bf6f8e6957aa9515bd7b365f05b5c1678f61ae0c46213251c",
  "calldata": [
    "0x1",
    "0x62751c14ff5d186f1ec837c7c45345fe555b8eba5e89c641bcb429d748f8f6a",
    "0x1ebfe9bbcb97616537f1b99138aa084dcca02847d532d6c382752811a326f3",
    "0x7",
    "0x0",
    "0x0",
    "0x46834de20fe71e56d6cda4502646f55e85e3ec51057913e5774c69bbe184483",
    "0x2",
    "0x6470e032be23949b12cc95a0afac6d016869a5a9e351d461500c7d4d9e8b872",
    "0x61ed79f3eda9549dedad333037a5961d8221a6694aaac6ce3eb7062a5760e40",
    "0x9276d5261cf7f22dda46160f0af27aa2f22c6135af8ad5e01c00ba89a1e824"
  ],
  "signature": [
    "0x6c7bab9c52273e87928a84eb8c6d9cfe97625a9e9ce5c365f6405d35e6121a4",
    "0x41cab24221a6c282af3b9839e3049d147510fb6d3f42b4248492ac222ef5473"
  ],
  "nonce": "0x1c3",
  "resource_bounds": {
    "l2_gas": {
      "max_amount": "0x1ef0e4",
      "max_price_per_unit": "0x2cb417800"
    },
    "l1_gas": {
      "max_amount": "0xacfe",
      "max_price_per_unit": "0x4fbd695ea9f0"
    },
    "l1_data_gas": {
      "max_amount": "0xc0",
      "max_price_per_unit": "0x15679"
    }
  },
  "tip": "0x0",
  "paymaster_data": [],
  "nonce_data_availability_mode": "L1",
  "fee_data_availability_mode": "L1",
  "account_deployment_data": [],
  "version": "0x3"
}
```

### 3. Off-chain Execution of the Transaction

The proof server must be running and listening on port 3030.

Choose the blockchain block that will serve as the basis for the virtual execution. As a first approach, use the latest block:

```ts
const currentBlock: number = await myProvider.getBlockNumber();
```

A `requestProof()` function is provided in [this file](./scripts/src/RequestProof.ts). Use it as follows:

```ts
const proofRes: ProveResult = await requestProof(currentBlock, tx);
```

The `ProveResult` structure contains:

```ts
type ProveResult = {
  proof: string;
  proofFacts: BigNumberish[];
  l2ToL1Messages?: ProofMessage[];
}

type ProofMessage = {
  from_address: BigNumberish;
  payload: BigNumberish[];
  to_address: BigNumberish;
}
```

- `proof` is a Base64 string.
- `proofFacts` is an array of `felt252`.
- The public outputs are embedded in the payload of the L2→L1 message(s). These messages are repurposed to carry the public data alongside the proof.
```ts
type L1L2message = {
  round: BigNumberish,
  nullifier: BigNumberish,
  vote: BigNumberish,
}
const messageCallData = new CallData(l1l2MessageAbi);
const messageContent = messageCallData.decodeParameters("l1l2message", (proofRes.l2ToL1Messages![0].payload) as string[]);
const messageFromProof = messageContent as L1L2message;
```

You can decode the public data using an ABI (see [this example](./scripts/src/4.getProof.ts)).

### 4. Declare/Deploy a Verification Contract

You need a Cairo contract containing a verification function. The transaction calling this function must include:
- the Base64 proof,
- the proof facts,
- the public data in the calldata.

Starknet automatically verifies the proof. If successful, the function is executed. Inside the function, you must verify that the public data provided in the calldata matches the L2→L1 message generated during proof creation.

You will need these two helper functions:

```rust
#[derive(Drop, Serde)]
struct ProofMessage {
    from_address: ContractAddress,
    payload: Span<felt252>,
    to_address: EthAddress,
}

fn _get_proof_messages_hashes() -> Span<felt252> {
    // Extracts the message hashes from the proof facts
    let info = starknet::syscalls::get_execution_info_v3_syscall().unwrap_syscall().unbox();
    let mut arr = info.tx_info.unbox().proof_facts;
    let pr_facts = Serde::<ProofFacts>::deserialize(ref arr).expect('ProofFacts deser failed');
    pr_facts.l1l2messages
}

fn _compute_message_hash_for_proof_facts(pf: @ProofMessage) -> felt252 {
    let mut data: Array<felt252> = array![
        (*pf.from_address).into(), 
        (*pf.to_address).into(), 
        pf.payload.len().into(),
    ];
    for i in (pf.payload) {
        data.append(*i);
    }
    poseidon_hash_span(data.span())
}
```

Here is an example of the verification logic:

```rust
#[derive(Drop, Serde)]
struct L1L2message {
    round: u32,
    nullifier: felt252,
    vote: u8,
}

fn verify_vote(ref self: ContractState, public_message: L1L2message) {
    // Read L2→L1 message hashes from the proof facts
    let proof_facts = _get_proof_messages_hashes();

    // Rebuild the message from the calldata
    let mut ser: Array<felt252> = ArrayTrait::new();
    public_message.serialize(ref ser);

    let message = ProofMessage {
        from_address: get_contract_address(), // ensures the proof was generated for this contract
        payload: ser.span(),
        to_address: 0x00_felt252.try_into().unwrap(),
    };

    let calculated_message_H = _compute_message_hash_for_proof_facts(@message);

    // Verify that the message hash from the proof matches the one rebuilt from calldata
    assert(calculated_message_H == *proof_facts.at(0), 'pub message not related to hash');

    // At this point, we are sure the calldata matches the proof.
    // You can now safely execute actions based on the public data.
}
```

### 5. Frontend Executes the Verification Function

Once you have the proof, proof facts, and L2→L1 message content, you can submit the final on-chain transaction:

```ts
const myCalldata2 = votyContract.populate("verify_vote", {
  public_message: messageFromProof
}); 

const res2 = await myAccount.execute(myCalldata2, { proof, proofFacts });
```

The proof is verified automatically by Starknet, the proof facts are validated in the contract, the vote is tallied, and the nullifier is recorded to prevent double-voting.

---

This voting example illustrates the core concepts and practical usage of SNIP-36 proofs.

SNIP-36 opens up a new range of powerful applications on Starknet. The main remaining challenge for wide adoption is reducing the RAM and CPU requirements for proof generation.

We look forward to rapid improvements in this area.

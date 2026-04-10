# Generic SNIP-36 virtual transaction prover

## Requirements
- about 15 Gb free RAM.
- About 10 Gb of storage.
- More powerful is your PC, faster is the proof calculation (40s on my PC)
- Rust: stable (for workspace crates) + `nightly-2025-07-14` (for stwo prover).
- Starknet RPC node — for state reads before proving. For Pathfinder, v0.22.2 minimum.

## Configuration 
Copy .env.example to .env, and adapt the content to your case.
> [!NOTE]
> STARKNET_ACCOUNT_ADDRESS & STARKNET_PRIVATE_KEY are not used, but are necessary. You can put any value.

## Install
```bash
npm install
npm run build
npm run start
```
First Launch will download/install and compile 10Gb of Starknet code. Duration: about 20 minutes (on my PC).

## Execution

On client side :

Define
- `currentBlock`:  the block that will be the basis for the virtual transaction
- tx: a signed transaction that execute the function to prove.
  Example of transaction (type `INVOKE_TXN_V3` of `npm:@starknet-io/types-js@0.10.2"`):
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
    "0x784ee0ec157e7a28ad43138377787489274513c70f4f6f00934faa7787c5612",
    "0x1723332a3c546a15cc5397e9ab950ca214b49c6754040232806e889dd5904c"
  ],
  "nonce": "0x1c6",
  "resource_bounds": {
    "l2_gas": {
      "max_amount": "0x1ef0e4",
      "max_price_per_unit": "0x2cb417800"
    },
    "l1_gas": {
      "max_amount": "0xacfe",
      "max_price_per_unit": "0x51bff50bf0f0"
    },
    "l1_data_gas": {
      "max_amount": "0xc0",
      "max_price_per_unit": "0x266b20e4fcc"
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

Frontend request:

Just call the `requestProof()` function defined in this [code](../scripts/src/RequestProof.ts)

```ts
const proofRes: ProveResult = await requestProof(currentBlock, tx);
```

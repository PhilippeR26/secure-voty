## Content of params.json

 ================== PUBLIC INPUTS (visibles dans la preuve)
merkle_root: felt252,
vote: u8,
nullifier: felt252,
round: felt252,

 ================== PRIVATE INPUTS (cachés par la preuve)
member_leaf: felt252,           // hash de ton identifiant membre
member_index: u32,              // position dans l'arbre
merkle_proof: Array<felt252>,   // siblings . Do not forget initial quantity of items
secret: felt252,                // ton secret privé (généré localement, jamais envoyé)

## Execution

```bash
scarb execute --arguments-file params.json  --print-program-output
```

## Prove

> [!WARNING]
> At least 15 Gb of available RAM

```bash
scarb prove --execute --arguments-file params.json
```

result in `target/execute/vote_private/executionN/proof.json`

## Verify

```bash
scarb verify --execution-id N
```


N is the nonce of the execution directory.

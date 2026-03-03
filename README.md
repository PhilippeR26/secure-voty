# SECURE-VOTY

This demo DAPP shows how are working Starknet proofs.  
This technology is illustrated here in a vote DAPP.  
The vote is stored in the Starknet blockchain, without storing who is voting what.

## Architecture

The DAPP is a Next.js project, is deployed in Vercel, and has a backend to handle a Merkle tree (list of voters).  
It has also a second backend, with higher performances than Vercel backend, dedicated to calculate the proof. Public & private data are sent to a Cairo code that calculates and returns the proof.  
Then the proof is sent to a deployed Starknet contract, verified in this contract, and public data are used to update the vote results.

### Users Merkle tree
A Merkle tree is used to handle the list of voters. The tree is created and handled with this library: `starknet-merkle-tree`.  
The tree is created and tested with this [script](scripts/src/1.createTree.ts).

In the front end, the user enters its email ; the backend is verifying if the email is in the tree, and return its Merkle proof.

### Proof calculation
A Cairo code (not a Starknet contract) is created to be able to generate a Starknet proof.  
This code is using as input:
-  private data that will never be used after this step:

```rs
member_leaf: felt252,           // hash of the user
merkle_proof: Array<felt252>,   // Merkle proof related to the user
secret: felt252,                // private secret (unique to each user, known temporary only by the frontend)
```
So, it's the data related to the user. These data shall not be sent to Starknet with the user vote, for evident reasons.

- public data that will be used and stored in Starknet.
```rs
merkle_root: felt252, // root of the users list Merkle tree, from the next.js backend
vote: u8, // What the user has voted
nullifier: felt252, // a hash of some vote data
round: felt252, // the nonce of this vote (the DAPP is able to handle several votes)
```
This Cairo code is available [here](./cairoContract/vote_private/src/lib.cairo). It's here in this repo for pedagogical purpose ; its proper location is in the high performance backend repo.

This backend is running `scarb` to execute the code with all these input parameters, and generating the proof.
```bash
scarb prove --execute --arguments-file temp_params.json
```

### Verification and storage in Starknet contract
These public data will be sent to Starknet (with the proof) by the frontend. They do not include any user data (the nullifier is a user related data hash that can NOT be reverted to get any user knowledge).  
With these public data and the proof, the Starknet contract is able to verify that the user is legit, is voting only once, and to count the votes.  
The magic of Starknet proof is that these verifications are possible without revealing the user email!  
This contract code is available [here](./cairoContract/manage_vote/src/lib.cairo).  

> [!CAUTION]
> Today, this contract is not working for 2 reasons: 
> - There are too much data (the proof) to send to the contract (Starknet limitations)
> - I didn't found a verifier contract of a scarb proof....
> 


## Test 

- First, launch locally the high performance backend, that is available in this repo : https://github.com/PhilippeR26/secure-voty-backend (follow README instructions ; take care of the necessary RAM). It will be available locally at port 4000.
- Launch locally a Starknet devnet network : https://0xspaceshard.github.io/starknet-devnet/ with `--seed 0` option. It will be available locally at port 5050.
- Launch locally the DAPP
```bash
npm install
npm run dev
```
Open the provided link in a browser.

Test with "you@outlook.com" email.


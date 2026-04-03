import type { BigNumberish } from "starknet";
import * as Merkle from "starknet-merkle-tree";

export interface ProofAnswer {
    address: string,
    proof: string[],
    leaf: Merkle.InputForMerkle,
    leafHash: string,
    isWhiteListed: boolean,
    index: number,
}

export type PublicInputsForProof = {
    vote: BigNumberish,
    round: BigNumberish,
};

export type PrivateInputsForProof = {
    member_leaf: BigNumberish,
    merkle_proof: Array<BigNumberish>,
    secret: BigNumberish
};

export type ProofMessage = {
    from_address: BigNumberish;
    payload: BigNumberish[];
    to_address: BigNumberish;
}

export type ProveResult = {
    proof: string;
    proofFacts: BigNumberish[];
    l2ToL1Messages?: ProofMessage[];
}
 export type L1L2message = {
      round: BigNumberish,
      nullifier: BigNumberish,
      vote: BigNumberish,
    }
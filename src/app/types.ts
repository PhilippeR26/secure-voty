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

// Why no proof could be obtained. `message` is meant for the voter; `retryAfterSec` says when to try again.
export type ProofFailureKind =
    | "no_session"
    | "unreachable"
    | "network_mismatch"
    | "refused"
    | "quota"
    | "busy"
    | "proof_failed"
    | "internal";

export type ProofFailure = {
    kind: ProofFailureKind;
    message: string;
    retryAfterSec?: number;
};

// Progress of a request on the proof server: its place in the queue, then the start of the proof.
export type ProofProgress =
    | { event: "queued"; position: number; etaSec: number }
    | { event: "started" };
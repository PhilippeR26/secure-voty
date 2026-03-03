import * as Merkle from "starknet-merkle-tree";

export interface ProofAnswer {
    address: string,
    proof: string[],
    leaf: Merkle.InputForMerkle,
    leafHash: string,
    isWhiteListed:boolean,
    index:number,
}
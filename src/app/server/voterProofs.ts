"use server";

import * as Merkle from "starknet-merkle-tree";
import type { ProofAnswer } from "../types";
import treeObj from "./merkleTree.json";


export async function checkWhitelist(emailAddress: string): Promise<ProofAnswer> {
    const shortstring = BigInt(emailAddress)
    const treeExt = treeObj as Merkle.StarknetMerkleTreeData
    const tree = Merkle.StarknetMerkleTree.load(treeExt);
    const indexAddress = tree.dump().values.findIndex((leaf) => BigInt(leaf.value as string) == shortstring);
    if (indexAddress === -1) {
        return ({
            address: emailAddress,
            proof: [],
            leaf: [],
            leafHash: "",
            isWhiteListed: false,
            index:-1,
        });
    }
    const inpData = tree.getInputData(indexAddress);
    const leafHash = Merkle.StarknetMerkleTree.leafHash(inpData, Merkle.HashType.Poseidon);
    const proof = tree.getProof(indexAddress);
    // revalidatePath("/"); // clear cache and update result
    return {
        address: emailAddress,
        proof,
        leaf: inpData,
        leafHash,
        isWhiteListed: true,
        index:indexAddress,
    }
}

export async function getRoot(): Promise<string> {
    const treeExt = treeObj as Merkle.StarknetMerkleTreeData
    const tree = Merkle.StarknetMerkleTree.load(treeExt);
    return tree.root;
}

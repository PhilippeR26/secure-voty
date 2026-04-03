"use server";

import * as Merkle from "starknet-merkle-tree";
import type { ProofAnswer } from "../types";
import treeObj from "./merkleTree.json";
import secretTable from "./secrets.json";


export async function checkWhitelist(emailEncoded: string, proposedApiKey: string): Promise<ProofAnswer> {
    if (BigInt(proposedApiKey) !== BigInt(process.env.API_KEY!)) {
        throw new Error("Wrong API key");
    }
    const shortstring = BigInt(emailEncoded)
    const treeExt = treeObj as Merkle.StarknetMerkleTreeData
    const tree = Merkle.StarknetMerkleTree.load(treeExt);
    const indexAddress = tree.dump().values.findIndex((leaf) => BigInt(leaf.value as string) == shortstring);
    if (indexAddress === -1) {
        return ({
            address: emailEncoded,
            proof: [],
            leaf: [],
            leafHash: "",
            isWhiteListed: false,
            index: -1,
        });
    }
    const inpData = tree.getInputData(indexAddress);
    const leafHash = Merkle.StarknetMerkleTree.leafHash(inpData, Merkle.HashType.Poseidon);
    const proof = tree.getProof(indexAddress);
    // revalidatePath("/"); // clear cache and update result
    return {
        address: emailEncoded,
        proof,
        leaf: inpData,
        leafHash,
        isWhiteListed: true,
        index: indexAddress,
    }
}

export async function checkSecret(emailEncoded: string, proposedSecret: string, proposedApiKey: string): Promise<boolean> {
    if (BigInt(proposedApiKey) !== BigInt(process.env.API_KEY!)) {
        throw new Error("Wrong API key");
    }
    const secret = (secretTable as Record<string, string>)[emailEncoded];
    if (BigInt(secret) !== BigInt(proposedSecret)) {
        return false
    }
    return true
}

export async function getRoot(): Promise<string> {
    const treeExt = treeObj as Merkle.StarknetMerkleTreeData
    const tree = Merkle.StarknetMerkleTree.load(treeExt);
    return tree.root;
}

"use server";

import { Account, Contract, RpcProvider, type Abi, type GetTransactionReceiptResponse } from "starknet";
import type { L1L2message, PrivateInputsForProof, ProveResult, PublicInputsForProof } from "../types";
import { requestProof } from "./RequestProof";
import { votyContractAddress } from "../constants";


export async function sendVote(proofRes: ProveResult, messageFromProof: L1L2message, proposedApiKey: string): Promise<string> {
    if (BigInt(proposedApiKey) !== BigInt(process.env.API_KEY!)) {
        throw new Error("Wrong API key");
    }
    console.log("sendVote: with message ", messageFromProof, " and proof :", "proof size =", proofRes.proof.length, ", start =", proofRes.proof.slice(0, 8), ", end =", proofRes.proof.slice(-8));
    const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const abi: Abi = (await myProvider.getClassAt(votyContractAddress)).abi;
    const account0 = new Account({ address: process.env.STARKNET_ACCOUNT_ADDRESS!, provider: myProvider, signer: process.env.ACCOUNT_PRIVATE_KEY! });
    const votyContract = new Contract({ abi, address: votyContractAddress, providerOrAccount: account0 });

    const myCalldata2 = votyContract.populate("verify_vote", {
        public_message: messageFromProof,
    });
    const res2 = await account0.execute(myCalldata2, { proof: proofRes.proof, proofFacts: proofRes.proofFacts });
    const txR2 = await account0.provider.waitForTransaction(res2.transaction_hash);
    console.log(txR2);
    if (txR2.isSuccess()) {
        console.log("Vote sent successfully");
        return txR2.execution_status;
    } else {
        console.error("Failed to send vote:", txR2);
        return "failed";
    }
}
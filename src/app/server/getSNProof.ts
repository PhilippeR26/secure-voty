"use server";

import { Account, Contract, RpcProvider, type Abi } from "starknet";
import type { PrivateInputsForProof, ProveResult, PublicInputsForProof } from "../types";
import type { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
import { requestProof } from "./RequestProof";
import { votyContractAddress } from "../constants";


export async function getSNProof(publicData: PublicInputsForProof, privateData: PrivateInputsForProof, proposedApiKey: string): Promise<ProveResult> {
     if (BigInt(proposedApiKey) !== BigInt(process.env.API_KEY!)) {
        throw new Error("Wrong API key");
    } const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const abi: Abi = (await myProvider.getClassAt(votyContractAddress)).abi;
    const account0 = new Account({ address: process.env.STARKNET_ACCOUNT_ADDRESS!, provider: myProvider, signer: process.env.ACCOUNT_PRIVATE_KEY! });
    const votyContract = new Contract({ abi, address: votyContractAddress, providerOrAccount: account0 });

    const myCalldata = votyContract.populate("create_proof", {
        public_input: publicData,
        private_input: privateData,
    });
    // **** ⚠️⚠️⚠️ getSignedTransaction is only available from https://github.com/PhilippeR26/starknet.js/tree/buildExecute branch
    const tx: INVOKE_TXN_V3 = await account0.getSignedTransaction(myCalldata);
    // console.log("virtual transaction =", tx);

    const currentBlock: number = await myProvider.getBlockNumber();
    try{
        const proofRes: ProveResult = await requestProof(currentBlock, tx);
        console.log("getSNproof: proof size =", proofRes.proof.length, ", start =", proofRes.proof.slice(0, 8), ", end =", proofRes.proof.slice(-8));
        return proofRes;
    } catch (err)
    {
        console.error("getSNProof error:", err);
        return {
            proof:"",
            proofFacts:[],
            l2ToL1Messages:[],
        }
    }
}
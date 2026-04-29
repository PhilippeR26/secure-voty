"use server";

import { Account, Contract, RpcProvider, type Abi } from "starknet";
import { roundSize, votyContractAddress } from "../constants";


export async function openVote(roundChoice: number) {
    const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const abi: Abi = (await myProvider.getClassAt(votyContractAddress)).abi;
    const account0 = new Account({ address: process.env.STARKNET_ACCOUNT_ADDRESS!, provider: myProvider, signer: process.env.ACCOUNT_PRIVATE_KEY! });
    const votyContract = new Contract({ abi, address: votyContractAddress, providerOrAccount: account0 });
    console.log("account0 address: ", account0.address);
    // const myCalldata1 = votyContract.populate("open_round", {
    //     round, 
    //     vote_size:roundSize,
    // });
    console.log("Opening round ", roundChoice, " with size ", roundSize);
    const res1 = await votyContract.open_round(roundChoice, roundSize);
    const txR1 = await account0.provider.waitForTransaction(res1.transaction_hash);
    if (txR1.isSuccess()) {
        console.log("Round opened successfully");
    } else {
        console.log(txR1);
    }
}

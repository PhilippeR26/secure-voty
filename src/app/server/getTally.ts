"use server";

import { Contract, RpcProvider, type CompiledSierra } from "starknet";
import { round } from "../constants";
import { votyContractAddress } from "../constants";

export async function getTally(): Promise<string[]> {
    const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const votySierra = (await myProvider.getClassAt(votyContractAddress)) as CompiledSierra;
    const votyContract = new Contract({
        abi: votySierra.abi,
        address: votyContractAddress,
        providerOrAccount: myProvider,
    });
    const tally = (await votyContract.get_tally(round)) as bigint[];
    return tally.map(v => v.toString());
}

"use server";

import { Account, Contract, RpcProvider, type Abi } from "starknet";
import type { PrivateInputsForProof, ProveResult, PublicInputsForProof } from "../types";
import type { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
import { requestProof } from "./RequestProof";

const votyContractAddress = "0x62751c14ff5d186f1ec837c7c45345fe555b8eba5e89c641bcb429d748f8f6a"; // Braavos


export async function getSNProof(publicData: PublicInputsForProof, privateData: PrivateInputsForProof, proposedApiKey: string): Promise<ProveResult> {
    // console.log("process.env.STARKNET_RPC_URL=", process.env.STARKNET_RPC_URL);
    // console.log("process.env.STARKNET_ACCOUNT_ADDRESS=", process.env.STARKNET_ACCOUNT_ADDRESS);
    // console.log("process.env.ACCOUNT_PRIVATE_KEY=", process.env.ACCOUNT_PRIVATE_KEY);

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
    console.log("virtual transaction =", tx);
    // const tx: INVOKE_TXN_V3 = {
    //     type: 'INVOKE',
    //     sender_address: '0x0304c822792da45bf6f8e6957aa9515bd7b365f05b5c1678f61ae0c46213251c',
    //     calldata: [
    //         '0x1',
    //         '0x62751c14ff5d186f1ec837c7c45345fe555b8eba5e89c641bcb429d748f8f6a',
    //         '0x1ebfe9bbcb97616537f1b99138aa084dcca02847d532d6c382752811a326f3',
    //         '0x7',
    //         '0x1',
    //         '0x0',
    //         '0x46834de20fe71e56d6cda4502646f55e85e3ec51057913e5774c69bbe184483',
    //         '0x2',
    //         '0x6470e032be23949b12cc95a0afac6d016869a5a9e351d461500c7d4d9e8b872',
    //         '0x61ed79f3eda9549dedad333037a5961d8221a6694aaac6ce3eb7062a5760e40',
    //         '0xbc614e'
    //     ],
    //     signature: [
    //         '0x277071b69181197495d7127842c5c65b790330b6ae1f8fae1d72e981a21cf64',
    //         '0x54bbf9d33bfe8b3cc758fcdcb9f2c678b31b5589cb49b2681064142488a8f4a'
    //     ],
    //     nonce: '0x1c9',
    //     resource_bounds: {
    //         l2_gas: { max_amount: '0x1ef0e4', max_price_per_unit: '0x2cb417800' },
    //         l1_gas: { max_amount: '0xacfe', max_price_per_unit: '0x58163b9c0bdf' },
    //         l1_data_gas: { max_amount: '0xc0', max_price_per_unit: '0x943294cf8' }
    //     },
    //     tip: '0x5f5e100',
    //     paymaster_data: [],
    //     nonce_data_availability_mode: 'L1',
    //     fee_data_availability_mode: 'L1',
    //     account_deployment_data: [],
    //     version: '0x3'
    // }

    const currentBlock: number = await myProvider.getBlockNumber();
    const proofRes: ProveResult = await requestProof(currentBlock, tx);
    console.log("proof size =", proofRes.proof.length, ", start =", proofRes.proof.slice(0, 8), ", end =", proofRes.proof.slice(-8));
    return proofRes;
}
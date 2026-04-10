"use client";

import { Center, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { Contract, json, RpcProvider, type CompiledSierra } from "starknet";
import { round, roundSize } from "../constants";

export default function Results() {
    const [results, setResults] = useState<bigint[]>([]);
    const items = [
        { value: "0", label: "Blank vote" },
        { value: "1", label: "For sure 🕶️" },
        { value: "2", label: "Nop!" },
        { value: "3", label: "Brigitte like them" },
    ];

    async function getTally(): Promise<bigint[]> {
        const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
        const votyContractAddress = "0x5f21a69bf7c0b01ce231c12b459c926a42243f6846f8272ec2e67ccc2551b68";// OZ
        // const sierra = await myProvider.getClassAt(productContractAddress);
        const votySierra = (await myProvider.getClassAt(votyContractAddress)) as CompiledSierra;
        const votyContract = new Contract({
            abi: votySierra.abi,
            address: votyContractAddress,
            providerOrAccount: myProvider,
        });
        const tally = (await votyContract.get_tally(round)) as bigint[];
        return tally;
    }
    useEffect(() => {
        const fetchTally = async () => {
            const tally = await getTally();
            setResults(tally);
        };
        fetchTally();
    }, []);

    return (<Center fontSize="2xl" flexDirection="column" pb={8}>
    <Text>Current results:</Text>
    {results.map((item, i) => (
      <Text key={i}>
        choice {items[i].value} = {items[i].label} : {item.toString()} votes.
      </Text>
    ))}
  </Center>)
}

"use client";

import { Box, Button, Center, RadioGroup, VStack } from "@chakra-ui/react";
import { useStoreChoice } from "./contextChoice";
import { useState } from "react";
import { Toaster, toaster } from "@/components/ui/toaster"
import { checkWhitelist, getRoot } from "../server/voterProofs";
import { CairoBytes31, CallData, hash, num } from "starknet";
import type { L1L2message, PrivateInputsForProof, ProveResult, PublicInputsForProof } from "../types";
import { getSNProof } from "../server/getSNProof";
import { l1l2MessageAbi } from "../const/l1l2MessageAbi";


export default function Choices() {
    const [value, setValue] = useState<string | null>(null);
    const { choice, setChoice, userAuthorized: emailOK, email, secret } = useStoreChoice();

    const items = [
        { value: "1", label: "For sure 🕶️" },
        { value: "2", label: "Nop!" },
        { value: "3", label: "Brigitte like them" },
        { value: "0", label: "Blank vote" },
    ]


    async function handleVote() {
        if (!value) return;
        console.log("Vote for :", value);
        setChoice(Number(value));
        toaster.create({
            description: "Data preparation. Please wait 40 sec...",
            type: "info",
            closable: true,
            duration: 50_000,
        });
        // call backend to generate the proof
        const merkleRoot = await getRoot();
        const vote = value;
        const round = 0;
        // const nullifier = hash.computePoseidonHashOnElements([secret, round]);
        const proof = await checkWhitelist(new CairoBytes31(email).toHexString(), process.env.NEXT_PUBLIC_API_KEY!);
        const memberLeaf = proof.leafHash;
        const memberIndex = proof.index;
        const merkleProof = proof.proof;
        const public_input: PublicInputsForProof = {
            vote,
            round,
        };
        const private_input: PrivateInputsForProof = {
            member_leaf: memberLeaf,
            merkle_proof: merkleProof,
            secret: secret!
        };

        try {
            const proofRes: ProveResult = await getSNProof(public_input, private_input, process.env.NEXT_PUBLIC_API_KEY!);


            const messageCallData = new CallData(l1l2MessageAbi);
            const messageContent = messageCallData.decodeParameters("l1l2message", (proofRes.l2ToL1Messages![0].payload) as string[]);
            const messageFromProof = messageContent as L1L2message;
            console.log({ messageFromProof });

            toaster.create({
                description: "Sending data. Please wait 30 sec...",
                type: "info",
                closable: true,
                duration: 50_000,
            });
            toaster.create({
                description: "Not yet coded 😱. Soon!!!",
                type: "error",
                closable: true,
                duration: 60_000,
            });
            // ************************************************
            // Send on-line tx of verif/action
            // await account.execute(...)
            // ************************************************
        } catch (err) {
            console.error(err);
            toaster.create({
                description: "Error when processing!!!",
                type: "error",
                closable: true,
                duration: 20_000,
            });
        }
    };


    return (
        <>
            {emailOK &&
                <>
                    <Toaster />
                    <Box
                        p={4} mt={3}
                        bg={"lightsteelblue"}
                        opacity={choice !== undefined ? 0.4 : 1}
                        pointerEvents={choice !== undefined ? "none" : "auto"}
                        cursor={choice !== undefined ? "not-allowed" : "default"}
                        transition="opacity 0.5s"
                    >
                        <RadioGroup.Root value={value} size="lg" variant="subtle" onValueChange={(e) => setValue(e.value)}>
                            <VStack gap="6" alignItems="flex-start" >
                                {items.map((item) => (
                                    <RadioGroup.Item key={item.value} value={item.value}>
                                        <RadioGroup.ItemHiddenInput />
                                        <RadioGroup.ItemIndicator />
                                        <RadioGroup.ItemText fontSize={18} >{item.label}</RadioGroup.ItemText>
                                    </RadioGroup.Item>
                                ))}
                            </VStack>
                        </RadioGroup.Root>
                        <Center mt={3}>
                            <Button
                                variant={"surface"}
                                mt={4}
                                colorScheme="blue"
                                disabled={!value}
                                onClick={handleVote}
                                fontSize={"xl"}
                                fontWeight="700"
                            >
                                Vote
                            </Button>
                        </Center>
                    </Box>
                    {choice !== undefined && (
                        <Box
                            mt={4} p={4}
                            bg={"lightsteelblue"}
                            fontSize={"xl"} fontWeight="700"
                        >
                            You voted for: {items.find((item) => item.value === String(choice))?.label}
                        </Box>
                    )}
                </>
            }
        </>
    )
}

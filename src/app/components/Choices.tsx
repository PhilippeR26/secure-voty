"use client";

import { Box, Button, Center, RadioGroup, VStack } from "@chakra-ui/react";
import { useStoreChoice } from "./contextChoice";
import { useRef, useState } from "react";
import { Toaster, toaster } from "@/components/ui/toaster"
import { CallData } from "starknet";
import type { L1L2message, ProveResult, PublicInputsForProof } from "../types";
import { getSNProof } from "../server/getSNProof";
import { l1l2MessageAbi } from "../const/l1l2MessageAbi";
import { sendVote } from "../server/sendVote";
import { round } from "../constants";
import Results from "./Results";


export default function Choices() {
    const [value, setValue] = useState<string | null>(null);
    const [success, setSuccess] = useState<boolean>(false);
    const { choice, setChoice, userAuthorized: emailOK } = useStoreChoice();
    const initialized = useRef(false);

    const items = [
        { value: "1", label: "For sure 🕶️" },
        { value: "2", label: "Nop!" },
        { value: "3", label: "Brigitte like them" },
        { value: "0", label: "Blank vote" },
    ]

    async function handleVote() {
        if (initialized.current) return;
        initialized.current = true;
        if (!value) return;
        setChoice(Number(value));
        toaster.create({
            description: "Data preparation. Please wait 40 sec...",
            type: "info",
            closable: true,
            duration: 50_000,
        });

        const public_input: PublicInputsForProof = { vote: value, round };

        try {
            const proofRes: ProveResult = await getSNProof(public_input);
            console.log("Choice1: proof size =", proofRes.proof.length, ", start =", proofRes.proof.slice(0, 8), ", end =", proofRes.proof.slice(-8));
            if (proofRes.proof.length === 0) {
                toaster.create({
                    description: "Vote not authorized 😱 !!!",
                    type: "error",
                    closable: true,
                    duration: undefined,
                });
            } else {
                const messageCallData = new CallData(l1l2MessageAbi);
                const messageContent = messageCallData.decodeParameters("l1l2message", (proofRes.l2ToL1Messages![0].payload) as string[]);
                const messageFromProof = messageContent as L1L2message;

                toaster.create({
                    description: "Sending data. Please wait 30 sec...",
                    type: "info",
                    closable: true,
                    duration: 50_000,
                });

                const txR2 = await sendVote(proofRes, messageFromProof);
                if (txR2 !== "failed") {
                    setSuccess(true);
                    toaster.create({
                        description: "Vote successfully registered!!!",
                        type: "info",
                        closable: true,
                        duration: undefined,
                    });
                } else {
                    toaster.create({
                        description: "Vote failed 😱 !!!",
                        type: "error",
                        closable: true,
                        duration: undefined,
                    });
                }
            }
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
                            You selected: {items.find((item) => item.value === String(choice))?.label}
                        </Box>
                    )}
                    {success && <Results />}
                </>
            }
        </>
    )
}

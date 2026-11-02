"use client";

import { Box, Button, Center, Link, RadioGroup, VStack } from "@chakra-ui/react";
import { useStoreChoice } from "./contextChoice";
import { useRef, useState } from "react";
import { Toaster, toaster } from "@/components/ui/toaster"
import { CallData } from "starknet";
import type { L1L2message, ProofProgress, ProveResult } from "../types";
import { fetchProof } from "../utils/fetchProof";
import { ProofFailureError } from "../utils/proofFailure";
import { l1l2MessageAbi } from "../const/l1l2MessageAbi";
import { sendVote } from "../server/sendVote";
import { proverInstallGuideUrl } from "../constants";
import Results from "./Results";


// Text of the progress notification while the proof server works.
function progressText(progress: ProofProgress): string {
    if (progress.event === "opening") return "Opening your voting round on the blockchain...";
    if (progress.event === "started") return "Computing the proof. Please wait 40 sec...";
    return `Waiting for the proof server: position ${progress.position}` + (progress.etaSec > 0 ? `, about ${progress.etaSec} s...` : "...");
}

// Tells the voter why no proof was obtained. When the proof server does not answer, the notification links to the guide
// to install one.
function showProofFailure(err: ProofFailureError) {
    const { kind, message } = err.failure;
    toaster.create({
        description: kind === "unreachable"
            ? <>{message}{" "}<Link href={proverInstallGuideUrl} target="_blank" rel="noreferrer" color="white" textDecoration="underline">Install your own proof server</Link></>
            : message,
        type: "error",
        closable: true,
        duration: Infinity,
    });
}

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
        if (initialized.current || !value) return;
        initialized.current = true;
        setChoice(Number(value));
        // one notification, updated at each step
        const progressToast = toaster.create({
            description: "Contacting the proof server...",
            type: "loading",
        });

        let proofObtained = false;

        try {
            const proofRes: ProveResult = await fetchProof(value, (progress) => {
                toaster.update(progressToast, { description: progressText(progress), type: "loading" });
            });
            proofObtained = true;
            console.log("Choice1: proof size =", proofRes.proof.length, ", start =", proofRes.proof.slice(0, 8), ", end =", proofRes.proof.slice(-8));
            const messageCallData = new CallData(l1l2MessageAbi);
            const messageContent = messageCallData.decodeParameters("l1l2message", (proofRes.l2ToL1Messages![0].payload) as string[]);
            const messageFromProof = messageContent as L1L2message;

            toaster.update(progressToast, { description: "Sending data. Please wait 30 sec...", type: "loading" });

            const txR2 = await sendVote(proofRes, messageFromProof);
            toaster.dismiss(progressToast);
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
        } catch (err) {
            toaster.dismiss(progressToast);
            if (err instanceof ProofFailureError) {
                console.error(err.message);
                showProofFailure(err);
            } else {
                console.error(err);
                toaster.create({
                    description: "Error when processing!!!",
                    type: "error",
                    closable: true,
                    duration: 20_000,
                });
            }
            // Without a proof nothing was sent to the blockchain: the voter can try again.
            if (!proofObtained) {
                initialized.current = false;
                setChoice(undefined);
            }
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

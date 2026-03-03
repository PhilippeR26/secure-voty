"use client";

import { Box, Button, Center, RadioGroup, VStack } from "@chakra-ui/react";
import { useStoreChoice } from "./contextChoice";
import { useState } from "react";
import { Toaster, toaster } from "@/components/ui/toaster"
import { checkWhitelist, getRoot } from "../server/voterProofs";
import { CairoBytes31, hash,num } from "starknet";


export default function Choices() {
    const [value, setValue] = useState<string | null>(null);
    const { choice, setChoice, emailOK, email } = useStoreChoice();

    const items = [
        { value: "1", label: "For sure 🕶️" },
        { value: "2", label: "Nop!" },
        { value: "3", label: "Brigitte like them" },
        { value: "0", label: "Blank vote" },
    ]


    async function handleVote() {
        if (!value) return;
        console.log("Vote pour :", value);
        setChoice(Number(value));
        toaster.create({
            description: "Data preparation. Please wait...",
            type: "info",
            closable: true,
            duration: 40_000,
        });
        // call backend to generate the proof
        const merkleRoot = await getRoot();
        const vote = value;
        const secret = "0x123"; // TODO: generate the secret and store it in the state
        const round = 1;
        const nullifier = hash.computePoseidonHashOnElements([secret, round]);
        const proof = await checkWhitelist(new CairoBytes31(email).toHexString());
        const memberLeaf = proof.leafHash;
        const memberIndex = proof.index;
        const merkleProof = proof.proof;
        const params = [
            merkleRoot,
            vote,
            nullifier,
            round,
            memberLeaf,
            memberIndex,
            merkleProof.length,
            ...merkleProof,
            secret
        ];
        console.log("Proof params to send to the backend contract:", params);
        try {
            
             const res = await fetch('http://localhost:4000/prove', { // local backend test
            // const res = await fetch('https://secure-voty-backend-production.up.railway.app/prove', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': process.env.NEXT_PUBLIC_API_KEY||"error_no_api_key",
                },
                body: JSON.stringify({ params: params.map((p) => num.toHex(p)) })
            });

            if (!res.ok) throw new Error('Backend error');

            const data = await res.json();
            if (!data.success) throw new Error(data.error);

            console.log('Proof reçue :', data.proof);
            toaster.create({
                description: "Sending data. Please wait...",
                type: "info",
                closable: true,
                duration: 30_000,
            });
            // → Construis ta tx Starknet avec data.proof (ex. calldata avec proof_span + publics)
            // await account.execute(...)
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

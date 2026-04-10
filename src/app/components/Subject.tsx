"use client";

import { Box, Center } from "@chakra-ui/react";
import { useStoreChoice } from "./contextChoice";
import { useEffect, useRef } from "react";
import { round } from "../constants";
import { openVote } from "../server/openVote";

export default function Subject() {
    const { userAuthorized: emailOK } = useStoreChoice();
    const initialized = useRef(false);

    async function initRound() {
        if (initialized.current) return;
        initialized.current = true;
        await openVote(round, process.env.NEXT_PUBLIC_API_KEY!)
    }
    useEffect(() => {
        initRound();
    }
        , []
    );

    return (
        <>
            {emailOK && (<>
                <Box pt={5}>
                    <Center fontSize="2xl">
                        Subject:
                    </Center>
                    <Center fontSize="xl">
                        Do you like Macron&apos;s sunglasses?
                    </Center>
                </Box>
            </>
            )}
        </>
    )
}

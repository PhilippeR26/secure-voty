"use client";

import { Box, Center } from "@chakra-ui/react";
import { useStoreChoice } from "./contextChoice";

export default function Subject() {
    const { emailOK } = useStoreChoice();

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

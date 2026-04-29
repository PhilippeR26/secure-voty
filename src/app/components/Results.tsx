"use client";

import { Center, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { getTally } from "../server/getTally";

export default function Results() {
    const [results, setResults] = useState<string[]>([]);
    const items = [
        { value: "0", label: "Blank vote" },
        { value: "1", label: "For sure 🕶️" },
        { value: "2", label: "Nop!" },
        { value: "3", label: "Brigitte like them" },
    ];

    useEffect(() => {
        getTally().then(setResults);
    }, []);

    return (
        <Center fontSize="2xl" flexDirection="column" pb={8}>
            <Text>Current results:</Text>
            {results.map((count, i) => (
                <Text key={i}>
                    choice {items[i].value} = {items[i].label} : {count} votes.
                </Text>
            ))}
        </Center>
    );
}

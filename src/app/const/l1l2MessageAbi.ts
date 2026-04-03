import type { Abi } from "starknet";

export const l1l2MessageAbi: Abi = [
    {
        "type": "struct",
        "name": "l1l2message",
        "members": [
            {
                "name": "round",
                "type": "core::integer::u32"
            },
            {
                "name": "nullifier",
                "type": "core::felt252"
            },
            {
                "name": "vote",
                "type": "core::integer::u8"
            },
        ]
    },
    {
        "type": "interface",
        "name": "secure_voty::Null",
        "items": []
    }
]


"use server";

import { CairoBytes31 } from "starknet";
import { checkWhitelist, checkSecret } from "./voterProofs";
import { createSession } from "./session";
import { openRound, randomRound } from "./votingRound";

export type AuthResult = {
    isWhiteListed: boolean;
    secretValid: boolean;
};

export async function authenticate(email: string, secret: string): Promise<AuthResult> {
    const emailEncoded = new CairoBytes31(email).toHexString();
    const proof = await checkWhitelist(emailEncoded);
    if (!proof.isWhiteListed) {
        return { isWhiteListed: false, secretValid: false };
    }
    const secretValid = await checkSecret(emailEncoded, secret);
    if (secretValid) {
        // Demo: each login votes in a round of its own, opened on-chain here (normally done by an admin).
        const round = randomRound();
        let openTxHash: string | undefined;
        try {
            openTxHash = await openRound(round);
        } catch (err) {
            // Not blocking: ensureRoundOpen() opens the round when the voter votes.
            console.error("authenticate: open_round not sent:", err);
        }
        await createSession(emailEncoded, secret, round, openTxHash);
    }
    return { isWhiteListed: true, secretValid };
}

"use server";

import { CairoBytes31 } from "starknet";
import { checkWhitelist, checkSecret } from "./voterProofs";
import { createSession } from "./session";

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
        await createSession(emailEncoded, secret);
    }
    return { isWhiteListed: true, secretValid };
}

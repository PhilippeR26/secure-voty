"use server";

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

const SESSION_COOKIE = "voty_session";
const SESSION_TTL_S = 7200; // 2 hours

interface SessionData {
    emailEncoded: string;
    secret: string;
    round: number; // voting round of this session, drawn at login
    openTxHash?: string; // open_round() transaction sent at login, if it could be sent
    exp: number;
}

function sign(payload: string): string {
    return createHmac("sha256", process.env.SESSION_SECRET!)
        .update(payload)
        .digest("base64url");
}

export async function createSession(emailEncoded: string, secret: string, round: number, openTxHash?: string): Promise<void> {
    const data: SessionData = {
        emailEncoded,
        secret,
        round,
        openTxHash,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    };
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const sig = sign(payload);
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE, `${payload}.${sig}`, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: SESSION_TTL_S,
    });
}

export async function verifySession(): Promise<SessionData> {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) throw new Error("No active session");

    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) throw new Error("Malformed session");
    const payload = token.slice(0, dotIndex);
    const sig = token.slice(dotIndex + 1);

    const expectedSig = sign(payload);
    const sigBuf = Buffer.from(sig, "base64url");
    const expectedBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        throw new Error("Invalid session");
    }

    const data: SessionData = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Math.floor(Date.now() / 1000)) {
        throw new Error("Session expired");
    }
    // A cookie issued before the rounds were drawn at login has no round: the voter has to log in again.
    if (typeof data.round !== "number") throw new Error("Session without round");

    return data;
}

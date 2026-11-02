import type { ProofFailure, PublicInputsForProof } from "../../types";
import { ProofFailureError } from "../../utils/proofFailure";
import { buildProofTx } from "../../server/buildProofTx";
import { checkProofServer } from "../../server/checkProofServer";
import { requestProof } from "../../server/RequestProof";
import { verifySession } from "../../server/session";
import { ensureRoundOpen } from "../../server/votingRound";

const PING_MS = 15_000;

// The round is not read from the request: it is the one of the session, drawn by the server at login.
function voteFrom(body: unknown): PublicInputsForProof["vote"] {
    const { vote } = (body ?? {}) as { vote?: unknown };
    if (typeof vote !== "string" && typeof vote !== "number") {
        throw new ProofFailureError("Invalid request body", { kind: "internal", message: "Unexpected error: invalid request." });
    }
    return vote;
}

// The voter of the session cookie. A missing or expired session is a failure to tell the voter about.
async function sessionOf(): Promise<Awaited<ReturnType<typeof verifySession>>> {
    try {
        return await verifySession();
    } catch (err) {
        throw new ProofFailureError(`Session refused: ${(err as Error).message}`, {
            kind: "no_session",
            message: "Your session expired: enter your email and secret again.",
        });
    }
}

// What the voter is told about an error. The technical details stay in the log of the DAPP server: they can hold the
// address of the proof server or of the Starknet node.
function failureOf(err: unknown): ProofFailure {
    if (err instanceof ProofFailureError) {
        console.error("api/prove:", err.message);
        return err.failure;
    }
    console.error("api/prove:", err);
    return { kind: "internal", message: "Unexpected error: see the log of the DAPP server." };
}

// POST { vote } -> server-sent events: "opening" if the round of the session is not open yet, "queued" and "started"
// while the proof server works, then "done" (the proof) or "error" ({ failure }). The voter and the round are the ones
// of the session cookie.
export async function POST(request: Request): Promise<Response> {
    const encoder = new TextEncoder();
    const browserLeft = new AbortController(); // the browser closed the stream: withdraw the request from the proof server
    let open = true;
    let ping: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (chunk: string) => {
                if (!open) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    open = false; // the stream is already closed
                }
            };
            const sendEvent = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            // keeps the connection alive while the proof server makes the voter wait
            ping = setInterval(() => send(": ping\n\n"), PING_MS);
            const signal = AbortSignal.any([request.signal, browserLeft.signal]);
            try {
                const vote = voteFrom(await request.json().catch(() => undefined));
                await checkProofServer(signal);
                const session = await sessionOf();
                // The round was sent to the blockchain at login; wait for it only if it is not open yet.
                await ensureRoundOpen(session.round, session.openTxHash, () => sendEvent("opening", { event: "opening" }));
                const { tx, currentBlock } = await buildProofTx(session, vote);
                const proof = await requestProof(currentBlock, tx, {
                    signal,
                    onProgress: (progress) => sendEvent(progress.event, progress),
                });
                sendEvent("done", proof);
            } catch (err) {
                if (open) sendEvent("error", { failure: failureOf(err) });
            } finally {
                clearInterval(ping);
                if (open) {
                    open = false;
                    controller.close();
                }
            }
        },
        cancel() {
            open = false;
            clearInterval(ping);
            browserLeft.abort();
        },
    });
    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        },
    });
}

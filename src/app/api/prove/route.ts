import type { ProofFailure, PublicInputsForProof } from "../../types";
import { ProofFailureError } from "../../utils/proofFailure";
import { buildProofTx } from "../../server/buildProofTx";
import { checkProofServer } from "../../server/checkProofServer";
import { requestProof } from "../../server/RequestProof";

const PING_MS = 15_000;

function publicDataFrom(body: unknown): PublicInputsForProof {
    const { vote, round } = (body ?? {}) as { vote?: unknown; round?: unknown };
    const isNumeric = (value: unknown): value is string | number => typeof value === "string" || typeof value === "number";
    if (!isNumeric(vote) || !isNumeric(round)) {
        throw new ProofFailureError("Invalid request body", { kind: "internal", message: "Unexpected error: invalid request." });
    }
    return { vote, round };
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

// POST { vote, round } -> server-sent events: "queued" and "started" while the proof server works, then "done" (the
// proof) or "error" ({ failure }). The voter is the one of the session cookie.
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
                const publicData = publicDataFrom(await request.json().catch(() => undefined));
                await checkProofServer(signal);
                const { tx, currentBlock } = await buildProofTx(publicData);
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

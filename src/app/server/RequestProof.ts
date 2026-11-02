// send a virtual transaction to a execute/proof server

import type { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
import type { ProofFailure, ProofProgress, ProveResult } from "../types";
import { ProofFailureError } from "../utils/proofFailure";
import { readSseStream } from "../utils/sseStream";

// The proof server is PROOF_SERVER_URL (default: the one of this machine). A public one needs the key of the
// site in PROOF_SERVER_API_KEY.
export function proofServerUrl(): string {
    return (process.env.PROOF_SERVER_URL || "http://localhost:3030").replace(/\/+$/, "");
}

// "in 45 s", "in 12 min", "in 3 h 20 min", or "later" when the proof server gave no delay.
function inHowLong(sec?: number): string {
    if (sec === undefined) return "later";
    if (sec < 120) return `in ${sec} s`;
    const minutes = Math.ceil(sec / 60);
    const h = Math.floor(minutes / 60);
    const min = minutes % 60;
    if (h === 0) return `in ${min} min`;
    return min === 0 ? `in ${h} h` : `in ${h} h ${min} min`;
}

// What the voter is told when the proof server refuses a request, from the status and the reason it gives.
function refusalFailure(status: number, reason: string, retryAfterSec?: number): ProofFailure {
    if (status === 401 || status === 403) {
        return {
            kind: "refused",
            message: `The proof server refuses this DAPP (${status} ${reason}): check PROOF_SERVER_URL and PROOF_SERVER_API_KEY.`,
        };
    }
    if (status === 404) {
        return { kind: "refused", message: "The proof server has no such address (404): check PROOF_SERVER_URL." };
    }
    if (status === 429 && reason === "quota_exceeded") {
        return {
            kind: "quota",
            message: `Daily proof quota of this DAPP reached; try again ${inHowLong(retryAfterSec)} (00:00 UTC).`,
            retryAfterSec,
        };
    }
    if (status === 429 || status === 503) {
        return { kind: "busy", message: `The proof server is busy; try again ${inHowLong(retryAfterSec)}.`, retryAfterSec };
    }
    return { kind: "internal", message: `Unexpected error: the proof server answered ${status} ${reason}.` };
}

// Why the proof server refused a request (it answers with JSON, before any stream): status, reason, message,
// and when to try again.
export async function refusal(response: Response): Promise<ProofFailureError> {
    let reason = response.statusText;
    let error = "";
    try {
        const body = (await response.json()) as { reason?: string; error?: string };
        reason = body.reason ?? reason;
        error = body.error ?? "";
    } catch {
        // no JSON body: the status is all there is
    }
    const retryAfter = response.headers.get("retry-after");
    const message =
        `Proof server refused the request: ${response.status} ${reason}` +
        (error ? ` — ${error}` : "") +
        (retryAfter ? `; retry after ${retryAfter} s` : "");
    const retryAfterSec = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    return new ProofFailureError(message, refusalFailure(response.status, reason, retryAfterSec));
}

// No answer at all from the proof server. Its address stays in the technical message: the voter never sees it.
export function unreachable(baseUrl: string, err: unknown): ProofFailureError {
    const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    return new ProofFailureError(`Proof server unreachable at ${baseUrl}: ${cause}`, {
        kind: "unreachable",
        message: "The proof server does not answer.",
    });
}

export interface RequestProofOptions {
    onProgress?: (progress: ProofProgress) => void; // the place in the queue, then the start of the proof
    signal?: AbortSignal; // aborting it withdraws the request from the proof server
}

export async function requestProof(
    currentBlock: number,
    tx: INVOKE_TXN_V3,
    opts: RequestProofOptions = {},
): Promise<ProveResult> {
    const baseUrl = proofServerUrl();
    const apiKey = process.env.PROOF_SERVER_API_KEY;
    let response: Response;
    try {
        response = await fetch(`${baseUrl}/prove`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                blockNumber: currentBlock,
                tx,
            }),
            signal: opts.signal,
        });
    } catch (err) {
        throw unreachable(baseUrl, err);
    }
    if (!response.ok) {
        throw await refusal(response);
    }
    const outcome: { proof?: ProveResult; failure?: ProofFailureError } = {};
    try {
        await readSseStream(response.body!, (event, raw) => {
            const data = raw as { position?: number; etaSec?: number; stream?: string; line?: string; message?: string; stderr?: string };
            if (event === "queued") {
                console.log(`queued: position ${data.position}, estimated wait ${data.etaSec} s`);
                opts.onProgress?.({ event: "queued", position: Number(data.position), etaSec: Number(data.etaSec) });
            }
            if (event === "started") {
                console.log("proof started");
                opts.onProgress?.({ event: "started" });
            }
            if (event === "log") {
                console.log(`[${data.stream}]`, data.line);
            }
            if (event === "done") {
                const proof = raw as ProveResult;
                outcome.proof = proof;
                console.log("proof length:", proof.proof.length);
                console.log("proofFacts:", proof.proofFacts);
                if (proof.l2ToL1Messages) {
                    console.log("l2ToL1Messages:", proof.l2ToL1Messages);
                }
            }
            if (event === "error") {
                console.error("Error:", data.message, data.stderr);
                outcome.failure = new ProofFailureError(`Proof server error: ${data.message}`, {
                    kind: "proof_failed",
                    message: String(data.message),
                });
            }
        });
    } catch (err) {
        throw unreachable(baseUrl, err);
    }
    if (outcome.failure) {
        throw outcome.failure;
    }
    if (!outcome.proof) {
        throw new ProofFailureError("Problem encountered to generate proof!!!", {
            kind: "unreachable",
            message: "The proof server stopped answering before the end of the proof.",
        });
    }
    return outcome.proof;
}

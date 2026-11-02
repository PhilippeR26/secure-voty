import type { ProofFailure, ProofProgress, ProveResult, PublicInputsForProof } from "../types";
import { ProofFailureError } from "./proofFailure";
import { readSseStream } from "./sseStream";

// Browser side: asks the DAPP server (route /api/prove) for the proof of a vote. onProgress is called with the
// place in the queue of the proof server, then when the proof starts. Throws a ProofFailureError whose `failure`
// says what to tell the voter.
export async function fetchProof(
    publicData: PublicInputsForProof,
    onProgress: (progress: ProofProgress) => void,
): Promise<ProveResult> {
    let response: Response;
    try {
        response = await fetch("/api/prove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(publicData),
        });
    } catch (err) {
        throw new ProofFailureError(`Cannot reach /api/prove: ${err instanceof Error ? err.message : String(err)}`, {
            kind: "internal",
            message: "The DAPP server does not answer.",
        });
    }
    if (!response.ok || !response.body) {
        throw new ProofFailureError(`/api/prove answered ${response.status}`, {
            kind: "internal",
            message: `Unexpected error: the DAPP server answered ${response.status}.`,
        });
    }
    let proof: ProveResult | undefined;
    let failure: ProofFailure | undefined;
    try {
        await readSseStream(response.body, (event, data) => {
            if (event === "queued" || event === "started") onProgress(data as ProofProgress);
            if (event === "done") proof = data as ProveResult;
            if (event === "error") failure = (data as { failure: ProofFailure }).failure;
        });
    } catch (err) {
        throw new ProofFailureError(`/api/prove stream cut: ${err instanceof Error ? err.message : String(err)}`, {
            kind: "internal",
            message: "The connection with the DAPP server was lost.",
        });
    }
    if (failure) {
        throw new ProofFailureError(failure.message, failure);
    }
    if (!proof) {
        throw new ProofFailureError("/api/prove ended without proof", {
            kind: "internal",
            message: "The connection with the DAPP server was lost.",
        });
    }
    return proof;
}

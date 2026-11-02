// Quick check of the proof server, made before building and signing the transaction.

import { constants } from "starknet";
import { ProofFailureError } from "../utils/proofFailure";
import { proofServerUrl, refusal, unreachable } from "./RequestProof";

const HEALTH_TIMEOUT_MS = 10_000;

// A proof server is started on one network and names it like this (NETWORK in its instances/<name>.env).
// starknet.js has the names of the chains but not these ones, so the correspondence is written here.
const PROOF_SERVER_NETWORK: Record<string, string> = {
    [constants.NetworkName.SN_MAIN]: "mainnet",
    [constants.NetworkName.SN_SEPOLIA]: "sepolia",
};

// Throws a ProofFailureError when the proof server does not answer, is shutting down, or proves another network
// than the one of this DAPP (STARKNET_CHAIN_ID).
export async function checkProofServer(signal?: AbortSignal): Promise<void> {
    const baseUrl = proofServerUrl();
    const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
    let response: Response;
    let health: { ok: boolean; network: string };
    try {
        response = await fetch(`${baseUrl}/health`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) {
            throw await refusal(response);
        }
        health = await response.json();
    } catch (err) {
        // a refusal is already a ProofFailureError; anything else (no answer, not JSON) means no proof server here
        throw err instanceof ProofFailureError ? err : unreachable(baseUrl, err);
    }
    if (!health.ok) {
        throw new ProofFailureError("Proof server is shutting down", {
            kind: "busy",
            message: "The proof server is shutting down; try again later.",
        });
    }
    const dappNetwork = PROOF_SERVER_NETWORK[process.env.STARKNET_CHAIN_ID ?? ""];
    if (dappNetwork && health.network !== dappNetwork) {
        throw new ProofFailureError(`Proof server proves ${health.network}, this DAPP runs on ${dappNetwork}`, {
            kind: "network_mismatch",
            message: `The proof server proves ${health.network}, but this DAPP runs on ${dappNetwork}.`,
        });
    }
}

import type { ProofFailure } from "../types";

// An error that also carries what the voter should be told (failure). Its own message stays technical: it goes to
// the logs of the DAPP server, and the scripts and tests rely on it.
export class ProofFailureError extends Error {
    readonly failure: ProofFailure;

    constructor(message: string, failure: ProofFailure) {
        super(message);
        this.name = "ProofFailureError";
        this.failure = failure;
    }
}

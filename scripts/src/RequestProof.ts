// send a virtual transaction to a execute/proof server

import type { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0102";
import type { BigNumberish } from "starknet";

export type ProofMessage = {
    from_address: BigNumberish;
    payload: BigNumberish[];
    to_address: BigNumberish;
}

export type ProveResult = {
    proof: string;
    proofFacts: BigNumberish[];
    l2ToL1Messages?: ProofMessage[];
}

export type L1L2message = {
    round: BigNumberish;
    nullifier: BigNumberish;
    vote: BigNumberish;
}

// Why the proof server refused a request (it answers with JSON, before any stream): status, reason, message,
// and when to try again.
async function refusalMessage(response: Response): Promise<string> {
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
    return (
        `Proof server refused the request: ${response.status} ${reason}` +
        (error ? ` — ${error}` : "") +
        (retryAfter ? `; retry after ${retryAfter} s` : "")
    );
}

// The proof server is PROOF_SERVER_URL (default: the one of this machine). A public one needs the key of the
// site in PROOF_SERVER_API_KEY.
export async function requestProof(currentBlock: number, tx: INVOKE_TXN_V3): Promise<ProveResult> {
    const baseUrl = (process.env.PROOF_SERVER_URL || "http://localhost:3030").replace(/\/+$/, "");
    const apiKey = process.env.PROOF_SERVER_API_KEY;
    const response = await fetch(`${baseUrl}/prove`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
            blockNumber: currentBlock,
            tx,
        }),
    });
    if (!response.ok) {
        throw new Error(await refusalMessage(response));
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; // store chunks
    let proofRes: ProveResult | undefined = undefined;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // a SSE message is delimited by \n\n
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const message of messages) {
            if (!message.trim()) continue;
            const eventMatch = message.match(/^event: (\w+)/);
            const dataMatch = message.match(/^data: (.+)$/m);
            if (!eventMatch || !dataMatch) continue;
            const event = eventMatch[1];
            const data = JSON.parse(dataMatch[1]);
            if (event === "queued") {
                console.log(`queued: position ${data.position}, estimated wait ${data.etaSec} s`);
            }
            if (event === "started") {
                console.log("proof started");
            }
            if (event === "log") {
                console.log(`[${data.stream}]`, data.line);
            }
            if (event === "done") {
                proofRes = data;
                console.log("proof length:", data.proof.length);
                console.log("proofFacts:", data.proofFacts);
                if (data.l2ToL1Messages) {
                    console.log("l2ToL1Messages:", data.l2ToL1Messages);
                }
            }
            if (event === "error") {
                console.error("Error:", data.message, data.stderr);
            }
        }
    }
    if (!proofRes) {
        throw new Error("Problem encountered to generate proof!!!");
    }
    return proofRes;
}

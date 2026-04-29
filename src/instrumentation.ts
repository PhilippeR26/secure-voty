// Launched at start (when using `npm run dev`).
// Normally executed by the admin of the vote.
import { openVote } from "./app/server/openVote";
import { round } from "./app/constants";

export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        try {
            await openVote(round);
            console.log("Demo: voting round opened.");
        } catch (err) {
            // Round may already be open — not blocking for the demo
            console.log("Demo: openVote at startup:", err);
        }
    }
}

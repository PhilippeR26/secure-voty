import path from "path";
import { ProofOutput } from "../../src/prover";

// Test double of `snip36 prove virtual-os` and what it writes in FAKE_MODE=ok.
export const FAKE_SNIP36 = path.resolve(__dirname, "../fake-snip36.sh");

export const FAKE_OUT: ProofOutput = {
  proof: "FAKEPROOF",
  proofFacts: ["0x1", "0x2"],
  l2ToL1Messages: [{ from_address: "0xa", to_address: "0xb", payload: ["0x1"] }],
};

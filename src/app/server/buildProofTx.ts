import { Account, Contract, RpcProvider, type Abi } from "starknet";
import type { PrivateInputsForProof, PublicInputsForProof } from "../types";
import type { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
import { votyContractAddress } from "../constants";
import { ProofFailureError } from "../utils/proofFailure";
import { verifySession } from "./session";
import { checkWhitelist } from "./voterProofs";

// Builds the create_proof() transaction of the voter of the current session, signed but not broadcast, and the
// block it will be executed against. Server side only: it uses the key of the DAPP account.
export async function buildProofTx(publicData: PublicInputsForProof): Promise<{ tx: INVOKE_TXN_V3; currentBlock: number }> {
    let session: Awaited<ReturnType<typeof verifySession>>;
    try {
        session = await verifySession();
    } catch (err) {
        throw new ProofFailureError(`Session refused: ${(err as Error).message}`, {
            kind: "no_session",
            message: "Your session expired: enter your email and secret again.",
        });
    }

    const proofData = await checkWhitelist(session.emailEncoded);
    const privateData: PrivateInputsForProof = {
        member_leaf: proofData.leafHash,
        merkle_proof: proofData.proof,
        secret: session.secret,
    };

    const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const abi: Abi = (await myProvider.getClassAt(votyContractAddress)).abi;
    const account0 = new Account({ address: process.env.STARKNET_ACCOUNT_ADDRESS!, provider: myProvider, signer: process.env.ACCOUNT_PRIVATE_KEY! });
    const votyContract = new Contract({ abi, address: votyContractAddress, providerOrAccount: account0 });

    const myCalldata = votyContract.populate("create_proof", {
        public_input: publicData,
        private_input: privateData,
    });
    // getSignedTransaction() builds and signs the INVOKE V3 tx without broadcasting it, so that the proof server can execute it virtually.
    const tx: INVOKE_TXN_V3 = await account0.getSignedTransaction(myCalldata);

    const currentBlock: number = await myProvider.getBlockNumber();
    return { tx, currentBlock };
}

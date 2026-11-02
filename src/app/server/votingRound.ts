import { randomInt } from "crypto";
import { Account, Contract, RpcProvider, constants, type Abi } from "starknet";
import { roundSize, votyContractAddress } from "../constants";
import { ProofFailureError } from "../utils/proofFailure";

// Server side only: the account of the DAPP owns the contract, and only the owner can open a round.
async function dappVotyContract(): Promise<{ provider: RpcProvider; contract: Contract }> {
    const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const abi: Abi = (await provider.getClassAt(votyContractAddress)).abi;
    const account0 = new Account({ address: process.env.STARKNET_ACCOUNT_ADDRESS!, provider, signer: process.env.ACCOUNT_PRIVATE_KEY! });
    return { provider, contract: new Contract({ abi, address: votyContractAddress, providerOrAccount: account0 }) };
}

// A random round (u32), so that each login of the demo voter votes in a round of its own. 0 is left to the scripts.
export function randomRound(): number {
    return randomInt(1, Number(constants.RANGE_U32.max) + 1);
}

// Sends open_round() and returns the hash of the transaction without waiting for its block: the voter takes time to
// choose, so the round is most often open when the vote starts (see ensureRoundOpen).
export async function openRound(round: number): Promise<string> {
    const { contract } = await dappVotyContract();
    console.log("Opening round", round, "with size", roundSize);
    const res = await contract.open_round(round, roundSize);
    return res.transaction_hash;
}

// The failure of a transaction is only logged: ensureRoundOpen() decides from the state of the round.
async function waitForTransactionQuietly(provider: RpcProvider, txHash: string): Promise<void> {
    try {
        await provider.waitForTransaction(txHash);
    } catch (err) {
        console.error("Transaction", txHash, "not accepted:", err);
    }
}

// Makes sure the round is open in the latest block, so that create_proof() does not fail in the proof server with
// `Vote is not open`. openTxHash is the transaction sent at login, if any; onOpening() is called when it is necessary
// to wait. Throws a ProofFailureError when the round cannot be opened.
export async function ensureRoundOpen(round: number, openTxHash: string | undefined, onOpening: () => void): Promise<void> {
    const { provider, contract } = await dappVotyContract();
    // The deployed contract has no is_round_open(). get_tally() has one entry per choice once open_round() has run
    // (it requires vote_size > 0), none before: enough here, since the DAPP never closes its rounds.
    const isOpen = async (): Promise<boolean> => ((await contract.get_tally(round)) as bigint[]).length > 0;

    if (await isOpen()) return;
    onOpening();
    if (openTxHash) {
        await waitForTransactionQuietly(provider, openTxHash);
        if (await isOpen()) return;
    }
    // No transaction was sent at login, or it was lost or reverted: send it again.
    try {
        const res = await contract.open_round(round, roundSize);
        await waitForTransactionQuietly(provider, res.transaction_hash);
    } catch (err) {
        console.error("open_round of round", round, "failed:", err);
    }
    if (await isOpen()) return;
    throw new ProofFailureError(`Round ${round} is not open after open_round`, {
        kind: "round_unavailable",
        message: "Your voting round could not be opened on the blockchain: reload the page and log in again.",
    });
}

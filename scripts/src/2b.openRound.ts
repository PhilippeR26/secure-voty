// Open a voting round on the Voty contract.
// Must be called once by the admin before the voting session begins.
// Launch with: npx ts-node ./src/2b.openRound.ts

import { Account, Contract, RpcProvider, type Abi } from "starknet";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const votyContractAddress = "0x5f21a69bf7c0b01ce231c12b459c926a42243f6846f8272ec2e67ccc2551b68";
const round = 0;
const roundSize = 4;

async function main() {
    const myProvider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
    const abi: Abi = (await myProvider.getClassAt(votyContractAddress)).abi;
    const account0 = new Account({
        address: process.env.STARKNET_ACCOUNT_ADDRESS!,
        provider: myProvider,
        signer: process.env.ACCOUNT_PRIVATE_KEY!,
    });
    const votyContract = new Contract({ abi, address: votyContractAddress, providerOrAccount: account0 });

    console.log("Opening round", round, "with size", roundSize, "...");
    const res = await votyContract.open_round(round, roundSize);
    const tx = await account0.provider.waitForTransaction(res.transaction_hash);
    if (tx.isSuccess()) {
        console.log("Round opened successfully. tx:", res.transaction_hash);
    } else {
        console.error("Failed to open round:", tx);
        process.exit(1);
    }
}

main().catch(err => { console.error(err); process.exit(1); });

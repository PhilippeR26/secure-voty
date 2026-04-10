// Create a virtual transaction in Integration Sepolia
// Launch with npx ts-node ./src/5.sendProof.ts
// Coded with Starknet.js v10.0.0 (experimental branch buildExecute) & Pathfinder v0.22.0

import { RpcProvider, Account, Contract, json, num, hash, type CompiledSierra, CairoBytes31, type BigNumberish, CallData, config } from "starknet";
import { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0102";
// import { account1BraavosSepoliaAddress, account1BraavosSepoliaPrivateKey, junoNMtestnet } from "../A1priv/A1priv";
// import { account1BraavosMainnetAddress, account1BraavosMainnetPrivateKey, alchemyKey, infuraKey } from "../A-MainPriv/mainPriv";
import { DevnetProvider } from "starknet-devnet";
import * as Merkle from "starknet-merkle-tree";

import fs from "fs";
import * as dotenv from "dotenv";
import { account1BraavosSepoliaAddress, account1BraavosSepoliaPrivateKey, account3ArgentXSepoliaAddress, account3ArgentXSepoliaPrivateKey, accountSTRKoz20snip9Address, accountSTRKoz20snip9PrivateKey, alchemyKey } from "./secretNetwork";
import { l1l2MessageAbi } from "./l1l2MessageAbi";
import { requestProof, type L1L2message, type ProveResult } from "./RequestProof";

dotenv.config({ quiet: true });


//          👇👇👇
// 🚨🚨🚨   If necessary, launch Devnet before using this script.
//          👆👆👆


async function main() {
  // ******** Devnet
  // const myProvider = new RpcProvider({ nodeUrl: "http://127.0.0.1:5050/rpc" });
  // const devnet = new DevnetProvider({ timeout: 40_000 });
  // if (!(await devnet.isAlive())) {
  //   console.log("No l2 devnet.");
  //   process.exit();
  // }

  // ***** Sepolia Testnet 
  // const myProvider = new RpcProvider({ nodeUrl: "http://192.168.1.34:9545/rpc/v0_10" }); // local Sepolia Testnet node (starlink)
  const myProvider = new RpcProvider({ nodeUrl: "http://192.168.1.26:9545/rpc/v0_10" }); // local Sepolia Testnet node (FreeBox, wire)
  // const myProvider = new RpcProvider({ nodeUrl: "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/" + alchemyKey });

  // ****** Starknet v0.14.2 integration Sepolia
  // const myProvider = new RpcProvider({ nodeUrl: AdrienIntegrationUrl });
  // const myProvider = new RpcProvider({ nodeUrl: "http://192.168.1.26:9550/rpc/v0_10" }); // local Sepolia Integration node (Freebox)

  // ***** Mainnet
  // const myProvider = new RpcProvider({ nodeUrl: "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/" + alchemyKey }); 

  // config.set('legacyMode', true);
  // logger.setLogLevel('ERROR');

  const bl = await myProvider.getBlock();
  console.log(
    "chain Id =", new CairoBytes31(await myProvider.getChainId()).decodeUtf8(),
    ", rpc", await myProvider.getSpecVersion(),
    ", SN version =", bl.starknet_version,
    ", block #", bl.block_number,
  );
  console.log("Provider connected to Starknet");

  // initialize existing predeployed account 0 of Devnet
  // const devnetAccounts = await devnet.getPredeployedAccounts();
  // const accountAddress0 = devnetAccounts[0].address;
  // const privateKey0 = devnetAccounts[0].private_key;
  // **** Sepolia
  //  const accountAddress0 = account1BraavosSepoliaAddress;
  //  const privateKey0 = account1BraavosSepoliaPrivateKey;
  // const accountAddress0 = account3ArgentXSepoliaAddress;
  // const privateKey0 = account3ArgentXSepoliaPrivateKey;
  const accountAddress0 = accountSTRKoz20snip9Address;
  const privateKey0 = accountSTRKoz20snip9PrivateKey;
  // **** SN0.14.2 Integration Sepolia
  // const accountAddress0 = accountIntegrationAdrienAddress;
  // const privateKey0 = accountIntegrationAdrienPrivateKey;
  // const accountAddress0 = account3IntegrationOZ17address;
  // const privateKey0 = account3IntegrationOZ17privateKey;
  // **** Mainnet
  //  const accountAddress0 = account1BraavosMainnetAddress;
  //  const privateKey0 = account1BraavosMainnetPrivateKey;

  const account0 = new Account({ provider: myProvider, address: accountAddress0, signer: privateKey0 }
  );
  console.log("Account connected.\n");


  // main
  const votyContractAddress = "0x5f21a69bf7c0b01ce231c12b459c926a42243f6846f8272ec2e67ccc2551b68";// OZ
  // const sierra = await myProvider.getClassAt(productContractAddress);
  const votySierra = json.parse(fs.readFileSync("../cairoContract/voty/target/release/secure_voty_PrivateVoteVerifierMultiRound.contract_class.json").toString("ascii")) as CompiledSierra;
  const votyContract = new Contract({
    abi: votySierra.abi,
    address: votyContractAddress,
    providerOrAccount: account0,
  });
  console.log("functions =", votyContract.functions);
  console.log("constructor =", votySierra.abi.find((item) => item.type == "constructor"));

  const myNonce = BigInt(await account0.getNonce());
  console.log("nonce =", num.toHex(myNonce));

  console.log("owner addr =", num.toHex(await votyContract.get_owner()));

  const proofData = json.parse(fs.readFileSync("./output/proofData.json").toString("ascii")) as { proofRes: ProveResult, messageFromProof: L1L2message };

  const proof = proofData.proofRes.proof;
  console.log("proof size =", proof.length, ", start =", proof.slice(0, 8), ", end =", proof.slice(-8));
  const proofFacts = proofData.proofRes.proofFacts;
  const message: L1L2message = proofData.messageFromProof;

  // ------- Execute a tx onchain using the proof
  const myCalldata2 = votyContract.populate("verify_vote", {
    public_message: message,
  });
  console.log("Test...");
  const res2 = await account0.execute(myCalldata2, { proof, proofFacts });
  const txR2 = await account0.provider.waitForTransaction(res2.transaction_hash);
  console.log(txR2);

  console.log("✅ Test performed.");
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
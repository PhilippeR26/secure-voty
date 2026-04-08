// Create a virtual transaction in Integration Sepolia
// Launch with npx ts-node ./src/4.getProof.ts
// Coded with Starknet.js v10.0.0 (experimental branch buildExecute) & devnet v0.4.2

import { RpcProvider, Account, Contract, json, num, hash, type CompiledSierra, CairoBytes31, type BigNumberish, CallData, config } from "starknet";
import { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
// import { account1BraavosSepoliaAddress, account1BraavosSepoliaPrivateKey, junoNMtestnet } from "../A1priv/A1priv";
// import { account1BraavosMainnetAddress, account1BraavosMainnetPrivateKey, alchemyKey, infuraKey } from "../A-MainPriv/mainPriv";
import { DevnetProvider } from "starknet-devnet";
import * as Merkle from "starknet-merkle-tree";

import fs from "fs";
import * as dotenv from "dotenv";
import { account1BraavosSepoliaAddress, account1BraavosSepoliaPrivateKey, account3ArgentXSepoliaAddress, account3ArgentXSepoliaPrivateKey, accountSTRKoz20snip9Address, accountSTRKoz20snip9PrivateKey, alchemyKey } from "./secretNetwork";
import { l1l2MessageAbi } from "./l1l2MessageAbi";
import { requestProof, type ProveResult } from "./RequestProof";

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
  // const myProvider = new RpcProvider({ nodeUrl: "http://192.168.1.34:9545/rpc/v0_9" }); // local Sepolia Testnet node (starlink)
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
    const accountAddress0 = account1BraavosSepoliaAddress;
    const privateKey0 = account1BraavosSepoliaPrivateKey;
  // const accountAddress0 = account3ArgentXSepoliaAddress;
  // const privateKey0 = account3ArgentXSepoliaPrivateKey;
  // const accountAddress0 = accountSTRKoz20snip9Address;
  // const privateKey0 = accountSTRKoz20snip9PrivateKey;
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
   const votyContractAddress = "0x62751c14ff5d186f1ec837c7c45345fe555b8eba5e89c641bcb429d748f8f6a"; // Braavos
  // const votyContractAddress = "0x1627b4b67b7a692944e886643e403fb14c5435ddecb7c2ddacebf4e85587ebe"; // OZ
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
  // ****** to uncomment only if vote is not yet opened *******
  // const tx0 = await votyContract.open_round(0, 4);// round, vote_size
  // console.log("Vote opening...");
  // await myProvider.waitForTransaction(tx0.transaction_hash);
  // **********************************************************
  // --- Build calldata for the proof
  type PublicInputsForProof = {
    vote: BigNumberish,
    round: BigNumberish,
  };
  const public_input: PublicInputsForProof = {
    vote: 1,
    round: 0,
  };
  type PrivateInputsForProof = {
    member_leaf: BigNumberish,
    merkle_proof: Array<BigNumberish>,
    secret: BigNumberish
  };
  const memberEmail = new CairoBytes31("you@outlook.com").toHexString();
  console.log({ memberEmail });
  const tree = Merkle.StarknetMerkleTree.load(
    JSON.parse(fs.readFileSync('../src/app/server/merkleTree.json', 'ascii'))
  );
  const indexAddress = tree.dump().values.findIndex((leaf) => leaf.value == memberEmail);
  if (indexAddress === -1) {
    throw new Error("email not found in the list.");
  }
  const inpData = tree.getInputData(indexAddress);
  console.log("Leaf #", indexAddress, "contains =", inpData);
  const leafHash = Merkle.StarknetMerkleTree.leafHash(inpData, Merkle.HashType.Poseidon);
  console.log("leafHash =", leafHash);
  const secretT: Record<string, string> = JSON.parse(fs.readFileSync('../src/app/server/secrets.json', 'ascii'));

  const secret = secretT[memberEmail];
  const nullifier = hash.computePoseidonHashOnElements([new CairoBytes31("hash_of_member_V1").toHexString(), leafHash, public_input.round, secret]);
  console.log("nullifier =", nullifier);
  const proof = tree.getProof(indexAddress);
  const private_input: PrivateInputsForProof = {
    member_leaf: leafHash,
    merkle_proof: proof,
    secret
  };
  const myCalldata = votyContract.populate("create_proof", {
    public_input,
    private_input
  });
  // config.set('resourceBoundsOverhead', {
  //     l1_gas: {
  //         max_amount: 50,
  //         max_price_per_unit: 50,
  //     },
  //     l2_gas: {
  //         max_amount: 100,
  //         max_price_per_unit: 50,
  //     },
  //     l1_data_gas: {
  //         max_amount: 50,
  //         max_price_per_unit: 50,
  //     },
  // });
  // **** ⚠️⚠️⚠️ getSignedTransaction is only available from https://github.com/PhilippeR26/starknet.js/tree/buildExecute branch
  const tx: INVOKE_TXN_V3 = await account0.getSignedTransaction(myCalldata);
  console.log(tx);
  const currentBlock: number = await myProvider.getBlockNumber();

  fs.writeFileSync('./output/txVote.json', JSON.stringify(tx, undefined, 2));
  console.log(tx);
  // process.exit(7);

  // ------- ask to server to execute virtually the tx and to generate the proof
  const proofRes: ProveResult = await requestProof(currentBlock, tx);
  console.log("proof size =", proofRes.proof.length, ", start =", proofRes.proof.slice(0, 8), ", end =", proofRes.proof.slice(-8));

type L1L2message = {
  round: BigNumberish,
  nullifier: BigNumberish,
  vote: BigNumberish,
}
const messageCallData = new CallData(l1l2MessageAbi);
const messageContent = messageCallData.decodeParameters("l1l2message", (proofRes.l2ToL1Messages![0].payload) as string[]);
const messageFromProof = messageContent as L1L2message;
  console.log({ messageFromProof });

  // ------- Execute a tx onchain using the proof
  // *** as it's impossible today to declare a verification contract that includes `get_execution_info_v3_syscall`, we use here a random write function of the proof contract.
  const myCalldata2 = votyContract.populate("open_round", {
    round: 0,
    vote_size: 4
  });
  // ****** To test without proof
  // console.log("Test1...");
  // const res1 = await account0.execute(myCalldata2);
  // const txR1 = await account0.provider.waitForTransaction(res1.transaction_hash);

  console.log("Test2...");
  // Today, this function generated an error 55 : 'Account: invalid signature'. Starknet is not calculating properly the txHash (not using proof_facts)
  // const res2 = await account0.execute(myCalldata2, { proof: proofRes.proof, proofFacts: proofRes.proofFacts });
  // const txR2 = await account0.provider.waitForTransaction(res2.transaction_hash);
  // console.log(txR2);

  console.log("✅ Test performed.");
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
// Declare & deploy a contract.
// Uses of standard deployer
// Launch with npx ts-node ./src/2.deployVoty.ts
// Coded with Starknet.js v10.0.0 & Pathfinder v0.22.0

import { RpcProvider, Account, Contract, json, CallData, config, type CairoAssembly, type CompiledSierra, CairoBytes31, extractContractHashes } from "starknet";
import { account1BraavosSepoliaAddress, account1BraavosSepoliaPrivateKey, accountSTRKoz20snip9Address, accountSTRKoz20snip9PrivateKey, alchemyKey } from "./secretNetwork";
// import { account1BraavosMainnetAddress, account1BraavosMainnetPrivateKey, alchemyKey, infuraKey } from "../A-MainPriv/mainPriv";
import { DevnetProvider } from "starknet-devnet";
import * as Merkle from "starknet-merkle-tree";

import fs from "fs";
import * as dotenv from "dotenv";
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
  const myProvider = new RpcProvider({ nodeUrl: "http://192.168.1.26:9545/rpc/v0_10" }); // local Sepolia Testnet node (free, wire)
  // const myProvider = new RpcProvider({ nodeUrl: "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/" + alchemyKey });

  // ****** Starknet v0.14.2 integration Sepolia
  // const myProvider = new RpcProvider({ nodeUrl: AdrienIntegrationUrl });

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
  //  const accountAddress0 = accountIntegrationAdrienAddress;
  //  const privateKey0 = accountIntegrationAdrienPrivateKey;
  // **** Mainnet
  //  const accountAddress0 = account1BraavosMainnetAddress;
  //  const privateKey0 = account1BraavosMainnetPrivateKey;

  const account0 = new Account({ provider: myProvider, address: accountAddress0, signer: privateKey0 }
  );
  // config.set('resourceBoundsOverhead', {
  //       l1_gas: {
  //           max_amount: 50,
  //           max_price_per_unit: 50,
  //       },
  //       l2_gas: {
  //           max_amount: 30,
  //           max_price_per_unit: 10,
  //       },
  //       l1_data_gas: {
  //           max_amount: 50,
  //           max_price_per_unit: 50,
  //       },
  //   });
  console.log("Account connected.\n");


  // Declare & deploy Test contract 
  const compiledSierra = json.parse(fs.readFileSync("../cairoContract/voty/target/release/secure_voty_PrivateVoteVerifierMultiRound.contract_class.json").toString("ascii")) as CompiledSierra;
  const compiledCasm = json.parse(fs.readFileSync("../cairoContract/voty/target/release/secure_voty_PrivateVoteVerifierMultiRound.compiled_contract_class.json").toString("ascii")) as CairoAssembly;
  const dummyContract = new Contract({ abi: compiledSierra.abi, address: "0x123" });
  console.log("functions =", dummyContract.functions);
  console.log("constructor =", compiledSierra.abi.find((item) => item.type == "constructor"));
  const starknetVersion = await myProvider.getStarknetVersion();
  console.log({ snV: starknetVersion });
  const declareData2 = extractContractHashes({ contract: compiledSierra, casm: compiledCasm }, starknetVersion);
  console.log({ declareData2 });
  // process.exit(5);
  const resDecl = await account0.declareIfNot({
    contract: compiledSierra,
    casm: compiledCasm,
  });
  if (resDecl.transaction_hash) {
    console.log("new class hash =", resDecl.class_hash);
    await myProvider.waitForTransaction(resDecl.transaction_hash);
  } else {
    console.log("Already declared");
  };
  const classHash = resDecl.class_hash;
  console.log({ classHash, txH: resDecl.transaction_hash });

  const contractCallData = new CallData(compiledSierra.abi);
  const tree = Merkle.StarknetMerkleTree.load(
    JSON.parse(fs.readFileSync('../src/app/server/merkleTree.json', 'ascii'))
  );
  const constructor = contractCallData.compile('constructor', {
    merkle_root: tree.root
  });
  console.log({ constructor });

  const deployResponse = await account0.deployContract({
    classHash: classHash,
    constructorCalldata: constructor,
  });
  console.log(deployResponse);

  // ******* Testnet braavos
  // ClassH = 0x1f49ee8d0ab5b280303187f65e1fa62c197c451d6b442db2b0572309eed46df
  // address = 0x5f21a69bf7c0b01ce231c12b459c926a42243f6846f8272ec2e67ccc2551b68
  
  // Connect the new contract instance :
  const myTestContract = new Contract({ abi: compiledSierra.abi, address: deployResponse.contract_address });
  // const myTestContract = new Contract({ abi: compiledSierra.abi, address });
  myTestContract.providerOrAccount = account0;
  console.log('✅ Test Contract connected at =', myTestContract.address);

  console.log("✅ Test performed.");
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
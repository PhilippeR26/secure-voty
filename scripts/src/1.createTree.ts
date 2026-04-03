// Create & test a Merkle tree hashed with Pedersen
// launch with npx ts-node ./src/1.createTree.ts

import * as Merkle from "starknet-merkle-tree";
import * as dotenv from "dotenv";
import fs from "fs";
import { CairoBytes31, hash, stark } from "starknet";
dotenv.config({ quiet: true });

async function main() {
    const list = JSON.parse(fs.readFileSync("./src/votersList.json").toString("ascii"))as {list:string[]} ;
    // each leaf is a string array : voterEmail
    const voters: Merkle.InputForMerkle[] = list.list.map((item: string) => { return new CairoBytes31(item).toHexString() });
    console.log("voters=", voters);
    const tree1 = Merkle.StarknetMerkleTree.create(voters, Merkle.HashType.Poseidon);
    console.log("tree =", tree1.dump());
    console.log("root =", tree1.root); // for smartcontract constructor
    fs.writeFileSync('../src/app/server/merkleTree.json', JSON.stringify(tree1.dump(), undefined, 2));
    const secretTable = list.list.reduce((cumul: Record<string, string>, member: string ) => { 
        const propertyName=new CairoBytes31(member).toHexString()
        const newObj={ ...cumul, [propertyName]: stark.randomAddress() };
        return  newObj;
    }, {} as Record<string,string>);
    fs.writeFileSync('../src/app/server/secrets.json', JSON.stringify(secretTable, undefined, 2));

    // *********************************
    const tree = Merkle.StarknetMerkleTree.load(
        JSON.parse(fs.readFileSync('../src/app/server/merkleTree.json', 'ascii'))
    );
    const secretT:Record<string,string> = JSON.parse(fs.readFileSync('../src/app/server/secrets.json', 'ascii'));

    // process.exit(5);
    const accountAddress = new CairoBytes31("you@outlook.com").toHexString();
    console.log({ accountAddress });
    const indexAddress = tree.dump().values.findIndex((leaf) => leaf.value == accountAddress);
    if (indexAddress === -1) {
        throw new Error("address not found in the list.");
    }
    const inpData = tree.getInputData(indexAddress);
    console.log("Leaf #", indexAddress, "contains =", inpData);
    const leafHash = Merkle.StarknetMerkleTree.leafHash(inpData, Merkle.HashType.Poseidon);
    console.log("leafHash =", leafHash);
    const round = 1;
    const secret = secretT[accountAddress];
    const nullifier = hash.computePoseidonHashOnElements([new CairoBytes31("hash_of_members_V1").toHexString(), accountAddress,round,secret ]);
    console.log("nullifier =", nullifier);
    const proof = tree.getProof(indexAddress);
    console.log("corresponding proof =", proof);
    const isValid = tree.verify(inpData, proof);
    console.log("This proof is", isValid);
    console.log(tree.render());
    console.log("✅ test completed.");
}
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

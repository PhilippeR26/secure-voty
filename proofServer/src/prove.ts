import { spawn } from "child_process";
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { BigNumberish } from "starknet";
import { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
import { BINARY, REPO_CWD } from "./build";

export const proveRouter = Router();

interface ProveBody {
  blockNumber: BigNumberish;
  tx: INVOKE_TXN_V3
}
interface ProofMessage {
  from_address: string;
  payload: string[];
  to_address: string;
}

interface ProveResult {
  proof: string;
  proofFacts: string[];
  l2ToL1Messages?: ProofMessage[];
}

proveRouter.post("/prove", (req: Request, res: Response) => {
  const { blockNumber, tx } = req.body as ProveBody;

  if (!blockNumber || !tx) {
    res.status(400).json({ error: "blockNumber and tx are required" });
    return;
  }

  const outputDir = path.resolve("./output");
  const tmpDir = path.resolve("./tmp");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const txJsonPath = path.join(tmpDir, `tx-${Date.now()}.json`);
  fs.writeFileSync(txJsonPath, JSON.stringify(tx, null, 2));

  const outputBase = path.join(outputDir, `prove-${Date.now()}`);
  const args = [
    "prove", "virtual-os",
    "--block-number", String(blockNumber),
    "--tx-json", txJsonPath,
    "--rpc-url", process.env.STARKNET_RPC_URL!,
    "--output", `${outputBase}.proof`,
  ];

  console.log("spawn:", BINARY, args.join(" "));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: "log" | "done" | "error", data: object) => {
    console.log(`[${event}]`, data);
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Accumuler stderr pour le debug
  let stderrBuffer = "";

  const child = spawn(BINARY, args, {
    cwd: REPO_CWD,
    env: {
      ...process.env,
      STARKNET_RPC_URL: process.env.STARKNET_RPC_URL!,
      STARKNET_ACCOUNT_ADDRESS: process.env.STARKNET_ACCOUNT_ADDRESS!,
      STARKNET_PRIVATE_KEY: process.env.STARKNET_PRIVATE_KEY!,
      STARKNET_GATEWAY_URL: process.env.STARKNET_GATEWAY_URL!,
    },
  });

  child.stdout.on("data", (chunk: Buffer) =>
    send("log", { stream: "stdout", line: chunk.toString() })
  );

  child.stderr.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    stderrBuffer += line;
    send("log", { stream: "stderr", line });
  });

  child.on("close", (code, signal) => {
    console.log("close — code:", code, "signal:", signal);

    if (code === 0) {
      const proofBase64 = fs.readFileSync(`${outputBase}.proof`, "ascii").trim();
      const proofFacts: string[] = JSON.parse(
        fs.readFileSync(`${outputBase}.proof_facts`, "ascii")
      );

      const rawMessagesPath = `${outputBase}.raw_messages.json`;
      const l2ToL1Messages = fs.existsSync(rawMessagesPath)
        ? JSON.parse(fs.readFileSync(rawMessagesPath, "ascii")).l2_to_l1_messages
        : undefined;
      // fs.rmSync(txJsonPath, { force: true });
      send("done", {
        proof: proofBase64,
        proofFacts,
        ...(l2ToL1Messages && { l2ToL1Messages }),
      });
      console.log("proof size =", proofBase64.length, ", start =", proofBase64.slice(0, 8), ", end =", proofBase64.slice(-8));

    } else {
      // fs.rmSync(txJsonPath, { force: true });
      send("error", {
        code,
        signal,
        message: "snip36 exited with non-zero code",
        stderr: stderrBuffer,
      });
    }
    res.end();
    fs.rmSync(txJsonPath, { force: true });
    fs.rmSync(`${outputBase}.proof`, { force: true });
    fs.rmSync(`${outputBase}.proof_facts`, { force: true });
    fs.rmSync(`${outputBase}.raw_messages.json`, { force: true });
  });

  child.on("error", (err) => {
    fs.rmSync(txJsonPath, { force: true });
    send("error", { message: err.message });
    res.end();
  });

  // On ne tue le process que si la réponse SSE est fermée côté client
  res.on("close", () => {
    console.log("SSE connection closed by client");
    if (!child.killed) child.kill();
  });
});
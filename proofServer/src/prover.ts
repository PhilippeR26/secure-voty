import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { num } from "starknet";
import { CHAIN_NAMES, Network } from "./instance";
import { isGroupAlive, killGroup, waitUntil } from "./proc";

export interface L2ToL1Message {
  from_address: string;
  to_address: string;
  payload: string[];
}

export interface ProofOutput {
  proof: string;
  proofFacts: string[];
  l2ToL1Messages?: L2ToL1Message[];
}

export type KillReason = "timeout" | "abort" | "shutdown";

export type ProverResult =
  | { kind: "done"; output: ProofOutput; durMs: number }
  | { kind: "fail"; exitCode: number | null; signal: string | null; reason: string; stderrTail: string; durMs: number }
  | { kind: "killed"; reason: KillReason; durMs: number };

export interface ProofSpec {
  binary: string;
  repoDir: string;
  workDir: string;
  jobId: string;
  network: Network;
  rpcUrl: string;
  blockNumber: number;
  tx: unknown;
  runnerPort: number;
  timeoutMs: number;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface ProofRun {
  readonly pgid: number | null;
  readonly result: Promise<ProverResult>;
  kill(reason: KillReason): void;
}

export const KILL_GRACE_MS = 5000;
const GROUP_GONE_MS = 3000;
const STDIO_CLOSE_MS = 1000;
const MAX_TAIL_LINES = 50;
const MAX_PENDING_CHARS = 64 * 1024;
const MAX_REASON_CHARS = 300;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const PATH_RE = /(?:\/[\w.@+-]+){2,}/g;
const NUMBERED_RE = /^\d+:\s+/;
const BACKTRACE_HINT_RE = /^(?:Backtrace omitted|Run with RUST_BACKTRACE)/i;
const HEX_RE = /0x[0-9a-fA-F]+/g;
const SMALLEST_SECRET = 0x10n; // a value of one hex digit is structure of the call, not a secret

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Replaces, in `text`, the hex values found in the calldata or the signature of `tx`: a message of the prover
// must never carry the voter's secret into a log. Values are compared in their short form (num.cleanHex).
export function redactTxValues(text: string, tx: unknown): string {
  const secrets = new Set<string>();
  if (typeof tx === "object" && tx !== null) {
    for (const key of ["calldata", "signature"]) {
      const values = (tx as Record<string, unknown>)[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === "string" && value.length > 2 && num.isHex(value) && num.toBigInt(value) >= SMALLEST_SECRET) {
          secrets.add(num.cleanHex(value));
        }
      }
    }
  }
  if (secrets.size === 0) return text;
  return text.replace(HEX_RE, (token) => (secrets.has(num.cleanHex(token)) ? "<redacted>" : token));
}

// The line of the report that says why: the deepest cause of an `Error:` chain (color-eyre prints
// "   0: outer", "   1: inner"), else the last line that is not a backtrace hint.
function pickLine(lines: string[]): string {
  const start = lines.findIndex((line) => /^Error:/.test(line));
  if (start !== -1) {
    const chain: string[] = [];
    for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) {
      if (NUMBERED_RE.test(lines[i])) chain.push(lines[i]);
    }
    if (chain.length > 0) return chain[chain.length - 1];
  }
  const useful = lines.filter((line) => line !== "" && !BACKTRACE_HINT_RE.test(line));
  return useful[useful.length - 1] ?? "";
}

// A JSON-RPC error object inside the line: keep its readable text.
function rpcMessage(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    if (typeof parsed === "object" && parsed !== null) {
      const { data, message } = parsed as Record<string, unknown>;
      if (typeof data === "string" && data.trim() !== "") return data;
      if (typeof message === "string" && message.trim() !== "") return message;
    }
  } catch {
    // not JSON: keep the line as it is
  }
  return text;
}

// Short reason of a failure, safe to show to the site and to write in the log: ANSI codes removed, absolute
// paths replaced, values of the transaction masked, at most 300 characters.
export function sanitizeReason(stderrTail: string, tx?: unknown): string {
  const lines = stderrTail.replace(ANSI_RE, "").split("\n").map((line) => line.trim());
  let text = rpcMessage(pickLine(lines).replace(NUMBERED_RE, "")).replace(/\s+/g, " ");
  if (tx !== undefined) text = redactTxValues(text, tx); // before the cut, so that no value is cut in the middle
  text = text.replace(HEX_RE, (token) => num.cleanHex(token)); // felts come padded to 64 digits: keep it short
  return text.replace(PATH_RE, "<path>").trim().slice(0, MAX_REASON_CHARS);
}

class LineSplitter {
  private readonly emit: (line: string) => void;
  private pending = "";

  constructor(emit: (line: string) => void) {
    this.emit = emit;
  }

  push(chunk: string): void {
    this.pending += chunk;
    let at = this.pending.indexOf("\n");
    while (at !== -1) {
      this.emit(this.pending.slice(0, at).replace(/\r$/, ""));
      this.pending = this.pending.slice(at + 1);
      at = this.pending.indexOf("\n");
    }
    if (this.pending.length > MAX_PENDING_CHARS) {
      this.emit(this.pending);
      this.pending = "";
    }
  }

  flush(): void {
    if (this.pending !== "") this.emit(this.pending.replace(/\r$/, ""));
    this.pending = "";
  }
}

function readJob(base: string, suffix: string, required: boolean): string | null {
  const file = `${base}${suffix}`;
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`prover output missing: ${path.basename(file)}`);
    return null;
  }
  return fs.readFileSync(file, "ascii");
}

function readJobJson(base: string, suffix: string, required: boolean): unknown {
  const text = readJob(base, suffix, required);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`prover output unreadable: ${path.basename(base)}${suffix}`);
  }
}

function readOutput(base: string): ProofOutput {
  const proof = (readJob(base, ".proof", true) ?? "").trim();
  if (proof === "") throw new Error(`prover output missing: ${path.basename(base)}.proof`);
  const proofFacts = readJobJson(base, ".proof_facts", true);
  if (!Array.isArray(proofFacts) || !proofFacts.every((fact) => typeof fact === "string")) {
    throw new Error(`prover output unreadable: ${path.basename(base)}.proof_facts`);
  }
  const output: ProofOutput = { proof, proofFacts };
  const raw = readJobJson(base, ".raw_messages.json", false);
  const messages = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).l2_to_l1_messages : undefined;
  if (Array.isArray(messages)) output.l2ToL1Messages = messages as L2ToL1Message[];
  return output;
}

// Runs `snip36 prove virtual-os` in a process group of its own. When the result is available, nothing of that
// group is left running and the job files are deleted.
export function startProof(spec: ProofSpec): ProofRun {
  const startedAt = Date.now();
  const base = path.join(spec.workDir, spec.jobId);
  const txFile = `${base}.tx.json`;
  const jobFiles = [txFile, `${base}.proof`, `${base}.proof_facts`, `${base}.raw_messages.json`];
  const cleanup = (): void => {
    for (const file of jobFiles) fs.rmSync(file, { force: true });
  };
  const failure = (
    reason: string,
    extra: { exitCode?: number | null; signal?: string | null; stderrTail?: string } = {},
  ): ProverResult => ({
    kind: "fail",
    exitCode: extra.exitCode ?? null,
    signal: extra.signal ?? null,
    reason,
    stderrTail: extra.stderrTail ?? "",
    durMs: Date.now() - startedAt,
  });
  const notStarted = (err: unknown): ProofRun => {
    cleanup();
    const result = Promise.resolve(failure(sanitizeReason((err as Error).message, spec.tx)));
    return { pgid: null, result, kill: () => {} };
  };

  let child;
  try {
    fs.writeFileSync(txFile, JSON.stringify(spec.tx, null, 2), { mode: 0o600 });
    child = spawn(
      spec.binary,
      [
        "prove",
        "virtual-os",
        "--block-number",
        String(spec.blockNumber),
        "--tx-json",
        txFile,
        "--rpc-url",
        spec.rpcUrl,
        "--output",
        `${base}.proof`,
        "--port",
        String(spec.runnerPort),
      ],
      {
        cwd: spec.repoDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          STARKNET_RPC_URL: spec.rpcUrl,
          STARKNET_CHAIN_ID: CHAIN_NAMES[spec.network],
          STARKNET_ACCOUNT_ADDRESS: "0x1",
          STARKNET_PRIVATE_KEY: "0x1",
          SNIP36_PROJECT_DIR: spec.repoDir,
        },
      },
    );
  } catch (err) {
    return notStarted(err);
  }
  const pgid = child.pid ?? null;

  const stderrTail: string[] = [];
  const emit = (stream: "stdout" | "stderr", line: string): void => {
    if (stream === "stderr") {
      stderrTail.push(line);
      if (stderrTail.length > MAX_TAIL_LINES) stderrTail.shift();
    }
    if (line.trim() === "") return;
    try {
      spec.onLine?.(stream, line);
    } catch {
      // a faulty listener must not break the proof
    }
  };
  const splitters = {
    stdout: new LineSplitter((line) => emit("stdout", line)),
    stderr: new LineSplitter((line) => emit("stderr", line)),
  };
  for (const name of ["stdout", "stderr"] as const) {
    const stream = child[name];
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => splitters[name].push(chunk));
    stream?.on("error", () => {});
  }

  type End = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };
  const ended = new Promise<End>((resolve) => {
    child.on("error", (error) => {
      if (child.pid === undefined) resolve({ error }); // the process never started
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  let killReason: KillReason | null = null;
  let exited = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let escalationTimer: NodeJS.Timeout | null = null;
  const clearTimers = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (escalationTimer) clearTimeout(escalationTimer);
    timeoutTimer = null;
    escalationTimer = null;
  };

  const kill = (reason: KillReason): void => {
    if (killReason !== null || exited) return;
    killReason = reason;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    if (pgid === null) return;
    try {
      killGroup(pgid, "SIGTERM");
    } catch {
      // the escalation below still applies
    }
    escalationTimer = setTimeout(() => {
      try {
        if (isGroupAlive(pgid)) killGroup(pgid, "SIGKILL");
      } catch {
        // nothing more can be done
      }
    }, KILL_GRACE_MS);
  };
  if (pgid !== null) timeoutTimer = setTimeout(() => kill("timeout"), spec.timeoutMs);

  const result = (async (): Promise<ProverResult> => {
    try {
      const end = await ended;
      exited = true;
      clearTimers();
      if ("error" in end) return failure(sanitizeReason(end.error.message, spec.tx));

      // Whatever snip36 left running in its group, the runner first of all, must not outlive it.
      if (pgid !== null) {
        killGroup(pgid, "SIGKILL");
        await waitUntil(() => !isGroupAlive(pgid), GROUP_GONE_MS, 20);
      }
      await Promise.race([closed, sleep(STDIO_CLOSE_MS)]);
      splitters.stdout.flush();
      splitters.stderr.flush();

      const durMs = Date.now() - startedAt;
      if (killReason !== null) return { kind: "killed", reason: killReason, durMs };

      const tail = stderrTail.join("\n");
      const exit = { exitCode: end.code, signal: end.signal, stderrTail: tail };
      if (end.signal !== null) return failure(`terminated by ${end.signal}`, exit);
      if (end.code !== 0) return failure(sanitizeReason(tail, spec.tx) || `exit code ${end.code}`, exit);
      try {
        return { kind: "done", output: readOutput(base), durMs };
      } catch (err) {
        return failure((err as Error).message, exit);
      }
    } catch (err) {
      return failure(sanitizeReason((err as Error).message, spec.tx));
    } finally {
      clearTimers();
      cleanup();
    }
  })();

  return { pgid, result, kill };
}

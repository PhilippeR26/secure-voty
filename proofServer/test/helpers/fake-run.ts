import { KillReason, ProofRun, ProofSpec, ProverResult } from "../../src/prover";
import { SseEvent, SseSink } from "../../src/service";

export interface FakeProver {
  start: (spec: ProofSpec) => ProofRun;
  specs: ProofSpec[];
  finish(index: number, result: ProverResult): void;
  killed: Array<{ index: number; reason: KillReason }>;
}

// A prover that never runs anything: the test ends each proof with finish(), or the service with kill().
export function fakeProver(): FakeProver {
  const specs: ProofSpec[] = [];
  const settle: Array<(result: ProverResult) => void> = [];
  const killed: Array<{ index: number; reason: KillReason }> = [];
  return {
    specs,
    killed,
    start: (spec) => {
      const index = specs.length;
      specs.push(spec);
      const result = new Promise<ProverResult>((resolve) => {
        settle[index] = resolve;
      });
      return {
        pgid: null,
        result,
        kill: (reason) => {
          killed.push({ index, reason });
          settle[index]({ kind: "killed", reason, durMs: 0 });
        },
      };
    },
    finish: (index, result) => settle[index](result),
  };
}

// Like the real SSE stream, it ignores what is sent after close().
export class RecordingSink implements SseSink {
  events: Array<{ event: string; data: any }> = [];
  closed = false;

  send(event: SseEvent, data: object): void {
    if (!this.closed) this.events.push({ event, data });
  }

  close(): void {
    this.closed = true;
  }

  get names(): string[] {
    return this.events.map((e) => e.event);
  }
}

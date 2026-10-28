import express from "express";
import { SseEvent, SseSink } from "./service";

const DEFAULT_PING_MS = 15_000;

// Server-sent events on an Express response. A comment line is sent now and then so that nothing between
// the server and the client closes a connection that waits in the queue.
export class SseStream implements SseSink {
  private readonly res: express.Response;
  private readonly ping: NodeJS.Timeout;
  private ended = false;
  private endedByUs = false;

  constructor(res: express.Response, opts: { pingMs?: number; onDisconnect?: () => void } = {}) {
    this.res = res;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.on("error", () => {});
    res.on("close", () => {
      const goneByItself = !this.endedByUs; // not closed by close(): the client left
      this.finish();
      if (goneByItself) opts.onDisconnect?.();
    });
    this.ping = setInterval(() => this.write(": ping\n\n"), opts.pingMs ?? DEFAULT_PING_MS);
  }

  send(event: SseEvent, data: object): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.ended) return;
    this.endedByUs = true;
    this.finish();
    this.res.end();
  }

  get closed(): boolean {
    return this.ended;
  }

  private write(chunk: string): void {
    if (!this.ended) this.res.write(chunk);
  }

  private finish(): void {
    this.ended = true;
    clearInterval(this.ping);
  }
}

export interface SseRec {
  event: string;
  data: any;
}

export interface ProveResponse {
  status: number;
  retryAfter: string | null;
  json: any; // body of a rejection (JSON before any stream)
  events: SseRec[];
}

function parseBlock(block: string): SseRec | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment, e.g. the keep-alive ping
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return data.length === 0 ? null : { event, data: JSON.parse(data.join("\n")) };
}

// POST /prove as the clients do. An abort of `signal` resolves with what was received so far.
export async function prove(
  baseUrl: string,
  body: unknown,
  opts: { key?: string; signal?: AbortSignal; onEvent?: (e: SseRec) => void; rawBody?: string } = {},
): Promise<ProveResponse> {
  const result: ProveResponse = { status: 0, retryAfter: null, json: null, events: [] };
  try {
    const response = await fetch(`${baseUrl}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}) },
      body: opts.rawBody ?? JSON.stringify(body),
      signal: opts.signal,
    });
    result.status = response.status;
    result.retryAfter = response.headers.get("retry-after");
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      result.json = await response.json().catch(() => null);
      return result;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf("\n\n");
      while (at !== -1) {
        const record = parseBlock(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (record) {
          result.events.push(record);
          opts.onEvent?.(record);
        }
        at = buffer.indexOf("\n\n");
      }
    }
    return result;
  } catch (err) {
    if (opts.signal?.aborted) return result;
    throw err;
  }
}

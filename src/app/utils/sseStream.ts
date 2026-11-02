// Reads a Server-Sent Events stream, and calls onEvent for each message that has an "event:" and a "data:" line.
// Used on the DAPP server (stream of the proof server) and in the browser (stream of /api/prove).
export async function readSseStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: string, data: unknown) => void,
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; // store chunks
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // a SSE message is delimited by \n\n
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const message of messages) {
            if (!message.trim()) continue;
            const eventMatch = message.match(/^event: (\w+)/);
            const dataMatch = message.match(/^data: (.+)$/m);
            if (!eventMatch || !dataMatch) continue;
            onEvent(eventMatch[1], JSON.parse(dataMatch[1]));
        }
    }
}

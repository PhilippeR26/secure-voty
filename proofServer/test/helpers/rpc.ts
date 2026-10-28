import http from "node:http";
import { AddressInfo } from "node:net";

// A node that answers every JSON-RPC call with the given chain id (what startServer asks for).
export function startFakeRpc(chainIdHex: string): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let id: unknown = 1;
        try {
          id = JSON.parse(body).id ?? 1;
        } catch {
          // keep the default id
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: chainIdHex }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

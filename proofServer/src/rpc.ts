import { RpcProvider } from "starknet";

// Asks a node for its chain id (starknet_chainId), e.g. "0x534e5f5345504f4c4941" for SN_SEPOLIA, with the
// provider of starknet.js. The fetch given to it adds a time limit and keeps the reason of a failure, which the
// provider would otherwise reduce to "fetch failed" or to a JSON parsing message.
export async function fetchChainId(rpcUrl: string, timeoutMs = 10_000): Promise<string> {
  const provider = new RpcProvider({
    nodeUrl: rpcUrl,
    baseFetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      let response: Response;
      try {
        response = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const e = err as Error & { cause?: { message?: string } };
        throw new Error(e.cause?.message ?? e.message);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    },
  });
  const chainId: string = await provider.getChainId(); // what the node says, not only the two known chains
  return chainId;
}

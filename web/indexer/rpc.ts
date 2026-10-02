/**
 * Chain access for the built-in indexer. Only twain's own logs are requested (the launcher, twain coins with their
 * curves and fee vaults, the Pons factory's graduation and pair-token events, swaps in the coins' graduated pools),
 * so a free RPC is enough.
 *
 * Endpoints: the public Robinhood Chain RPC first, then INDEXER_RPC_URL (optional, e.g. an Alchemy key without a
 * domain allowlist) as a fallback. Locally (NEXT_PUBLIC_RPC_URL on localhost) only the anvil fork is used.
 * NEXT_PUBLIC_RPC_URL is otherwise ignored here: it is meant for browsers and may be origin-restricted.
 *
 * Contract reads always use the latest block: the public RPC prunes historical state after ~10–20 minutes, and
 * everything the indexer reads (curve constants, token info, ERC-20 details) never changes.
 */
import { robinhood } from "@twain/shared";
import { createPublicClient, fallback, http, numberToHex, type Hex, type RpcLog } from "viem";
import { config } from "@/lib/config";

export const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.rpcUrl);

const urls = isLocal
  ? [config.rpcUrl]
  : [...new Set([robinhood.rpcUrls.default.http[0], process.env.INDEXER_RPC_URL].filter((u): u is string => !!u))];

export const rpc = createPublicClient({
  chain: robinhood, // Multicall3 address
  // viem caches eth_blockNumber for 4 s by default; every sync needs the live head.
  cacheTime: 0,
  transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 2, batch: { batchSize: 10 } }))),
});

/** Public RPC limit for eth_getLogs with several addresses or topic values ("query spans N blocks"). */
export const MAX_SPAN = 100_000;
/** Public RPC limit for eth_getLogs with one address and one topic value (10M blocks, 10k logs). */
export const MAX_SPAN_SINGLE = 9_990_000;

export type LogFilter = { address: Hex | Hex[]; topics?: (Hex | Hex[] | null)[] };

/** Raw eth_getLogs (hex fields; no blockTimestamp — the public RPC reports 0x0 there). */
export async function getLogs(filter: LogFilter, fromBlock: number, toBlock: number): Promise<RpcLog[]> {
  return (await rpc.request({
    method: "eth_getLogs",
    params: [{ ...filter, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
  })) as RpcLog[];
}

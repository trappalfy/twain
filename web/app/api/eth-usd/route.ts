import type { EthUsdResponse } from "@twain/shared";
import { fetchEthUsd } from "@/lib/server/eth-usd";

/**
 * ETH/USD for display (built-in indexer and prelaunch mode). The response is cached by the CDN, so visitors never
 * hit the sources directly. `usd: null` when every source fails.
 */
export async function GET() {
  const usd = await fetchEthUsd();
  const body: EthUsdResponse = { usd, updatedAt: Math.floor(Date.now() / 1000) };
  return Response.json(body, { headers: { "cache-control": usd ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store" } });
}

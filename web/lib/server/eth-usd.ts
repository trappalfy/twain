import { ethUsdSources } from "@twain/shared";

const SOURCES = ethUsdSources(process.env.COINGECKO_API_KEY);

/**
 * ETH/USD from keyless exchange APIs tried in order (packages/shared/src/prices.ts), each cached 60 s by Next's
 * data cache. null when every source fails.
 */
export async function fetchEthUsd(): Promise<number | null> {
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { next: { revalidate: 60 }, signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
      const usd = res.ok ? src.parse(await res.json()) : undefined;
      if (usd !== undefined) return usd;
    } catch {
      /* next source */
    }
  }
  return null;
}

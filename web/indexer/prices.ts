/**
 * Display details and current USD prices of listed assets, for the API's USD figures:
 *  - native ETH: exchange APIs (lib/server/eth-usd.ts);
 *  - Robinhood stock tokens: Robinhood's public stock-token API — name and logo from /rhj/assets, price = mid of the
 *    token-denominated bid/ask from /rhj/prices/{symbol} (already adjusted for the token's multiplier);
 *  - any other ERC-20 (memes, stablecoins): symbol/name/decimals from the chain; logo and USD price from GeckoTerminal
 *    (one request for up to 30 tokens), DexScreener's deepest pair as fallback for the price.
 * Responses are cached by Next's data cache (assets 1 h, prices 60 s); a failing source yields null, never an error.
 */
import type { AssetInfo } from "@twain/shared";
import { fetchEthUsd } from "@/lib/server/eth-usd";
import type { AssetRow } from "./schema";
import { lc, mapLimit, ZERO_ADDRESS, type Hex } from "./shared";

const RH_API = "https://api.robinhood.com/rhj";
const CHAIN_ID = 4663;
const GT_API = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const DS_API = "https://api.dexscreener.com/tokens/v1/robinhood";

type Stock = { symbol: string; name: string; logo: string | null };
type Token = { logo: string | null; usd: number | null };

type RhAsset = {
  tokenSymbol?: string;
  tokenName?: string;
  logoUrl?: string;
  deployments?: { contractAddress?: string; chainId?: number }[];
};

async function getJson<T>(url: string, revalidate: number): Promise<T | null> {
  try {
    const res = await fetch(url, { next: { revalidate }, signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Robinhood stock tokens on Robinhood Chain, by lowercase address. */
async function stockList(): Promise<Map<Hex, Stock>> {
  const body = await getJson<{ assets?: RhAsset[] }>(`${RH_API}/assets`, 3_600);
  const out = new Map<Hex, Stock>();
  for (const a of body?.assets ?? []) {
    const d = a.deployments?.find((x) => x.chainId === CHAIN_ID && x.contractAddress);
    if (!d || !a.tokenSymbol) continue;
    out.set(lc(d.contractAddress!), {
      symbol: a.tokenSymbol,
      // "Tesla • Robinhood Token" → "Tesla"
      name: (a.tokenName ?? a.tokenSymbol).replace(/\s*[•·]\s*Robinhood Token$/i, ""),
      logo: a.logoUrl ?? null,
    });
  }
  return out;
}

async function stockUsd(symbol: string): Promise<number | null> {
  const body = await getJson<{ quotes?: { tokenBid?: string; tokenAsk?: string; bid?: string; ask?: string }[] }>(
    `${RH_API}/prices/${encodeURIComponent(symbol)}`,
    60,
  );
  const q = body?.quotes?.[0];
  if (!q) return null;
  const bid = Number(q.tokenBid ?? q.bid);
  const ask = Number(q.tokenAsk ?? q.ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

type GtToken = { attributes?: { address?: string; image_url?: string | null; price_usd?: string | null } };
type DsPair = { baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number }; info?: { imageUrl?: string } };

const positive = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Logo and USD price of non-stock tokens: GeckoTerminal first, DexScreener's deepest pair for what it lacks. */
async function tokenList(addresses: Hex[]): Promise<Map<Hex, Token>> {
  const out = new Map<Hex, Token>();
  const batches: Hex[][] = [];
  for (let i = 0; i < addresses.length; i += 30) batches.push(addresses.slice(i, i + 30));
  for (const batch of batches) {
    const body = await getJson<{ data?: GtToken[] }>(`${GT_API}/tokens/multi/${batch.join(",")}`, 60);
    for (const t of body?.data ?? []) {
      const a = t.attributes;
      if (!a?.address) continue;
      const logo = a.image_url && !a.image_url.includes("missing") ? a.image_url : null;
      out.set(lc(a.address), { logo, usd: positive(a.price_usd) });
    }
  }
  const gaps = addresses.filter((a) => !out.get(a)?.usd);
  for (let i = 0; i < gaps.length; i += 30) {
    const pairs = await getJson<DsPair[]>(`${DS_API}/${gaps.slice(i, i + 30).join(",")}`, 60);
    const best = new Map<Hex, { liq: number; pair: DsPair }>();
    for (const p of pairs ?? []) {
      if (!p.baseToken?.address || !positive(p.priceUsd)) continue;
      const a = lc(p.baseToken.address);
      const liq = p.liquidity?.usd ?? 0;
      if (gaps.includes(a) && liq > (best.get(a)?.liq ?? -1)) best.set(a, { liq, pair: p });
    }
    for (const [a, { pair }] of best) {
      out.set(a, { logo: out.get(a)?.logo ?? pair.info?.imageUrl ?? null, usd: positive(pair.priceUsd) });
    }
  }
  return out;
}

/** AssetInfo for each asset row (ETH first-class, stocks recognised by address, everything else a token). */
export async function assetInfos(rows: AssetRow[]): Promise<Map<Hex, AssetInfo>> {
  const erc20 = rows.filter((r) => r.address !== ZERO_ADDRESS).map((r) => r.address);
  const [stocks, ethUsd] = await Promise.all([
    erc20.length ? stockList() : Promise.resolve(new Map<Hex, Stock>()),
    rows.some((r) => r.address === ZERO_ADDRESS) ? fetchEthUsd() : Promise.resolve(null),
  ]);
  const others = erc20.filter((a) => !stocks.has(a));
  const tokens = others.length ? await tokenList(others) : new Map<Hex, Token>();
  const infos = await mapLimit(rows, 6, async (r): Promise<AssetInfo> => {
    if (r.address === ZERO_ADDRESS) {
      return { address: r.address, symbol: "ETH", name: "Ether", decimals: 18, logo: null, kind: "native", usd: ethUsd };
    }
    const stock = stocks.get(r.address);
    if (stock) {
      return {
        address: r.address,
        symbol: stock.symbol,
        name: stock.name,
        decimals: r.decimals,
        logo: stock.logo,
        kind: "stock",
        usd: await stockUsd(stock.symbol),
      };
    }
    const t = tokens.get(r.address);
    return {
      address: r.address,
      symbol: r.symbol,
      name: r.name,
      decimals: r.decimals,
      logo: t?.logo ?? null,
      kind: "token",
      usd: t?.usd ?? null,
    };
  });
  return new Map(rows.map((r, i) => [r.address, infos[i]!]));
}

/** USD per smallest unit of the asset, as a decimal string for SQL (null when unknown). */
export function usdPerUnit(info: AssetInfo): string | null {
  if (info.usd == null) return null;
  return (info.usd / 10 ** info.decimals).toExponential(15);
}

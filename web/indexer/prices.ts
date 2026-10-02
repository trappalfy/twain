/**
 * Display details and current USD prices of pair assets, for the API's USD figures:
 *  - native ETH: exchange APIs (lib/server/eth-usd.ts);
 *  - Robinhood stock tokens: Robinhood's public stock-token API — name and logo from /rhj/assets, prices from
 *    /rhj/prices (every quote in one response; mid of the token-denominated bid/ask, already adjusted for the token's
 *    multiplier);
 *  - any other ERC-20 (stablecoins, BTC, …): symbol/name/decimals from the chain; logo and USD price from GeckoTerminal
 *    (one request per 30 tokens), DexScreener's deepest pair as fallback for the price.
 * Every source is fetched at most once per TTL per instance (stock list 1 h, prices 60 s; concurrent callers share the
 * request) and is also cached by Next's data cache; a failing source yields null, never an error.
 */
import type { AssetInfo } from "@twain/shared";
import { fetchEthUsd } from "@/lib/server/eth-usd";
import type { AssetRow } from "./schema";
import { lc, ZERO_ADDRESS, type Hex } from "./shared";

const RH_API = "https://api.robinhood.com/rhj";
const CHAIN_ID = 4663;
const GT_API = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const DS_API = "https://api.dexscreener.com/tokens/v1/robinhood";

const LIST_TTL = 3_600_000;
const PRICE_TTL = 60_000;

type Stock = { symbol: string; name: string; logo: string | null };
type Token = { logo: string | null; usd: number | null };

type RhDeployment = { contractAddress?: string; chainId?: number };
type RhAsset = { tokenSymbol?: string; tokenName?: string; logoUrl?: string; deployments?: RhDeployment[] };
type RhQuote = { tokenBid?: string; tokenAsk?: string; bid?: string; ask?: string; deployments?: RhDeployment[] };

async function getJson<T>(url: string, revalidate: number): Promise<T | null> {
  try {
    const res = await fetch(url, { next: { revalidate }, signal: AbortSignal.timeout(6_000), headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** In-memory TTL cache per key; callers within the TTL (and concurrent ones) share one fetch. Failures expire fast. */
const memo = new Map<string, { until: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttl: number, load: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.until > now) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { until: now + ttl, value });
  value.then(
    (v) => {
      if (!ok(v)) memo.set(key, { until: Date.now() + 5_000, value });
    },
    () => memo.delete(key),
  );
  return value;
}

const addressOn4663 = (deployments: RhDeployment[] | undefined) => {
  const d = deployments?.find((x) => x.chainId === CHAIN_ID && x.contractAddress);
  return d ? lc(d.contractAddress!) : null;
};

/** Robinhood stock tokens on Robinhood Chain, by lowercase address. */
function stockList(): Promise<Map<Hex, Stock>> {
  return cached(
    "rh-assets",
    LIST_TTL,
    async () => {
      const body = await getJson<{ assets?: RhAsset[] }>(`${RH_API}/assets`, 3_600);
      const out = new Map<Hex, Stock>();
      for (const a of body?.assets ?? []) {
        const address = addressOn4663(a.deployments);
        if (!address || !a.tokenSymbol) continue;
        out.set(address, {
          symbol: a.tokenSymbol,
          // "Tesla • Robinhood Token" → "Tesla"
          name: (a.tokenName ?? a.tokenSymbol).replace(/\s*[•·]\s*Robinhood Token$/i, ""),
          logo: a.logoUrl ?? null,
        });
      }
      return out;
    },
    (m) => m.size > 0,
  );
}

/** USD price of every Robinhood stock token, by lowercase address (one request). */
function stockPrices(): Promise<Map<Hex, number>> {
  return cached(
    "rh-prices",
    PRICE_TTL,
    async () => {
      const body = await getJson<{ quotes?: RhQuote[] }>(`${RH_API}/prices`, 60);
      const out = new Map<Hex, number>();
      for (const q of body?.quotes ?? []) {
        const address = addressOn4663(q.deployments);
        if (!address) continue;
        const bid = Number(q.tokenBid ?? q.bid);
        const ask = Number(q.tokenAsk ?? q.ask);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
        if (Number.isFinite(mid) && mid > 0) out.set(address, mid);
      }
      return out;
    },
    (m) => m.size > 0,
  );
}

type GtToken = { attributes?: { address?: string; image_url?: string | null; price_usd?: string | null } };
type DsPair = { baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number }; info?: { imageUrl?: string } };

const positive = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Logo and USD price of non-stock tokens: GeckoTerminal first, DexScreener's deepest pair for what it lacks. */
function tokenList(addresses: Hex[]): Promise<Map<Hex, Token>> {
  const sorted = [...addresses].sort();
  return cached(
    `tokens:${sorted.join(",")}`,
    PRICE_TTL,
    async () => {
      const out = new Map<Hex, Token>();
      const batches: Hex[][] = [];
      for (let i = 0; i < sorted.length; i += 30) batches.push(sorted.slice(i, i + 30));
      const gt = await Promise.all(batches.map((b) => getJson<{ data?: GtToken[] }>(`${GT_API}/tokens/multi/${b.join(",")}`, 60)));
      for (const body of gt) {
        for (const t of body?.data ?? []) {
          const a = t.attributes;
          if (!a?.address) continue;
          const logo = a.image_url && !a.image_url.includes("missing") ? a.image_url : null;
          out.set(lc(a.address), { logo, usd: positive(a.price_usd) });
        }
      }
      const gaps = sorted.filter((a) => !out.get(a)?.usd);
      const ds: DsPair[][] = [];
      for (let i = 0; i < gaps.length; i += 30) ds.push((await getJson<DsPair[]>(`${DS_API}/${gaps.slice(i, i + 30).join(",")}`, 60)) ?? []);
      const best = new Map<Hex, { liq: number; pair: DsPair }>();
      for (const p of ds.flat()) {
        if (!p.baseToken?.address || !positive(p.priceUsd)) continue;
        const a = lc(p.baseToken.address);
        const liq = p.liquidity?.usd ?? 0;
        if (gaps.includes(a) && liq > (best.get(a)?.liq ?? -1)) best.set(a, { liq, pair: p });
      }
      for (const [a, { pair }] of best) {
        out.set(a, { logo: out.get(a)?.logo ?? pair.info?.imageUrl ?? null, usd: positive(pair.priceUsd) });
      }
      return out;
    },
    (m) => m.size > 0,
  );
}

function ethUsd(): Promise<number | null> {
  return cached("eth-usd", PRICE_TTL, fetchEthUsd, (v) => v != null);
}

/** AssetInfo for each asset row (ETH first-class, stocks recognised by address, everything else a token). */
export async function assetInfos(rows: AssetRow[]): Promise<Map<Hex, AssetInfo>> {
  const erc20 = rows.filter((r) => r.address !== ZERO_ADDRESS).map((r) => r.address);
  const [stocks, prices, eth] = await Promise.all([
    erc20.length ? stockList() : Promise.resolve(new Map<Hex, Stock>()),
    erc20.length ? stockPrices() : Promise.resolve(new Map<Hex, number>()),
    rows.some((r) => r.address === ZERO_ADDRESS) ? ethUsd() : Promise.resolve(null),
  ]);
  const others = erc20.filter((a) => !stocks.has(a));
  const tokens = others.length ? await tokenList(others) : new Map<Hex, Token>();
  return new Map(
    rows.map((r): [Hex, AssetInfo] => {
      if (r.address === ZERO_ADDRESS) {
        return [r.address, { address: r.address, symbol: "ETH", name: "Ether", decimals: 18, logo: null, kind: "native", usd: eth }];
      }
      const stock = stocks.get(r.address);
      if (stock) {
        const info: AssetInfo = {
          address: r.address,
          symbol: stock.symbol,
          name: stock.name,
          decimals: r.decimals,
          logo: stock.logo,
          kind: "stock",
          usd: prices.get(r.address) ?? null,
        };
        return [r.address, info];
      }
      const t = tokens.get(r.address);
      return [
        r.address,
        { address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals, logo: t?.logo ?? null, kind: "token", usd: t?.usd ?? null },
      ];
    }),
  );
}

/** USD per smallest unit of the asset, as a decimal string for SQL (null when unknown). */
export function usdPerUnit(info: AssetInfo): string | null {
  if (info.usd == null) return null;
  return (info.usd / 10 ** info.decimals).toExponential(15);
}

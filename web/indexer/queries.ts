/** Read-side helpers for the REST API: row → API shape, rolling windows over `trade`, USD at current asset prices. */
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type Column } from "drizzle-orm";
import type { AssetInfo, Hex, TokenDetail, TokenSummary, Trade, TradesResponse } from "@twain/shared";
import { formatUnits } from "viem";
import type { IxDb } from "./db";
import { assetInfos, usdPerUnit } from "./prices";
import { asset, token, trade, type AssetRow, type TokenRow, type TradeRow } from "./schema";

export type SQL = NonNullable<ReturnType<typeof and>>;
export type { TokenRow };

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Numeric/int8 aggregates come back as string (pg) or number (PGlite) — normalise. */
export const big = (v: unknown) => BigInt(v == null ? 0 : String(v));
export const num = (v: unknown) => Number(v ?? 0);

/** Percent change with 2-decimal precision; null when the base is zero. */
export function pctChange(now: bigint, base: bigint): number | null {
  if (base === 0n) return null;
  return Number(((now - base) * 1_000_000n) / base) / 10_000;
}

export function pctChangeNum(now: number | null, base: number | null): number | null {
  if (now == null || base == null || base === 0) return null;
  return Math.round(((now - base) / base) * 10_000) / 100;
}

// ---------- assets & USD ----------

export type Assets = { rows: AssetRow[]; info: Map<Hex, AssetInfo> };

/** Every listed asset with display details and current USD price (the list is short: the owner curates it). */
export async function loadAssets(db: IxDb): Promise<Assets> {
  const rows = await db.select().from(asset);
  return { rows, info: await assetInfos(rows) };
}

const UNKNOWN_ASSET = (address: Hex): AssetInfo => ({
  address,
  symbol: "?",
  name: "Unknown",
  decimals: 18,
  logo: null,
  kind: "token",
  usd: null,
});

export const infoOf = (assets: Assets, address: Hex) => assets.info.get(address) ?? UNKNOWN_ASSET(address);

/** USD value of an amount in the asset's smallest units. */
export function usdOf(amount: bigint, info: AssetInfo): number | null {
  return info.usd == null ? null : Number(formatUnits(amount, info.decimals)) * info.usd;
}

/** USD price of one whole coin from priceX18. */
export const priceUsdOf = (priceX18: bigint, info: AssetInfo) =>
  info.usd == null ? null : Number(formatUnits(priceX18, 18 + info.decimals)) * info.usd;

/** SQL: `amount` (asset smallest units, per row) × the row asset's USD price; assets without a price count as 0. */
export function usdSql(amount: SQL | Column, assetCol: Column, assets: Assets): SQL {
  const cases: SQL[] = [];
  for (const info of assets.info.values()) {
    const f = usdPerUnit(info);
    if (f) cases.push(sql`WHEN ${info.address} THEN (${amount}) * ${f}::numeric`);
  }
  return cases.length ? sql`(CASE ${assetCol} ${sql.join(cases, sql` `)} ELSE 0 END)` : sql`0`;
}

// ---------- tokens ----------

type Rolling = { v24: bigint; v7: bigint; ref: bigint | null };

/** 24h / 7d rolling volume and the reference price 24h ago, for a set of coins (2 queries). */
async function rollingStats(db: IxDb, addresses: Hex[]): Promise<Map<string, Rolling>> {
  const out = new Map<string, Rolling>();
  if (addresses.length === 0) return out;
  const now = nowSec();
  const c24 = now - 86_400;
  const c7 = now - 7 * 86_400;

  const [vols, refs] = await Promise.all([
    db
      .select({
        token: trade.token,
        v24: sql<string>`coalesce(sum(case when ${trade.timestamp} >= ${c24} then ${trade.assetAmount} else 0 end), 0)`,
        v7: sql<string>`coalesce(sum(${trade.assetAmount}), 0)`,
      })
      .from(trade)
      .where(and(inArray(trade.token, addresses), gte(trade.timestamp, c7)))
      .groupBy(trade.token),
    db
      .selectDistinctOn([trade.token], { token: trade.token, price: trade.price })
      .from(trade)
      .where(and(inArray(trade.token, addresses), lt(trade.timestamp, c24)))
      .orderBy(trade.token, desc(trade.blockNumber), desc(trade.logIndex)),
  ]);

  for (const v of vols) out.set(v.token, { v24: big(v.v24), v7: big(v.v7), ref: null });
  for (const r of refs) {
    const cur = out.get(r.token) ?? { v24: 0n, v7: 0n, ref: null };
    cur.ref = r.price;
    out.set(r.token, cur);
  }
  return out;
}

function toSummary(r: TokenRow, roll: Rolling | undefined, info: AssetInfo): TokenSummary {
  // Price 24h ago = last trade before the cutoff; with none, the coin was still at its launch price.
  const ref = roll?.ref ?? r.startPrice;
  const v24 = roll?.v24 ?? 0n;
  return {
    address: r.address,
    name: r.name,
    symbol: r.symbol,
    creator: r.creator,
    createdAt: r.createdAt,
    createdBlock: r.createdBlock,
    metadataUri: r.metadataUri,
    meta: { description: r.description, image: r.image, x: r.x, telegram: r.telegram, website: r.website },
    asset: info,
    poolId: r.poolId,
    coinIsCurrency0: r.coinIs0,
    priceX18: r.price.toString(),
    mcapAsset: r.mcap.toString(),
    priceUsd: priceUsdOf(r.price, info),
    mcapUsd: usdOf(r.mcap, info),
    volumeAsset24h: v24.toString(),
    volumeAsset7d: (roll?.v7 ?? 0n).toString(),
    volumeAssetAll: r.volumeAll.toString(),
    volumeUsd24h: usdOf(v24, info),
    change24hPct: pctChange(r.price, ref),
    tradesCount: r.tradesCount,
    holdersCount: r.holdersCount,
    lastBuyAt: r.lastBuyAt,
    lastTradeAt: r.lastTradeAt,
  };
}

export async function hydrate(db: IxDb, rows: TokenRow[], assets?: Assets): Promise<TokenSummary[]> {
  const [roll, a] = await Promise.all([rollingStats(db, rows.map((r) => r.address)), assets ?? loadAssets(db)]);
  return rows.map((r) => toSummary(r, roll.get(r.address), infoOf(a, r.asset)));
}

export async function hydrateDetail(db: IxDb, r: TokenRow): Promise<TokenDetail> {
  const [summary] = await hydrate(db, [r]);
  return {
    ...summary!,
    startPriceX18: r.startPrice.toString(),
    creatorFeesAccrued: r.creatorFeesAccrued.toString(),
    creatorFeesClaimed: r.creatorFeesClaimed.toString(),
    coinFeesToCreator: r.coinFeesCreator.toString(),
  };
}

/** Name/symbol prefix (case-insensitive, leading "$" ignored) or exact address. */
export function searchCondition(q: string): SQL | undefined {
  const s = q.trim().replace(/^\$/, "");
  if (!s) return undefined;
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return eq(token.address, s.toLowerCase() as Hex);
  const pattern = `${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return or(ilike(token.name, pattern), ilike(token.symbol, pattern));
}

// ---------- trades ----------

function toTrade(r: TradeRow, symbol: string | null, info: AssetInfo): Trade {
  return {
    id: r.id,
    txHash: r.txHash,
    blockNumber: r.blockNumber,
    timestamp: r.timestamp,
    token: r.token,
    ...(symbol ? { symbol } : {}),
    asset: info,
    trader: r.trader,
    side: r.side,
    assetAmount: r.assetAmount.toString(),
    tokenAmount: r.tokenAmount.toString(),
    feeAsset: r.feeAsset.toString(),
    priceX18: r.price.toString(),
  };
}

/** Newest first; cursor = "<blockNumber>_<logIndex>" of the last item returned. */
export async function listTrades(db: IxDb, where: SQL, limit: number, before: string | undefined): Promise<TradesResponse> {
  const conds: (SQL | undefined)[] = [where];
  const m = before?.match(/^(\d+)_(\d+)$/);
  if (m) conds.push(sql`(${trade.blockNumber}, ${trade.logIndex}) < (${Number(m[1])}, ${Number(m[2])})`);

  const [rows, assets] = await Promise.all([
    db
      .select({ t: trade, symbol: token.symbol })
      .from(trade)
      .leftJoin(token, eq(token.address, trade.token))
      .where(and(...conds))
      .orderBy(desc(trade.blockNumber), desc(trade.logIndex))
      .limit(limit + 1),
    loadAssets(db),
  ]);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toTrade(r.t, r.symbol, infoOf(assets, r.t.asset))),
    nextCursor: rows.length > limit && last ? `${last.t.blockNumber}_${last.t.logIndex}` : null,
  };
}

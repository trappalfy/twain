/**
 * REST API of the built-in indexer — shapes in packages/shared/src/api-types.ts. Served same-origin under /api
 * (app/api/{assets,tokens,stats,accounts,search,top}) and called in-process by server components (server.ts).
 * Bigints are decimal strings, addresses lowercase. Rolling windows are computed per request from `trade`, USD figures
 * from each asset's current price. /api/eth-usd is app/api/eth-usd/route.ts.
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, gt, gte, lte, min, ne, sql, sum } from "drizzle-orm";
import { CREATOR_FEE_SHARE, TOTAL_SUPPLY } from "@lancio/shared";
import type {
  AccountResponse,
  AssetKind,
  AssetsResponse,
  AssetTotals,
  CandlesResponse,
  CreatorFees,
  DailyResponse,
  HoldersResponse,
  HoldingsResponse,
  Interval,
  ProtocolStats,
  SortKey,
  TokensResponse,
  WindowKey,
} from "@lancio/shared";
import { ixDb, type IxDb } from "./db";
import { account, candle, dailyStats, holder, token, trade, type DailyRow } from "./schema";
import { DAY, dayKey, dayStartOf, INTERVALS, LOCKER, POOL_MANAGER, type Hex } from "./shared";
import {
  big,
  hydrate,
  hydrateDetail,
  infoOf,
  listTrades,
  loadAssets,
  nowSec,
  num,
  pctChange,
  pctChangeNum,
  searchCondition,
  usdOf,
  usdSql,
  type Assets,
  type SQL,
  type TokenRow,
} from "./queries";

const app = new Hono();

// ---------- params ----------

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const intParam = (v: string | undefined, fallback: number, lo: number, hi: number) => {
  const n = v === undefined || v === "" ? NaN : Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

const addressParam = (v: string | undefined): Hex | null =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v.toLowerCase() as Hex) : null;

const SORTS: readonly SortKey[] = ["recentBuys", "newest", "oldest", "marketCap", "volume"];
const WINDOWS: readonly WindowKey[] = ["all", "24h", "7d"];
const INTERVAL_KEYS = INTERVALS.map(([k]) => k) as readonly Interval[];

const badAddress = { error: "invalid_address" } as const;
const notFound = { error: "not_found" } as const;

// ---------- assets ----------

const KIND_ORDER: Record<AssetKind, number> = { native: 0, stock: 1, token: 2 };

app.get("/api/assets", async (c) => {
  const db = await ixDb();
  const assets = await loadAssets(db);
  // ETH, then stock tokens, then other tokens; most-used first within each group.
  const body: AssetsResponse = assets.rows
    .map((r) => ({
      ...infoOf(assets, r.address),
      enabled: r.enabled,
      startMcap: r.startMcap.toString(),
      startTick: r.startTick,
      coins: r.coins,
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.coins - a.coins || a.symbol.localeCompare(b.symbol));
  return c.json(body);
});

// ---------- tokens ----------

app.get("/api/tokens", async (c) => {
  const db = await ixDb();
  const sort = oneOf(c.req.query("sort"), SORTS, "recentBuys");
  const window = oneOf(c.req.query("window"), WINDOWS, "all");
  const page = intParam(c.req.query("page"), 1, 1, 10_000);
  const pageSize = intParam(c.req.query("pageSize"), 25, 1, 100);
  const offset = (page - 1) * pageSize;
  const q = c.req.query("q");
  const assetFilter = addressParam(c.req.query("asset"));

  const assets = await loadAssets(db);
  const conds: (SQL | undefined)[] = [];
  if (assetFilter) conds.push(eq(token.asset, assetFilter));
  if (q) conds.push(searchCondition(q));
  const cutoff = window === "all" ? null : nowSec() - (window === "24h" ? DAY : 7 * DAY);

  let rows: TokenRow[];
  let total: number;

  if (sort === "volume" && cutoff !== null) {
    // Rank by USD volume inside the window; coins without trades in it are left out.
    const vol = db
      .select({ token: trade.token, vol: sql<string>`sum(${usdSql(trade.assetAmount, trade.asset, assets)})`.as("vol") })
      .from(trade)
      .where(gte(trade.timestamp, cutoff))
      .groupBy(trade.token)
      .as("vol");
    const where = and(...conds);
    const [list, [agg]] = await Promise.all([
      db
        .select({ t: token })
        .from(token)
        .innerJoin(vol, eq(vol.token, token.address))
        .where(where)
        .orderBy(desc(vol.vol), desc(token.createdAt), asc(token.address))
        .limit(pageSize)
        .offset(offset),
      db.select({ n: count() }).from(token).innerJoin(vol, eq(vol.token, token.address)).where(where),
    ]);
    rows = list.map((r) => r.t);
    total = num(agg?.n);
  } else {
    // Window: recentBuys → bought within it; newest/oldest/marketCap/volume → launched within it.
    if (cutoff !== null) conds.push(sort === "recentBuys" ? gte(token.lastBuyAt, cutoff) : gte(token.createdAt, cutoff));
    const orderBy = {
      recentBuys: [sql`${token.lastBuyAt} desc nulls last`, desc(token.createdAt)],
      newest: [desc(token.createdAt), desc(token.createdBlock)],
      oldest: [asc(token.createdAt), asc(token.createdBlock)],
      marketCap: [desc(usdSql(token.mcap, token.asset, assets)), desc(token.createdAt)],
      volume: [desc(usdSql(token.volumeAll, token.asset, assets)), desc(token.createdAt)],
    }[sort];
    const where = and(...conds);
    const [list, [agg]] = await Promise.all([
      db
        .select()
        .from(token)
        .where(where)
        .orderBy(...orderBy, asc(token.address))
        .limit(pageSize)
        .offset(offset),
      db.select({ n: count() }).from(token).where(where),
    ]);
    rows = list;
    total = num(agg?.n);
  }

  const body: TokensResponse = { items: await hydrate(db, rows, assets), total, page, pageSize };
  return c.json(body);
});

app.get("/api/tokens/:address", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const [row] = await db.select().from(token).where(eq(token.address, address)).limit(1);
  if (!row) return c.json(notFound, 404);
  return c.json(await hydrateDetail(db, row));
});

app.get("/api/tokens/:address/candles", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const interval = oneOf(c.req.query("interval"), INTERVAL_KEYS, "1m");
  const from = intParam(c.req.query("from"), 0, 0, Number.MAX_SAFE_INTEGER);
  const to = intParam(c.req.query("to"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.req.query("limit"), 1000, 1, 2000);

  const conds: (SQL | undefined)[] = [eq(candle.token, address), eq(candle.interval, interval)];
  if (from) conds.push(gte(candle.time, from));
  if (to) conds.push(lte(candle.time, to));
  // Latest `limit` buckets in the range, returned ascending.
  const rows = await db
    .select()
    .from(candle)
    .where(and(...conds))
    .orderBy(desc(candle.time))
    .limit(limit);

  const body: CandlesResponse = rows.reverse().map((r) => ({
    time: r.time,
    open: r.open.toString(),
    high: r.high.toString(),
    low: r.low.toString(),
    close: r.close.toString(),
    volumeAsset: r.volume.toString(),
  }));
  return c.json(body);
});

app.get("/api/tokens/:address/trades", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const limit = intParam(c.req.query("limit"), 50, 1, 200);
  return c.json(await listTrades(db, eq(trade.token, address), limit, c.req.query("before")));
});

app.get("/api/tokens/:address/holders", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const limit = intParam(c.req.query("limit"), 20, 1, 100);
  const [row] = await db.select({ creator: token.creator }).from(token).where(eq(token.address, address)).limit(1);
  if (!row) return c.json(notFound, 404);

  const rows = await db
    .select({ account: holder.account, balance: holder.balance })
    .from(holder)
    // The locker only keeps rounding dust from creation; it is not a holder in any useful sense.
    .where(and(eq(holder.token, address), gt(holder.balance, 0n), ne(holder.account, LOCKER)))
    .orderBy(desc(holder.balance), asc(holder.account))
    .limit(limit);

  const body: HoldersResponse = rows.map((h) => ({
    account: h.account,
    balance: h.balance.toString(),
    shareBps: Number((h.balance * 10_000n) / TOTAL_SUPPLY),
    label: h.account === POOL_MANAGER ? "pool" : h.account === row.creator ? "creator" : null,
  }));
  return c.json(body);
});

// ---------- protocol stats ----------

async function completedDays(db: IxDb) {
  const today = dayStartOf(nowSec());
  const [r] = await db.select({ first: min(dailyStats.dayStart) }).from(dailyStats);
  const first = r?.first == null ? null : num(r.first);
  // A day is "complete" once it has ended; there is none until the first active UTC day closes.
  const latest = first !== null && first < today ? today - DAY : null;
  return { today, latest };
}

type Totals = { volume: bigint; fees: bigint; launches: number };

/** Per-asset totals → USD sums (assets without a price are left out of the USD figures). */
function summarise(perAsset: Map<Hex, Totals>, assets: Assets) {
  let volumeUsd: number | null = null;
  let feesUsd: number | null = null;
  let launches = 0;
  const byAsset: AssetTotals[] = [];
  for (const [addr, t] of perAsset) {
    const info = infoOf(assets, addr);
    launches += t.launches;
    const v = usdOf(t.volume, info);
    const f = usdOf(t.fees, info);
    if (v != null) volumeUsd = (volumeUsd ?? 0) + v;
    if (f != null) feesUsd = (feesUsd ?? 0) + f;
    byAsset.push({ asset: info, volume: t.volume.toString(), fees: t.fees.toString(), launches: t.launches });
  }
  if (volumeUsd === null && byAsset.every((a) => a.volume === "0")) volumeUsd = 0;
  if (feesUsd === null && byAsset.every((a) => a.fees === "0")) feesUsd = 0;
  return { volumeUsd, feesUsd, launches, byAsset };
}

const totalsOf = (rows: Pick<DailyRow, "asset" | "volume" | "fees" | "launches">[]) => {
  const m = new Map<Hex, Totals>();
  for (const r of rows) {
    const t = m.get(r.asset) ?? { volume: 0n, fees: 0n, launches: 0 };
    m.set(r.asset, { volume: t.volume + r.volume, fees: t.fees + r.fees, launches: t.launches + r.launches });
  }
  return m;
};

app.get("/api/stats", async (c) => {
  const db = await ixDb();
  const window = c.req.query("window") === "all" ? "all" : "24h";
  const [{ latest }, assets, [creators]] = await Promise.all([
    completedDays(db),
    loadAssets(db),
    db.select({ n: count() }).from(account).where(gt(account.createdCount, 0)),
  ]);

  let current: Map<Hex, Totals>;
  let prior: Map<Hex, Totals> | null = null;
  if (window === "all") {
    const rows = await db
      .select({ asset: dailyStats.asset, volume: sum(dailyStats.volume), fees: sum(dailyStats.fees), launches: sum(dailyStats.launches) })
      .from(dailyStats)
      .groupBy(dailyStats.asset);
    current = totalsOf(rows.map((r) => ({ asset: r.asset, volume: big(r.volume), fees: big(r.fees), launches: num(r.launches) })));
  } else {
    const rows =
      latest === null
        ? []
        : await db
            .select()
            .from(dailyStats)
            .where(and(gte(dailyStats.dayStart, latest - DAY), lte(dailyStats.dayStart, latest)));
    current = totalsOf(rows.filter((r) => r.dayStart === latest));
    if (latest !== null) prior = totalsOf(rows.filter((r) => r.dayStart === latest - DAY));
  }

  const now = summarise(current, assets);
  const before = prior ? summarise(prior, assets) : null;
  const creatorShare = Number(CREATOR_FEE_SHARE) / 100;
  const body: ProtocolStats = {
    window,
    updatedAt: nowSec(),
    latestCompleteDay: latest === null ? null : dayKey(latest),
    volumeUsd: now.volumeUsd,
    volumeChangePct: before ? pctChangeNum(now.volumeUsd, before.volumeUsd) : null,
    launches: now.launches,
    launchesChangePct: before ? pctChange(BigInt(now.launches), BigInt(before.launches)) : null,
    uniqueCreators: num(creators?.n),
    feesUsd: {
      creators: now.feesUsd == null ? null : now.feesUsd * creatorShare,
      protocol: now.feesUsd == null ? null : now.feesUsd * (1 - creatorShare),
    },
    byAsset: now.byAsset,
  };
  return c.json(body);
});

app.get("/api/stats/daily", async (c) => {
  const db = await ixDb();
  const days = intParam(c.req.query("days"), 14, 1, 365);
  const { latest } = await completedDays(db);
  if (latest === null) return c.json([] satisfies DailyResponse);

  const start = latest - (days - 1) * DAY;
  const [rows, assets] = await Promise.all([
    db
      .select()
      .from(dailyStats)
      .where(and(gte(dailyStats.dayStart, start), lte(dailyStats.dayStart, latest))),
    loadAssets(db),
  ]);

  const body: DailyResponse = [];
  for (let t = start; t <= latest; t += DAY) {
    const s = summarise(totalsOf(rows.filter((r) => r.dayStart === t)), assets);
    body.push({ day: dayKey(t), volumeUsd: s.volumeUsd ?? 0, launches: s.launches });
  }
  return c.json(body);
});

// ---------- accounts ----------

app.get("/api/accounts/:address", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const [[acc], created, assets] = await Promise.all([
    db.select().from(account).where(eq(account.address, address)).limit(1),
    db.select().from(token).where(eq(token.creator, address)).orderBy(desc(token.createdAt)).limit(200),
    loadAssets(db),
  ]);
  const fees = new Map<Hex, { accrued: bigint; claimed: bigint }>();
  for (const t of created) {
    const f = fees.get(t.asset) ?? { accrued: 0n, claimed: 0n };
    fees.set(t.asset, { accrued: f.accrued + t.creatorFeesAccrued, claimed: f.claimed + t.creatorFeesClaimed });
  }
  const creatorFees: CreatorFees[] = [...fees].map(([a, f]) => ({
    asset: infoOf(assets, a),
    accrued: f.accrued.toString(),
    claimed: f.claimed.toString(),
  }));
  const body: AccountResponse = {
    address,
    created: await hydrate(db, created, assets),
    creatorFees,
    tradesCount: acc?.tradesCount ?? 0,
  };
  return c.json(body);
});

app.get("/api/accounts/:address/holdings", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const assets = await loadAssets(db);
  // Value in the asset's smallest units = balance (18 decimals) × priceX18 / 1e36.
  const value = usdSql(sql`${holder.balance} * ${token.price} / 1e36`, token.asset, assets);
  const rows = await db
    .select({ t: token, balance: holder.balance })
    .from(holder)
    .innerJoin(token, eq(token.address, holder.token))
    .where(and(eq(holder.account, address), gt(holder.balance, 0n)))
    .orderBy(desc(value), desc(holder.balance), asc(token.address))
    .limit(200);
  const summaries = await hydrate(db, rows.map((r) => r.t), assets);
  const body: HoldingsResponse = rows.map((r, i) => ({ token: summaries[i]!, balance: r.balance.toString() }));
  return c.json(body);
});

app.get("/api/accounts/:address/trades", async (c) => {
  const db = await ixDb();
  const address = addressParam(c.req.param("address"));
  if (!address) return c.json(badAddress, 400);
  const limit = intParam(c.req.query("limit"), 50, 1, 200);
  return c.json(await listTrades(db, eq(trade.trader, address), limit, c.req.query("before")));
});

// ---------- search / top ----------

app.get("/api/search", async (c) => {
  const db = await ixDb();
  const cond = searchCondition(c.req.query("q") ?? "");
  if (!cond) return c.json([]);
  const assets = await loadAssets(db);
  const rows = await db
    .select()
    .from(token)
    .where(cond)
    .orderBy(desc(usdSql(token.mcap, token.asset, assets)), asc(token.address))
    .limit(10);
  return c.json(await hydrate(db, rows, assets));
});

app.get("/api/top", async (c) => {
  const db = await ixDb();
  const limit = intParam(c.req.query("limit"), 10, 1, 50);
  const assets = await loadAssets(db);
  const rows = await db
    .select()
    .from(token)
    .orderBy(desc(usdSql(token.mcap, token.asset, assets)), desc(token.createdAt), asc(token.address))
    .limit(limit);
  return c.json(await hydrate(db, rows, assets));
});

app.notFound((c) => c.json(notFound, 404));

app.onError((err, c) => {
  console.error("[indexer] api error:", err);
  return c.json({ error: "internal" }, 500);
});

export default app;

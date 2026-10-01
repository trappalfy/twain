/**
 * Applies decoded events (Launchpad, LiquidityLocker, coin Transfers, PoolManager Swaps of the coins' pools) to the
 * indexer tables.
 *
 * All rows touched by a batch are loaded once, changed in memory and written back by `flush()` in the
 * sync transaction, so a batch costs a handful of queries however many events it holds.
 */
import { coinIsCurrency0, mcapFromPriceX18, NATIVE_ASSET, openingSqrtPrice, POOL_FEE_PIPS, priceX18FromSqrt } from "@lancio/shared";
import { launchpadAbi, lockerAbi, poolManagerAbi, tokenAbi } from "@lancio/shared/abi";
import { and, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { getAbiItem, type ParseEventLogsReturnType } from "viem";
import type { IxDb } from "./db";
import {
  account,
  asset,
  candle,
  dailyStats,
  holder,
  pool,
  token,
  trade,
  type AccountRow,
  type AssetRow,
  type CandleRow,
  type DailyRow,
  type HolderRow,
  type PoolRow,
  type TokenRow,
  type TradeRow,
} from "./schema";
import { chunk, dayKey, dayStartOf, INTERVALS, isCountedHolder, lc, ZERO_ADDRESS, type Hex } from "./shared";

export const transferEvent = getAbiItem({ abi: tokenAbi, name: "Transfer" });
export const swapEvent = getAbiItem({ abi: poolManagerAbi, name: "Swap" });
export const ABIS = {
  launchpad: launchpadAbi,
  locker: lockerAbi,
  token: [transferEvent],
  pool: [swapEvent],
} as const;

type Decoded<A extends (typeof ABIS)[keyof typeof ABIS]> = ParseEventLogsReturnType<A, undefined, true>[number];

/** ERC-20 details of a newly listed asset, read by the sync before the batch is applied. */
export type AssetMeta = { symbol: string; name: string; decimals: number };

/** A decoded log plus what the handlers need from its block and transaction. */
export type Ev = (Decoded<typeof launchpadAbi> | Decoded<typeof lockerAbi> | Decoded<typeof ABIS.token> | Decoded<typeof ABIS.pool>) & {
  block: number;
  index: number;
  ts: number;
  txHash: Hex;
  /** transaction.from — fetched for pool swaps only (the trader). */
  txFrom: Hex | null;
  /** AssetSet only: the asset's ERC-20 details. */
  assetMeta?: AssetMeta;
};

export const NATIVE_META: AssetMeta = { symbol: "ETH", name: "Ether", decimals: 18 };

/* ------------------------------------------------------------------ row cache */

/** Rows keyed by string: loaded on first use (null = known missing), written back when marked dirty. */
class Rows<R> {
  private rows = new Map<string, R | null>();
  private dirty = new Set<string>();
  constructor(private load: (keys: string[]) => Promise<[string, R][]>) {}

  async preload(keys: Iterable<string>) {
    const missing = [...new Set(keys)].filter((k) => !this.rows.has(k));
    if (missing.length === 0) return;
    for (const k of missing) this.rows.set(k, null);
    for (const [k, r] of await this.load(missing)) this.rows.set(k, r);
  }

  async get(key: string): Promise<R | undefined> {
    if (!this.rows.has(key)) await this.preload([key]);
    return this.rows.get(key) ?? undefined;
  }

  put(key: string, row: R) {
    this.rows.set(key, row);
    this.dirty.add(key);
  }

  changed(): R[] {
    return [...this.dirty].map((k) => this.rows.get(k)!);
  }
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const holderKey = (tokenAddr: string, acct: string) => `${tokenAddr}:${acct}`;
const candleKey = (tokenAddr: string, interval: string, time: number) => `${tokenAddr}|${interval}|${time}`;
const dailyKey = (day: string, assetAddr: string) => `${day}|${assetAddr}`;

async function selectIn<R>(keys: string[], query: (part: string[]) => Promise<R[]>): Promise<R[]> {
  return (await Promise.all(chunk(keys, 500).map(query))).flat();
}

/* ------------------------------------------------------------------ counters */

type DailyCounters = Omit<DailyRow, "day" | "asset" | "dayStart">;
const EMPTY_DAILY: DailyCounters = { volume: 0n, fees: 0n, trades: 0, launches: 0, protocolClaimed: 0n };

type AccountCounters = Omit<AccountRow, "address">;
const EMPTY_ACCOUNT: AccountCounters = { createdCount: 0, tradesCount: 0 };

function addCounters<T extends object>(row: T, delta: Partial<Record<keyof T, bigint | number>>): T {
  const out = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(delta)) {
    if (v === undefined) continue;
    out[k] = typeof v === "bigint" ? (out[k] as bigint) + v : (out[k] as number) + (v as number);
  }
  return out as T;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/* ------------------------------------------------------------------ batch */

export class Batch {
  readonly assets: Rows<AssetRow>;
  readonly tokens: Rows<TokenRow>;
  readonly holders: Rows<HolderRow>;
  readonly accounts: Rows<AccountRow>;
  readonly candles: Rows<CandleRow>;
  readonly daily: Rows<DailyRow>;
  readonly pools: Rows<PoolRow>;
  readonly trades: TradeRow[] = [];

  constructor(private db: IxDb) {
    this.assets = new Rows(async (keys) =>
      (await db.select().from(asset).where(inArray(asset.address, keys as Hex[]))).map((r) => [r.address, r]),
    );
    this.tokens = new Rows(async (keys) =>
      (await selectIn(keys, (p) => db.select().from(token).where(inArray(token.address, p as Hex[])))).map((r) => [r.address, r]),
    );
    this.holders = new Rows(async (keys) => {
      const want = new Set(keys);
      const pairs = keys.map((k) => k.split(":") as [Hex, Hex]);
      const tokens = uniq(pairs.map((p) => p[0]));
      const rows = await selectIn(uniq(pairs.map((p) => p[1])), (accts) =>
        db
          .select()
          .from(holder)
          .where(and(inArray(holder.token, tokens), inArray(holder.account, accts as Hex[]))),
      );
      return rows.map((r) => [holderKey(r.token, r.account), r] as [string, HolderRow]).filter(([k]) => want.has(k));
    });
    this.accounts = new Rows(async (keys) =>
      (await selectIn(keys, (p) => db.select().from(account).where(inArray(account.address, p as Hex[])))).map((r) => [r.address, r]),
    );
    this.candles = new Rows(async (keys) => {
      const want = new Set(keys);
      const parts = keys.map((k) => k.split("|"));
      const rows = await db
        .select()
        .from(candle)
        .where(
          and(
            inArray(candle.token, uniq(parts.map((p) => p[0] as Hex))),
            inArray(candle.time, uniq(parts.map((p) => Number(p[2])))),
          ),
        );
      return rows.map((r) => [candleKey(r.token, r.interval, r.time), r] as [string, CandleRow]).filter(([k]) => want.has(k));
    });
    this.daily = new Rows(async (keys) => {
      const want = new Set(keys);
      const days = uniq(keys.map((k) => k.split("|")[0]!));
      const rows = await db.select().from(dailyStats).where(inArray(dailyStats.day, days));
      return rows.map((r) => [dailyKey(r.day, r.asset), r] as [string, DailyRow]).filter(([k]) => want.has(k));
    });
    this.pools = new Rows(async (keys) =>
      (await selectIn(keys, (p) => db.select().from(pool).where(inArray(pool.poolId, p as Hex[])))).map((r) => [r.poolId, r]),
    );
  }

  /** Bulk-loads the rows the events will obviously touch (the rest load on first use). */
  async preload(events: Ev[]) {
    const assets: string[] = [];
    const tokens: string[] = [];
    const holders: string[] = [];
    const accounts: string[] = [];
    const pools: string[] = [];
    for (const ev of events) {
      switch (ev.eventName) {
        case "Transfer": {
          const t = lc(ev.address);
          tokens.push(t);
          holders.push(holderKey(t, lc(ev.args.from)), holderKey(t, lc(ev.args.to)));
          break;
        }
        case "Swap":
          pools.push(lc(ev.args.id));
          if (ev.txFrom) accounts.push(ev.txFrom);
          break;
        case "CoinCreated":
          assets.push(lc(ev.args.asset));
          accounts.push(lc(ev.args.creator));
          break;
        case "AssetSet":
        case "AssetDisabled":
          assets.push(lc(ev.args.asset));
          break;
        default:
          if ("args" in ev && ev.args && "coin" in ev.args) tokens.push(lc(ev.args.coin as string));
      }
    }
    await Promise.all([
      this.assets.preload(assets),
      this.tokens.preload(tokens),
      this.holders.preload(holders),
      this.accounts.preload(accounts),
      this.pools.preload(pools),
    ]);
  }

  private async bumpDaily(ts: number, assetAddr: Hex, delta: Partial<DailyCounters>) {
    const dayStart = dayStartOf(ts);
    const day = dayKey(dayStart);
    const key = dailyKey(day, assetAddr);
    const row = (await this.daily.get(key)) ?? { day, asset: assetAddr, dayStart, ...EMPTY_DAILY };
    this.daily.put(key, addCounters(row, delta));
  }

  private async bumpAccount(address: Hex, delta: Partial<AccountCounters>) {
    const row = (await this.accounts.get(address)) ?? { address, ...EMPTY_ACCOUNT };
    this.accounts.put(address, addCounters(row, delta));
  }

  /**
   * Updates all six candle intervals for one trade. A new bucket opens at the price before the trade
   * (`prevPrice`), so consecutive candles connect and the first candle of a coin starts at its launch price.
   */
  private async upsertCandles(tokenAddr: Hex, ts: number, prevPrice: bigint, price: bigint, volume: bigint) {
    const hi = price > prevPrice ? price : prevPrice;
    const lo = price < prevPrice ? price : prevPrice;
    const keys = INTERVALS.map(([interval, secs]) => [interval, ts - (ts % secs)] as const);
    await this.candles.preload(keys.map(([i, t]) => candleKey(tokenAddr, i, t)));
    for (const [interval, time] of keys) {
      const key = candleKey(tokenAddr, interval, time);
      const row = await this.candles.get(key);
      this.candles.put(
        key,
        row
          ? {
              ...row,
              high: row.high > price ? row.high : price,
              low: row.low < price ? row.low : price,
              close: price,
              volume: row.volume + volume,
              trades: row.trades + 1,
            }
          : { token: tokenAddr, interval, time, open: prevPrice, high: hi, low: lo, close: price, volume, trades: 1 },
      );
    }
  }

  private async mustToken(address: Hex, ev: Ev): Promise<TokenRow> {
    const t = await this.tokens.get(address);
    if (!t) throw new Error(`${ev.eventName} for unknown coin ${address} in tx ${ev.txHash}`);
    return t;
  }

  async apply(ev: Ev) {
    const ts = ev.ts;
    switch (ev.eventName) {
      case "AssetSet": {
        const address = lc(ev.args.asset);
        const meta = address === NATIVE_ASSET ? NATIVE_META : ev.assetMeta;
        if (!meta) throw new Error(`AssetSet without asset details for ${address} in tx ${ev.txHash}`);
        const prev = await this.assets.get(address);
        this.assets.put(address, {
          address,
          symbol: prev?.symbol ?? meta.symbol,
          name: prev?.name ?? meta.name,
          decimals: prev?.decimals ?? meta.decimals,
          enabled: true,
          startMcap: ev.args.startMcap,
          startTick: Number(ev.args.startTick),
          listedAt: prev?.listedAt ?? ts,
          coins: prev?.coins ?? 0,
        });
        return;
      }

      case "AssetDisabled": {
        const address = lc(ev.args.asset);
        const prev = await this.assets.get(address);
        if (prev) this.assets.put(address, { ...prev, enabled: false });
        return;
      }

      case "CoinCreated": {
        const address = lc(ev.args.coin);
        const creator = lc(ev.args.creator);
        const assetAddr = lc(ev.args.asset);
        const poolId = lc(ev.args.poolId);
        const startTick = Number(ev.args.startTick);
        const coinIs0 = coinIsCurrency0(address, assetAddr);
        const startPrice = priceX18FromSqrt(openingSqrtPrice(startTick, coinIs0), coinIs0);
        // Only the mint to the locker precedes this event; the creator's first buy follows it (Swap, Transfer).
        this.tokens.put(address, {
          address,
          name: ev.args.name,
          symbol: ev.args.symbol,
          creator,
          createdAt: ts,
          createdBlock: ev.block,
          createdTx: ev.txHash,
          asset: assetAddr,
          poolId,
          coinIs0,
          startTick,
          startPrice,
          metadataUri: ev.args.metadataURI,
          description: null,
          image: null,
          x: null,
          telegram: null,
          website: null,
          metaPending: true,
          metaAttempts: 0,
          liquidity: 0n,
          price: startPrice,
          mcap: mcapFromPriceX18(startPrice),
          volumeAll: 0n,
          tradesCount: 0,
          holdersCount: 0,
          lastBuyAt: null,
          lastTradeAt: null,
          creatorFeesAccrued: 0n,
          creatorFeesClaimed: 0n,
          coinFeesCreator: 0n,
          coinFeesProtocol: 0n,
        });
        this.pools.put(poolId, { poolId, token: address });
        const a = await this.assets.get(assetAddr);
        if (a) this.assets.put(assetAddr, { ...a, coins: a.coins + 1 });
        await this.bumpAccount(creator, { createdCount: 1 });
        await this.bumpDaily(ts, assetAddr, { launches: 1 });
        return;
      }

      case "LiquidityLocked": {
        const address = lc(ev.args.coin);
        const t = await this.mustToken(address, ev);
        this.tokens.put(address, { ...t, liquidity: ev.args.liquidity });
        return;
      }

      // Asset side of collected pool fees, credited to pull balances 60/40 on the launchpad.
      case "FeesDeposited": {
        const address = lc(ev.args.coin);
        const t = await this.mustToken(address, ev);
        this.tokens.put(address, { ...t, creatorFeesAccrued: t.creatorFeesAccrued + ev.args.creatorAmount });
        return;
      }

      case "CreatorFeesClaimed": {
        const address = lc(ev.args.coin);
        const t = await this.mustToken(address, ev);
        this.tokens.put(address, { ...t, creatorFeesClaimed: t.creatorFeesClaimed + ev.args.amount });
        return;
      }

      case "CreatorTransferred": {
        const address = lc(ev.args.coin);
        const t = await this.mustToken(address, ev);
        this.tokens.put(address, { ...t, creator: lc(ev.args.to) });
        return;
      }

      case "ProtocolFeesClaimed":
        await this.bumpDaily(ts, lc(ev.args.asset), { protocolClaimed: ev.args.amount });
        return;

      // Locker fee collection: the asset part is credited by FeesDeposited, so only the coin side is recorded here.
      case "FeesCollected": {
        const { coinToCreator, coinToProtocol } = ev.args;
        if (coinToCreator === 0n && coinToProtocol === 0n) return;
        const address = lc(ev.args.coin);
        const t = await this.mustToken(address, ev);
        this.tokens.put(address, {
          ...t,
          coinFeesCreator: t.coinFeesCreator + coinToCreator,
          coinFeesProtocol: t.coinFeesProtocol + coinToProtocol,
        });
        return;
      }

      // Holder balances of every coin.
      case "Transfer": {
        const { value } = ev.args;
        if (value === 0n) return;
        const tokenAddr = lc(ev.address);
        const from = lc(ev.args.from);
        const to = lc(ev.args.to);
        let delta = 0;
        const move = async (acct: Hex, change: bigint) => {
          const key = holderKey(tokenAddr, acct);
          const prev = (await this.holders.get(key))?.balance ?? 0n;
          const next = prev + change;
          this.holders.put(key, { token: tokenAddr, account: acct, balance: next });
          if (isCountedHolder(acct)) {
            if (prev <= 0n && next > 0n) delta++;
            else if (prev > 0n && next <= 0n) delta--;
          }
        };
        if (from !== ZERO_ADDRESS) await move(from, -value);
        if (to !== ZERO_ADDRESS) await move(to, value);
        // The constructor mint is seen before CoinCreated (row missing); it only moves zero → locker, never counted.
        const t = delta !== 0 ? await this.tokens.get(tokenAddr) : undefined;
        if (t) this.tokens.put(tokenAddr, { ...t, holdersCount: t.holdersCount + delta });
        return;
      }

      /**
       * Uniswap v4 swaps in the coins' pools. Amounts are the swapper's deltas: negative = paid by the swapper, so a
       * buy has a positive coin delta. feeAsset: buy → assetIn · fee / 1e6; sell → assetOut · fee / (1e6 − fee)
       * (the coin fee valued at the execution price). trader = transaction.from (routers swap on users' behalf).
       */
      case "Swap": {
        const p = await this.pools.get(lc(ev.args.id));
        if (!p) return;
        const t = await this.tokens.get(p.token);
        if (!t) return;
        const { amount0, amount1, sqrtPriceX96, fee } = ev.args;
        const coinDelta = t.coinIs0 ? amount0 : amount1;
        const assetDelta = t.coinIs0 ? amount1 : amount0;
        const assetAmount = abs(assetDelta);
        const tokenAmount = abs(coinDelta);
        if (assetAmount === 0n && tokenAmount === 0n) return;
        if (!ev.txFrom) throw new Error(`Swap without transaction sender in tx ${ev.txHash}`);

        const isBuy = coinDelta > 0n;
        const feePips = BigInt(fee);
        const feeAsset = isBuy
          ? (assetAmount * feePips) / POOL_FEE_PIPS
          : feePips < POOL_FEE_PIPS
            ? (assetAmount * feePips) / (POOL_FEE_PIPS - feePips)
            : 0n;
        const price = sqrtPriceX96 > 0n ? priceX18FromSqrt(sqrtPriceX96, t.coinIs0) : t.price;
        const trader = ev.txFrom;

        this.trades.push({
          id: `${ev.txHash}-${ev.index}`,
          token: t.address,
          asset: t.asset,
          trader,
          side: isBuy ? "buy" : "sell",
          assetAmount,
          tokenAmount,
          feeAsset,
          price,
          txHash: ev.txHash,
          blockNumber: ev.block,
          logIndex: ev.index,
          timestamp: ts,
        });
        this.tokens.put(t.address, {
          ...t,
          price,
          mcap: mcapFromPriceX18(price),
          volumeAll: t.volumeAll + assetAmount,
          tradesCount: t.tradesCount + 1,
          lastTradeAt: ts,
          lastBuyAt: isBuy ? ts : t.lastBuyAt,
        });
        await this.bumpAccount(trader, { tradesCount: 1 });
        await this.bumpDaily(ts, t.asset, { volume: assetAmount, fees: feeAsset, trades: 1 });
        await this.upsertCandles(t.address, ts, t.price, price, assetAmount);
        return;
      }

      default:
        return; // OwnershipTransferred, TreasuryUpdated, CreationPausedSet, … — not indexed
    }
  }

  /** Writes every changed row. Run inside the sync transaction. */
  async flush(db: IxDb) {
    await upsert(db, asset, this.assets.changed(), [asset.address]);
    await upsert(db, token, this.tokens.changed(), [token.address]);
    await upsert(db, holder, this.holders.changed(), [holder.token, holder.account]);
    await upsert(db, account, this.accounts.changed(), [account.address]);
    await upsert(db, candle, this.candles.changed(), [candle.token, candle.interval, candle.time]);
    await upsert(db, dailyStats, this.daily.changed(), [dailyStats.day, dailyStats.asset]);
    await upsert(db, pool, this.pools.changed(), [pool.poolId]);
    for (const part of chunk(this.trades, 200)) await db.insert(trade).values(part).onConflictDoNothing();
  }
}

/** INSERT … ON CONFLICT (pk) DO UPDATE SET every other column = excluded. */
async function upsert<T extends PgTable>(db: IxDb, table: T, rows: T["$inferInsert"][], target: PgColumn[]) {
  if (rows.length === 0) return;
  const set = Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([, c]) => !target.includes(c))
      .map(([k, c]) => [k, sql.raw(`excluded."${c.name}"`)]),
  ) as PgUpdateSetSource<T>;
  for (const part of chunk(rows, 200)) {
    await db.insert(table).values(part).onConflictDoUpdate({ target, set });
  }
}

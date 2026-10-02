/**
 * Applies decoded events to the indexer tables:
 *  - TwainLauncher CoinLaunched → coin row (curve constants and onchain token info read by the sync beforehand);
 *  - each coin's Pons curve: CurveBuy / CurveSell → trades, exact reserve replay → price, progress;
 *  - Pons factory: graduation phases, creator-fee-recipient overrides, pair-token approvals and economics;
 *  - each coin's TwainFeeVault: fee splits, creator payouts, creator transfers;
 *  - coin Transfers → holders; PoolManager Swaps in the graduated pools (+ the Pons hook's fee) → trades.
 *
 * All rows touched by a batch are loaded once, changed in memory and written back by `flush()` in the
 * sync transaction, so a batch costs a handful of queries however many events it holds.
 */
import {
  applyCurveBuy,
  applyCurveSell,
  coinIsCurrency0,
  curvePriceX18,
  curveProgressBps,
  priceX18FromSqrt,
  type CoinPhase,
} from "@twain/shared";
import { ponsCurveAbi, ponsFactoryAbi, ponsHookAbi, poolManagerAbi, tokenAbi, twainFeeVaultAbi, twainLauncherAbi } from "@twain/shared/abi";
import { and, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { encodeAbiParameters, getAbiItem, keccak256, parseAbi, type ParseEventLogsReturnType } from "viem";
import type { IxDb } from "./db";
import { parseMeta, type OnchainInfo } from "./metadata";
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
import {
  chunk,
  coinValue,
  dayKey,
  dayStartOf,
  INTERVALS,
  isCountedHolder,
  lc,
  mcapOf,
  MEME_HOOK,
  ZERO_ADDRESS,
  type Hex,
} from "./shared";

/** Factory events not in the shared fragment list. */
const factoryExtraAbi = parseAbi([
  "event LaunchGraduationRescued(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount)",
  "event LaunchConfigUpdated(uint256 indexed id)",
]);

/** Only the events the indexer handles, per emitter (names are unique across them). */
export const ABIS = {
  launcher: [getAbiItem({ abi: twainLauncherAbi, name: "CoinLaunched" })],
  curve: [getAbiItem({ abi: ponsCurveAbi, name: "CurveBuy" }), getAbiItem({ abi: ponsCurveAbi, name: "CurveSell" })],
  vault: [
    getAbiItem({ abi: twainFeeVaultAbi, name: "FeesSplit" }),
    getAbiItem({ abi: twainFeeVaultAbi, name: "CreatorPaid" }),
    getAbiItem({ abi: twainFeeVaultAbi, name: "CreatorTransferred" }),
  ],
  coin: [getAbiItem({ abi: tokenAbi, name: "Transfer" })],
  factory: [
    getAbiItem({ abi: ponsFactoryAbi, name: "LaunchSwept" }),
    getAbiItem({ abi: ponsFactoryAbi, name: "PoolGraduated" }),
    getAbiItem({ abi: ponsFactoryAbi, name: "CreatorFeeRecipientChangeProposed" }),
    getAbiItem({ abi: ponsFactoryAbi, name: "CreatorFeeRecipientChangeCancelled" }),
    getAbiItem({ abi: ponsFactoryAbi, name: "CreatorFeeRecipientUpdated" }),
    getAbiItem({ abi: ponsFactoryAbi, name: "PairTokenApprovalUpdated" }),
    getAbiItem({ abi: ponsFactoryAbi, name: "PairTokenEconomicsUpdated" }),
    getAbiItem({ abi: factoryExtraAbi, name: "LaunchGraduationRescued" }),
    getAbiItem({ abi: factoryExtraAbi, name: "LaunchConfigUpdated" }),
  ],
  pool: [getAbiItem({ abi: poolManagerAbi, name: "Swap" })],
  hook: [getAbiItem({ abi: ponsHookAbi, name: "HookFeeCollected" })],
} as const;

type Decoded<A extends (typeof ABIS)[keyof typeof ABIS]> = ParseEventLogsReturnType<A, undefined, true>[number];
export type DecodedLog =
  | Decoded<typeof ABIS.launcher>
  | Decoded<typeof ABIS.curve>
  | Decoded<typeof ABIS.vault>
  | Decoded<typeof ABIS.coin>
  | Decoded<typeof ABIS.factory>
  | Decoded<typeof ABIS.pool>;

/** ERC-20 details of a pair token, read by the sync when the token is first seen. */
export type AssetMeta = { symbol: string; name: string; decimals: number };

/** What a new coin's row needs besides CoinLaunched, read by the sync at the latest block (it never changes). */
export type LaunchInfo = OnchainInfo & {
  name: string;
  symbol: string;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  reservedTokens: bigint;
  supply: bigint;
  feeBps: number;
  taxBps: number;
  poolFee: number;
  tickSpacing: number;
};

/** Pons launch config 0 (the ETH pair's economics). */
export type EthEconomics = { phantomQuote: bigint; graduationThreshold: bigint; enabled: boolean };

/** The Pons hook's cut of a pool swap, from the HookFeeCollected that follows the Swap in the same transaction. */
export type HookFee = { currency: Hex; fee: bigint; tax: bigint };

/** A decoded log plus what the handlers need from its block and transaction. */
export type Ev = DecodedLog & {
  block: number;
  index: number;
  ts: number;
  txHash: Hex;
  /** transaction.from — fetched for pool swaps only (the trader; the Swap's sender is the router). */
  txFrom: Hex | null;
  /** Curve, vault and coin events: the coin they belong to. */
  coin?: Hex;
  /** CoinLaunched only. */
  launch?: LaunchInfo;
  /** PairToken* events for a token the database does not know yet. */
  assetMeta?: AssetMeta;
  /** LaunchConfigUpdated(0) only: config 0 as it is now. */
  ethEconomics?: EthEconomics;
  /** Swap only. */
  hookFee?: HookFee;
};

export const NATIVE_META: AssetMeta = { symbol: "ETH", name: "Ether", decimals: 18 };

/** Pons graduated pool of a coin: sorted currencies, the launch's fee and spacing, the Pons meme hook. */
export function ponsPoolId(coin: Hex, pairToken: Hex, fee: number, tickSpacing: number): Hex {
  const [c0, c1] = BigInt(pairToken) < BigInt(coin) ? [pairToken, coin] : [coin, pairToken];
  return lc(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
        [c0, c1, fee, tickSpacing, MEME_HOOK],
      ),
    ),
  );
}

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
const EMPTY_DAILY: DailyCounters = { volume: 0n, fees: 0n, trades: 0, launches: 0, creatorFees: 0n, protocolFees: 0n };

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

type TradeInput = {
  trader: Hex;
  side: "buy" | "sell";
  venue: "curve" | "pool";
  assetAmount: bigint;
  tokenAmount: bigint;
  feeAsset: bigint;
  price: bigint;
};

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

  constructor(db: IxDb) {
    this.assets = new Rows(async (keys) =>
      (await selectIn(keys, (p) => db.select().from(asset).where(inArray(asset.address, p as Hex[])))).map((r) => [r.address, r]),
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
      if (ev.coin) tokens.push(ev.coin);
      switch (ev.eventName) {
        case "Transfer":
          holders.push(holderKey(ev.coin ?? lc(ev.address), lc(ev.args.from)), holderKey(ev.coin ?? lc(ev.address), lc(ev.args.to)));
          break;
        case "Swap":
          pools.push(lc(ev.args.id));
          if (ev.txFrom) accounts.push(ev.txFrom);
          break;
        case "CoinLaunched":
          assets.push(lc(ev.args.pairToken));
          accounts.push(lc(ev.args.creator));
          break;
        case "CurveBuy":
          accounts.push(lc(ev.args.recipient));
          break;
        case "CurveSell":
          accounts.push(lc(ev.args.seller));
          break;
        case "PairTokenApprovalUpdated":
        case "PairTokenEconomicsUpdated":
          assets.push(lc(ev.args.pairToken));
          break;
        case "LaunchConfigUpdated":
          assets.push(ZERO_ADDRESS);
          break;
        case "LaunchSwept":
        case "PoolGraduated":
        case "LaunchGraduationRescued":
        case "CreatorFeeRecipientChangeProposed":
        case "CreatorFeeRecipientChangeCancelled":
        case "CreatorFeeRecipientUpdated":
          tokens.push(lc(ev.args.token));
          break;
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
   * Updates all six candle intervals for one price change. A new bucket opens at the price before the change
   * (`prevPrice`), so consecutive candles connect and the first candle of a coin starts at its launch price.
   * `trades` = 0 for price moves that are not trades (the Pons hook converting its fees).
   */
  private async upsertCandles(tokenAddr: Hex, ts: number, prevPrice: bigint, price: bigint, volume: bigint, trades = 1) {
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
              trades: row.trades + trades,
            }
          : { token: tokenAddr, interval, time, open: prevPrice, high: hi, low: lo, close: price, volume, trades },
      );
    }
  }

  private async mustToken(address: Hex | undefined, ev: Ev): Promise<TokenRow> {
    const t = address ? await this.tokens.get(address) : undefined;
    if (!t) throw new Error(`${ev.eventName} for unknown coin ${address} in tx ${ev.txHash}`);
    return t;
  }

  /** One trade on either venue: trade row, coin price/volume, trader, daily totals, candles. */
  private async recordTrade(t: TokenRow, ev: Ev, x: TradeInput, extra: Partial<TokenRow> = {}) {
    const ts = ev.ts;
    this.trades.push({
      id: `${ev.txHash}-${ev.index}`,
      token: t.address,
      asset: t.asset,
      trader: x.trader,
      side: x.side,
      venue: x.venue,
      assetAmount: x.assetAmount,
      tokenAmount: x.tokenAmount,
      feeAsset: x.feeAsset,
      price: x.price,
      txHash: ev.txHash,
      blockNumber: ev.block,
      logIndex: ev.index,
      timestamp: ts,
    });
    this.tokens.put(t.address, {
      ...t,
      ...extra,
      price: x.price,
      mcap: mcapOf(x.price, t.supply),
      volumeAll: t.volumeAll + x.assetAmount,
      tradesCount: t.tradesCount + 1,
      lastTradeAt: ts,
      lastBuyAt: x.side === "buy" ? ts : t.lastBuyAt,
    });
    await this.bumpAccount(x.trader, { tradesCount: 1 });
    await this.bumpDaily(ts, t.asset, { volume: x.assetAmount, fees: x.feeAsset, trades: 1 });
    await this.upsertCandles(t.address, ts, t.price, x.price, x.assetAmount);
  }

  private async setPhase(ev: Ev & { args: { token: Hex } }, phase: CoinPhase) {
    const t = await this.tokens.get(lc(ev.args.token));
    if (!t) return; // another launchpad's coin
    this.tokens.put(t.address, { ...t, phase, progressBps: phase === "curve" ? t.progressBps : 10_000 });
  }

  /** Creates or updates a pair asset; ERC-20 details come from the database or, for a new token, from the sync. */
  private async upsertAsset(address: Hex, ev: Ev, change: Partial<AssetRow>) {
    const prev = await this.assets.get(address);
    const meta = address === ZERO_ADDRESS ? NATIVE_META : ev.assetMeta;
    if (!prev && !meta) throw new Error(`${ev.eventName} without asset details for ${address} in tx ${ev.txHash}`);
    const base: AssetRow = prev ?? {
      address,
      symbol: meta!.symbol,
      name: meta!.name,
      decimals: meta!.decimals,
      enabled: false,
      phantomQuote: 0n,
      graduationThreshold: 0n,
      listedBlock: ev.block,
      coins: 0,
    };
    this.assets.put(address, { ...base, ...change });
  }

  /** ETH as a pair asset: Pons launch config 0 (read at the latest block). */
  async setEthAsset(e: EthEconomics, block: number) {
    const prev = await this.assets.get(ZERO_ADDRESS);
    this.assets.put(ZERO_ADDRESS, {
      address: ZERO_ADDRESS,
      ...NATIVE_META,
      listedBlock: prev?.listedBlock ?? block,
      coins: prev?.coins ?? 0,
      ...e,
    });
  }

  async apply(ev: Ev) {
    const ts = ev.ts;
    switch (ev.eventName) {
      /* ---------------- launcher */

      case "CoinLaunched": {
        const L = ev.launch;
        if (!L) throw new Error(`CoinLaunched without launch info in tx ${ev.txHash}`);
        const address = lc(ev.args.coin);
        const creator = lc(ev.args.creator);
        const assetAddr = lc(ev.args.pairToken);
        const curve = lc(ev.args.curve);
        const vault = lc(ev.args.vault);
        const poolId = ponsPoolId(address, assetAddr, L.poolFee, L.tickSpacing);
        const startPrice = curvePriceX18(L.phantomQuote, L.supply);
        const meta = parseMeta(L);
        // The sync moves CoinLaunched ahead of the rest of its transaction: the supply mint to the curve and the
        // creator's first buy (Transfer, CurveBuy) are emitted before it and are applied after it.
        this.tokens.put(address, {
          address,
          name: L.name,
          symbol: L.symbol,
          creator,
          createdAt: ts,
          createdBlock: ev.block,
          createdTx: ev.txHash,
          asset: assetAddr,
          curve,
          vault,
          poolId,
          coinIs0: coinIsCurrency0(address, assetAddr),
          phase: "curve",
          phantomQuote: L.phantomQuote,
          graduationThreshold: L.graduationThreshold,
          reservedTokens: L.reservedTokens,
          supply: L.supply,
          feeBps: L.feeBps,
          taxBps: L.taxBps,
          quoteReserve: L.phantomQuote,
          tokenReserve: L.supply,
          progressBps: 0,
          startPrice,
          logo: L.logo,
          ...meta,
          price: startPrice,
          mcap: mcapOf(startPrice, L.supply),
          volumeAll: 0n,
          tradesCount: 0,
          holdersCount: 0,
          lastBuyAt: null,
          lastTradeAt: null,
          creatorFeesAccrued: 0n,
          creatorFeesClaimed: 0n,
          coinFeesCreator: 0n,
          feeRecipient: vault,
          pendingRecipient: null,
          pendingEffectiveAt: null,
          pendingExpiresAt: null,
        });
        this.pools.put(poolId, { poolId, token: address });
        const a = await this.assets.get(assetAddr);
        if (a) this.assets.put(assetAddr, { ...a, coins: a.coins + 1 });
        await this.bumpAccount(creator, { createdCount: 1 });
        await this.bumpDaily(ts, assetAddr, { launches: 1 });
        return;
      }

      /* ---------------- curve */

      // quoteIn = quote actually spent (fees included, refund excluded); fee includes the snipe tax.
      case "CurveBuy": {
        const t = await this.mustToken(ev.coin, ev);
        const { quoteIn, tokensOut, fee, tax } = ev.args;
        const next = applyCurveBuy(this.curveState(t), quoteIn, tokensOut, fee, tax);
        const progress = curveProgressBps(next.tokenReserve, t.supply, t.reservedTokens);
        await this.recordTrade(
          t,
          ev,
          {
            trader: lc(ev.args.recipient),
            side: "buy",
            venue: "curve",
            assetAmount: quoteIn,
            tokenAmount: tokensOut,
            feeAsset: fee + tax,
            price: curvePriceX18(next.quoteReserve, next.tokenReserve),
          },
          {
            quoteReserve: next.quoteReserve,
            tokenReserve: next.tokenReserve,
            progressBps: progress,
            // The allocation is sold out: the curve takes no more buys or sells. Pons graduates in the same buy unless
            // that call fails (AutoGraduationFailed); then anyone can finish it, and LaunchSwept follows later.
            phase: progress >= 10_000 ? "graduating" : t.phase,
          },
        );
        return;
      }

      // quoteOut is net of the fee and the creator tax.
      case "CurveSell": {
        const t = await this.mustToken(ev.coin, ev);
        const { tokensIn, quoteOut, fee, tax } = ev.args;
        const next = applyCurveSell(this.curveState(t), tokensIn, quoteOut, fee, tax);
        await this.recordTrade(
          t,
          ev,
          {
            trader: lc(ev.args.seller),
            side: "sell",
            venue: "curve",
            assetAmount: quoteOut,
            tokenAmount: tokensIn,
            feeAsset: fee + tax,
            price: curvePriceX18(next.quoteReserve, next.tokenReserve),
          },
          {
            quoteReserve: next.quoteReserve,
            tokenReserve: next.tokenReserve,
            progressBps: curveProgressBps(next.tokenReserve, t.supply, t.reservedTokens),
          },
        );
        return;
      }

      /* ---------------- Pons factory */

      case "LaunchSwept":
        return this.setPhase(ev, "graduating");
      case "PoolGraduated":
        return this.setPhase(ev, "pool");
      case "LaunchGraduationRescued":
        return this.setPhase(ev, "rescued");

      case "CreatorFeeRecipientChangeProposed": {
        const t = await this.tokens.get(lc(ev.args.token));
        if (!t) return;
        this.tokens.put(t.address, {
          ...t,
          pendingRecipient: lc(ev.args.proposedRecipient),
          pendingEffectiveAt: Number(ev.args.effectiveAt),
          pendingExpiresAt: Number(ev.args.expiresAt),
        });
        return;
      }

      case "CreatorFeeRecipientChangeCancelled": {
        const t = await this.tokens.get(lc(ev.args.token));
        if (!t) return;
        this.tokens.put(t.address, { ...t, pendingRecipient: null, pendingEffectiveAt: null, pendingExpiresAt: null });
        return;
      }

      // Executing a matured override emits only this event; a creator transfer would leave the override pending.
      case "CreatorFeeRecipientUpdated": {
        const t = await this.tokens.get(lc(ev.args.token));
        if (!t) return;
        const to = lc(ev.args.newRecipient);
        const executed = t.pendingRecipient === to;
        this.tokens.put(t.address, {
          ...t,
          feeRecipient: to,
          ...(executed ? { pendingRecipient: null, pendingEffectiveAt: null, pendingExpiresAt: null } : {}),
        });
        return;
      }

      case "PairTokenEconomicsUpdated":
        return this.upsertAsset(lc(ev.args.pairToken), ev, {
          phantomQuote: ev.args.phantomQuote,
          graduationThreshold: ev.args.graduationThreshold,
          decimals: Number(ev.args.decimals),
        });

      case "PairTokenApprovalUpdated":
        return this.upsertAsset(lc(ev.args.pairToken), ev, { enabled: ev.args.approved });

      case "LaunchConfigUpdated":
        if (ev.args.id !== 0n || !ev.ethEconomics) return;
        return this.upsertAsset(ZERO_ADDRESS, ev, ev.ethEconomics);

      /* ---------------- fee vault */

      // Every arrival is split 60/40: pair-asset shares are the creator fees; coin-side shares are valued at the coin price.
      case "FeesSplit": {
        const t = await this.mustToken(ev.coin, ev);
        const a = lc(ev.args.asset);
        const { creatorAmount, treasuryAmount } = ev.args;
        if (a === t.asset) {
          this.tokens.put(t.address, { ...t, creatorFeesAccrued: t.creatorFeesAccrued + creatorAmount });
          await this.bumpDaily(ts, t.asset, { creatorFees: creatorAmount, protocolFees: treasuryAmount });
        } else if (a === t.address) {
          this.tokens.put(t.address, { ...t, coinFeesCreator: t.coinFeesCreator + creatorAmount });
          await this.bumpDaily(ts, t.asset, {
            creatorFees: coinValue(creatorAmount, t.price),
            protocolFees: coinValue(treasuryAmount, t.price),
          });
        } else {
          // ETH reaching the vault of an ERC-20 pair (Pons rescue paths): booked under ETH.
          await this.bumpDaily(ts, a, { creatorFees: creatorAmount, protocolFees: treasuryAmount });
        }
        return;
      }

      case "CreatorPaid": {
        const t = await this.mustToken(ev.coin, ev);
        if (lc(ev.args.asset) !== t.asset) return;
        this.tokens.put(t.address, { ...t, creatorFeesClaimed: t.creatorFeesClaimed + ev.args.amount });
        return;
      }

      case "CreatorTransferred": {
        const t = await this.mustToken(ev.coin, ev);
        this.tokens.put(t.address, { ...t, creator: lc(ev.args.to) });
        return;
      }

      /* ---------------- coin */

      case "Transfer": {
        const { value } = ev.args;
        if (value === 0n) return;
        const tokenAddr = ev.coin ?? lc(ev.address);
        const t = await this.tokens.get(tokenAddr);
        const from = lc(ev.args.from);
        const to = lc(ev.args.to);
        let delta = 0;
        const move = async (acct: Hex, change: bigint) => {
          const key = holderKey(tokenAddr, acct);
          const prev = (await this.holders.get(key))?.balance ?? 0n;
          const next = prev + change;
          this.holders.put(key, { token: tokenAddr, account: acct, balance: next });
          if (isCountedHolder(acct, t)) {
            if (prev <= 0n && next > 0n) delta++;
            else if (prev > 0n && next <= 0n) delta--;
          }
        };
        if (from !== ZERO_ADDRESS) await move(from, -value);
        if (to !== ZERO_ADDRESS) await move(to, value);
        if (t && delta !== 0) this.tokens.put(tokenAddr, { ...t, holdersCount: t.holdersCount + delta });
        return;
      }

      /* ---------------- graduated pool */

      /**
       * Uniswap v4 swaps in the coins' Pons pools. Amounts are the swapper's deltas before the hook's cut
       * (negative = paid by the swapper, so a buy has a positive coin delta). The Pons hook then takes its fee and the
       * creator tax from the unspecified currency (HookFeeCollected): out of the output on exact-in swaps, on top of
       * the input on exact-out swaps. Amounts recorded are what the trader actually paid / received; a fee taken in
       * coins is valued at the trade's own price. Swaps by the hook itself (fee conversion) only move the price.
       * trader = transaction.from (routers swap on users' behalf).
       */
      case "Swap": {
        const p = await this.pools.get(lc(ev.args.id));
        if (!p) return;
        const t = await this.tokens.get(p.token);
        if (!t) return;
        const { amount0, amount1, sqrtPriceX96 } = ev.args;
        const price = sqrtPriceX96 > 0n ? priceX18FromSqrt(sqrtPriceX96, t.coinIs0) : t.price;

        if (lc(ev.args.sender) === MEME_HOOK) {
          this.tokens.put(t.address, { ...t, price, mcap: mcapOf(price, t.supply) });
          await this.upsertCandles(t.address, ev.ts, t.price, price, 0n, 0);
          return;
        }

        const coinDelta = t.coinIs0 ? amount0 : amount1;
        const assetDelta = t.coinIs0 ? amount1 : amount0;
        const grossAsset = abs(assetDelta);
        const grossCoin = abs(coinDelta);
        if (grossAsset === 0n && grossCoin === 0n) return;
        if (!ev.txFrom) throw new Error(`Swap without transaction sender in tx ${ev.txHash}`);
        const isBuy = coinDelta > 0n;

        let assetAmount = grossAsset;
        let tokenAmount = grossCoin;
        let feeAsset = 0n;
        const hf = ev.hookFee;
        const cut = hf ? hf.fee + hf.tax : 0n;
        if (hf && cut > 0n) {
          if (hf.currency === t.asset) {
            feeAsset = cut;
            assetAmount = isBuy ? grossAsset + cut : grossAsset > cut ? grossAsset - cut : 0n;
          } else {
            feeAsset = grossCoin > 0n ? (cut * grossAsset) / grossCoin : 0n;
            tokenAmount = isBuy ? (grossCoin > cut ? grossCoin - cut : 0n) : grossCoin + cut;
          }
        }

        await this.recordTrade(t, ev, {
          trader: ev.txFrom,
          side: isBuy ? "buy" : "sell",
          venue: "pool",
          assetAmount,
          tokenAmount,
          feeAsset,
          price,
        });
        return;
      }

      default:
        return;
    }
  }

  private curveState(t: TokenRow) {
    return {
      quoteReserve: t.quoteReserve,
      tokenReserve: t.tokenReserve,
      reserved: t.reservedTokens,
      feeBps: BigInt(t.feeBps),
      taxBps: BigInt(t.taxBps),
    };
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


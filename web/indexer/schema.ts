import { bigint, boolean, customType, integer, pgSchema, primaryKey, text } from "drizzle-orm/pg-core";
import type { CoinPhase, Interval } from "@twain/shared";

/**
 * Built-in indexer tables, in their own Postgres schema next to the forum tables (same database).
 * Amounts are in the smallest unit of their currency (numeric(78)): coin amounts with 18 decimals, asset amounts with
 * the asset's decimals. Prices are `priceX18` (asset smallest units per whole coin × 1e18, see @twain/shared pons.ts).
 * Timestamps unix seconds, addresses lowercase. Rolling windows (24h / 7d volume, change24h) are computed at query
 * time over `trade`; USD values are computed at query time from each asset's current price.
 *
 * Bump SCHEMA_VERSION whenever a table or an event handler changes: the schema is then dropped and rebuilt from
 * START_BLOCK on the next sync (cheap — only twain's own contracts, its coins and their pools are fetched, plus the
 * Pons factory's pair-token history once).
 */
export const SCHEMA_VERSION = 3;
export const SCHEMA = "twain_ix";

const ix = pgSchema(SCHEMA);

/** uint256 as numeric(78,0) ↔ bigint. Drivers return numeric as a decimal string. */
const wei = customType<{ data: bigint; driverData: string }>({
  dataType: () => "numeric(78,0)",
  fromDriver: (v) => BigInt(v),
  toDriver: (v) => v.toString(),
});

const int8 = (name: string) => bigint(name, { mode: "number" });

export const syncState = ix.table("sync_state", {
  id: text("id").primaryKey(),
  launcher: text("launcher").notNull(),
  version: integer("version").notNull(),
  startBlock: int8("start_block").notNull(),
  /** Last block whose logs are fully applied. */
  cursor: int8("cursor").notNull(),
  /** Pons pair-token history (approvals, economics) is applied up to this block; −1 = not loaded yet. */
  assetsCursor: int8("assets_cursor").notNull(),
  /** Chain head (minus the safety lag) seen by the last sync. */
  head: int8("head").notNull(),
  /** ms epoch; a sync holds the lease until then (0 = free). */
  leaseUntil: int8("lease_until").notNull(),
  /** ms epoch of the last sync attempt (throttle). */
  lastSyncAt: int8("last_sync_at").notNull(),
  /** ms epoch of the last cursor advance. */
  syncedAt: int8("synced_at").notNull(),
  lastError: text("last_error"),
});

/**
 * Pair assets: ETH (Pons launch config 0) and every ERC-20 the Pons factory ever gave economics to
 * (PairTokenEconomicsUpdated / PairTokenApprovalUpdated). ERC-20 details are read once when first seen.
 */
export const asset = ix.table("asset", {
  address: text("address").$type<`0x${string}`>().primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  decimals: integer("decimals").notNull(),
  /** Pons currently accepts it for new launches. */
  enabled: boolean("enabled").notNull(),
  phantomQuote: wei("phantom_quote").notNull(),
  graduationThreshold: wei("graduation_threshold").notNull(),
  listedBlock: int8("listed_block").notNull(),
  /** twain coins launched against it. */
  coins: integer("coins").notNull(),
});

export const token = ix.table("token", {
  address: text("address").$type<`0x${string}`>().primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  /** Current creator (the vault's creator; changes on CreatorTransferred). */
  creator: text("creator").$type<`0x${string}`>().notNull(),
  createdAt: int8("created_at").notNull(),
  createdBlock: int8("created_block").notNull(),
  createdTx: text("created_tx").$type<`0x${string}`>().notNull(),
  asset: text("asset").$type<`0x${string}`>().notNull(),
  curve: text("curve").$type<`0x${string}`>().notNull(),
  vault: text("vault").$type<`0x${string}`>().notNull(),
  /** The graduated v4 pool (deterministic from the launch; trades there once phase = pool). */
  poolId: text("pool_id").$type<`0x${string}`>().notNull(),
  coinIs0: boolean("coin_is0").notNull(),
  phase: text("phase").$type<CoinPhase>().notNull(),
  /** Curve constants, read once at launch. */
  phantomQuote: wei("phantom_quote").notNull(),
  graduationThreshold: wei("graduation_threshold").notNull(),
  reservedTokens: wei("reserved_tokens").notNull(),
  supply: wei("supply").notNull(),
  feeBps: integer("fee_bps").notNull(),
  taxBps: integer("tax_bps").notNull(),
  /** Curve reserves replayed from CurveBuy / CurveSell (last values kept after graduation). */
  quoteReserve: wei("quote_reserve").notNull(),
  tokenReserve: wei("token_reserve").notNull(),
  progressBps: integer("progress_bps").notNull(),
  startPrice: wei("start_price").notNull(),
  /** Onchain token info (Pons launcher token): logo URI as stored, then the parsed display fields. */
  logo: text("logo").notNull(),
  description: text("description"),
  image: text("image"),
  x: text("x"),
  telegram: text("telegram"),
  website: text("website"),
  /** Spot price (priceX18) and market cap (asset smallest units) after the last trade. */
  price: wei("price").notNull(),
  mcap: wei("mcap").notNull(),
  volumeAll: wei("volume_all").notNull(),
  tradesCount: integer("trades_count").notNull(),
  /** Holders with balance > 0, excluding infrastructure, the PoolManager, the curve and the vault. */
  holdersCount: integer("holders_count").notNull(),
  lastBuyAt: int8("last_buy_at"),
  lastTradeAt: int8("last_trade_at"),
  /** Vault splits: creator's share in the pair asset (FeesSplit) and paid out (CreatorPaid); creator's share in coins. */
  creatorFeesAccrued: wei("creator_fees_accrued").notNull(),
  creatorFeesClaimed: wei("creator_fees_claimed").notNull(),
  coinFeesCreator: wei("coin_fees_creator").notNull(),
  /** Pons creator fee recipient (the vault unless the Pons owner moved it) and a pending owner override. */
  feeRecipient: text("fee_recipient").$type<`0x${string}`>().notNull(),
  pendingRecipient: text("pending_recipient").$type<`0x${string}`>(),
  pendingEffectiveAt: int8("pending_effective_at"),
  pendingExpiresAt: int8("pending_expires_at"),
});

export const trade = ix.table("trade", {
  /** `${txHash}-${logIndex}` */
  id: text("id").primaryKey(),
  token: text("token").$type<`0x${string}`>().notNull(),
  asset: text("asset").$type<`0x${string}`>().notNull(),
  trader: text("trader").$type<`0x${string}`>().notNull(),
  side: text("side").$type<"buy" | "sell">().notNull(),
  venue: text("venue").$type<"curve" | "pool">().notNull(),
  /** Buy: asset paid incl. fees. Sell: asset received. */
  assetAmount: wei("asset_amount").notNull(),
  tokenAmount: wei("token_amount").notNull(),
  /** Every fee of the trade valued in the asset (Pons fee + creator tax + snipe tax). */
  feeAsset: wei("fee_asset").notNull(),
  /** Spot price after the trade (priceX18). */
  price: wei("price").notNull(),
  txHash: text("tx_hash").$type<`0x${string}`>().notNull(),
  blockNumber: int8("block_number").notNull(),
  logIndex: integer("log_index").notNull(),
  timestamp: int8("timestamp").notNull(),
});

export const candle = ix.table(
  "candle",
  {
    token: text("token").$type<`0x${string}`>().notNull(),
    interval: text("interval").$type<Interval>().notNull(),
    /** Bucket start, unix seconds (UTC-aligned). */
    time: int8("time").notNull(),
    open: wei("open").notNull(),
    high: wei("high").notNull(),
    low: wei("low").notNull(),
    close: wei("close").notNull(),
    volume: wei("volume").notNull(),
    trades: integer("trades").notNull(),
  },
  (t) => [primaryKey({ columns: [t.token, t.interval, t.time] })],
);

export const holder = ix.table(
  "holder",
  {
    token: text("token").$type<`0x${string}`>().notNull(),
    account: text("account").$type<`0x${string}`>().notNull(),
    balance: wei("balance").notNull(),
  },
  (t) => [primaryKey({ columns: [t.token, t.account] })],
);

/** One row per UTC day and asset with any activity. `day` = YYYY-MM-DD. */
export const dailyStats = ix.table(
  "daily_stats",
  {
    day: text("day").notNull(),
    asset: text("asset").$type<`0x${string}`>().notNull(),
    dayStart: int8("day_start").notNull(),
    volume: wei("volume").notNull(),
    /** Every trade fee (Pons fee + creator tax + snipe tax). */
    fees: wei("fees").notNull(),
    trades: integer("trades").notNull(),
    launches: integer("launches").notNull(),
    /** Vault splits (FeesSplit): creators' and the twain treasury's shares; coin-side splits valued at the coin price. */
    creatorFees: wei("creator_fees").notNull(),
    protocolFees: wei("protocol_fees").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.asset] })],
);

export const account = ix.table("account", {
  address: text("address").$type<`0x${string}`>().primaryKey(),
  /** Coins launched by this address (original creator). */
  createdCount: integer("created_count").notNull(),
  tradesCount: integer("trades_count").notNull(),
});

/** Every coin's graduated pool: v4 poolId → coin (for Swap logs). */
export const pool = ix.table("pool", {
  poolId: text("pool_id").$type<`0x${string}`>().primaryKey(),
  token: text("token").$type<`0x${string}`>().notNull(),
});

export type AssetRow = typeof asset.$inferSelect;
export type TokenRow = typeof token.$inferSelect;
export type TradeRow = typeof trade.$inferSelect;
export type CandleRow = typeof candle.$inferSelect;
export type HolderRow = typeof holder.$inferSelect;
export type DailyRow = typeof dailyStats.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type PoolRow = typeof pool.$inferSelect;

const S = SCHEMA;
const W = "numeric(78,0) NOT NULL";

/** Idempotent DDL, one statement per entry. Must match the tables above. */
export const DDL = [
  `CREATE SCHEMA IF NOT EXISTS ${S}`,
  `CREATE TABLE IF NOT EXISTS ${S}.sync_state (
    id text PRIMARY KEY,
    launcher text NOT NULL,
    version integer NOT NULL,
    start_block bigint NOT NULL,
    cursor bigint NOT NULL,
    assets_cursor bigint NOT NULL DEFAULT -1,
    head bigint NOT NULL DEFAULT 0,
    lease_until bigint NOT NULL DEFAULT 0,
    last_sync_at bigint NOT NULL DEFAULT 0,
    synced_at bigint NOT NULL DEFAULT 0,
    last_error text
  )`,
  `CREATE TABLE IF NOT EXISTS ${S}.asset (
    address text PRIMARY KEY,
    symbol text NOT NULL,
    name text NOT NULL,
    decimals integer NOT NULL,
    enabled boolean NOT NULL,
    phantom_quote ${W},
    graduation_threshold ${W},
    listed_block bigint NOT NULL,
    coins integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${S}.token (
    address text PRIMARY KEY,
    name text NOT NULL,
    symbol text NOT NULL,
    creator text NOT NULL,
    created_at bigint NOT NULL,
    created_block bigint NOT NULL,
    created_tx text NOT NULL,
    asset text NOT NULL,
    curve text NOT NULL,
    vault text NOT NULL,
    pool_id text NOT NULL,
    coin_is0 boolean NOT NULL,
    phase text NOT NULL,
    phantom_quote ${W},
    graduation_threshold ${W},
    reserved_tokens ${W},
    supply ${W},
    fee_bps integer NOT NULL,
    tax_bps integer NOT NULL,
    quote_reserve ${W},
    token_reserve ${W},
    progress_bps integer NOT NULL,
    start_price ${W},
    logo text NOT NULL,
    description text,
    image text,
    x text,
    telegram text,
    website text,
    price ${W},
    mcap ${W},
    volume_all ${W},
    trades_count integer NOT NULL,
    holders_count integer NOT NULL,
    last_buy_at bigint,
    last_trade_at bigint,
    creator_fees_accrued ${W},
    creator_fees_claimed ${W},
    coin_fees_creator ${W},
    fee_recipient text NOT NULL,
    pending_recipient text,
    pending_effective_at bigint,
    pending_expires_at bigint
  )`,
  `CREATE INDEX IF NOT EXISTS token_creator_idx ON ${S}.token (creator)`,
  `CREATE INDEX IF NOT EXISTS token_created_at_idx ON ${S}.token (created_at)`,
  `CREATE INDEX IF NOT EXISTS token_last_buy_idx ON ${S}.token (last_buy_at)`,
  `CREATE INDEX IF NOT EXISTS token_asset_idx ON ${S}.token (asset)`,
  `CREATE TABLE IF NOT EXISTS ${S}.trade (
    id text PRIMARY KEY,
    token text NOT NULL,
    asset text NOT NULL,
    trader text NOT NULL,
    side text NOT NULL,
    venue text NOT NULL,
    asset_amount ${W},
    token_amount ${W},
    fee_asset ${W},
    price ${W},
    tx_hash text NOT NULL,
    block_number bigint NOT NULL,
    log_index integer NOT NULL,
    timestamp bigint NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS trade_token_time_idx ON ${S}.trade (token, timestamp)`,
  `CREATE INDEX IF NOT EXISTS trade_token_order_idx ON ${S}.trade (token, block_number, log_index)`,
  `CREATE INDEX IF NOT EXISTS trade_trader_order_idx ON ${S}.trade (trader, block_number, log_index)`,
  `CREATE INDEX IF NOT EXISTS trade_time_idx ON ${S}.trade (timestamp)`,
  `CREATE TABLE IF NOT EXISTS ${S}.candle (
    token text NOT NULL,
    interval text NOT NULL,
    time bigint NOT NULL,
    open ${W},
    high ${W},
    low ${W},
    close ${W},
    volume ${W},
    trades integer NOT NULL,
    PRIMARY KEY (token, interval, time)
  )`,
  `CREATE TABLE IF NOT EXISTS ${S}.holder (
    token text NOT NULL,
    account text NOT NULL,
    balance ${W},
    PRIMARY KEY (token, account)
  )`,
  `CREATE INDEX IF NOT EXISTS holder_token_balance_idx ON ${S}.holder (token, balance)`,
  `CREATE INDEX IF NOT EXISTS holder_account_idx ON ${S}.holder (account)`,
  `CREATE TABLE IF NOT EXISTS ${S}.daily_stats (
    day text NOT NULL,
    asset text NOT NULL,
    day_start bigint NOT NULL,
    volume ${W},
    fees ${W},
    trades integer NOT NULL,
    launches integer NOT NULL,
    creator_fees ${W},
    protocol_fees ${W},
    PRIMARY KEY (day, asset)
  )`,
  `CREATE INDEX IF NOT EXISTS daily_stats_day_start_idx ON ${S}.daily_stats (day_start)`,
  `CREATE TABLE IF NOT EXISTS ${S}.account (
    address text PRIMARY KEY,
    created_count integer NOT NULL,
    trades_count integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${S}.pool (
    pool_id text PRIMARY KEY,
    token text NOT NULL
  )`,
];

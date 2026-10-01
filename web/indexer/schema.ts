import { bigint, boolean, customType, integer, pgSchema, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * Built-in indexer tables, in their own Postgres schema next to the forum tables (same database).
 * Amounts are in the smallest unit of their currency (numeric(78)): coin amounts with 18 decimals, asset amounts with
 * the asset's decimals. Prices are `priceX18` (asset smallest units per whole coin × 1e18, see @lancio/shared pool.ts).
 * Timestamps unix seconds, addresses lowercase. Rolling windows (24h / 7d volume, change24h) are computed at query
 * time over `trade`; USD values are computed at query time from each asset's current price.
 *
 * Bump SCHEMA_VERSION whenever a table or an event handler changes: the schema is then dropped and rebuilt from
 * START_BLOCK on the next sync (cheap — only the launchpad's own logs, its coins and their pools are fetched).
 */
export const SCHEMA_VERSION = 1;
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
  launchpad: text("launchpad").notNull(),
  version: integer("version").notNull(),
  startBlock: int8("start_block").notNull(),
  /** Last block whose logs are fully applied. */
  cursor: int8("cursor").notNull(),
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

/** Assets the owner listed (AssetSet / AssetDisabled). ERC-20 details are read once when first listed. */
export const asset = ix.table("asset", {
  address: text("address").$type<`0x${string}`>().primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  decimals: integer("decimals").notNull(),
  enabled: boolean("enabled").notNull(),
  startMcap: wei("start_mcap").notNull(),
  startTick: integer("start_tick").notNull(),
  listedAt: int8("listed_at").notNull(),
  coins: integer("coins").notNull(),
});

export const token = ix.table("token", {
  address: text("address").$type<`0x${string}`>().primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  /** Current creator (changes on CreatorTransferred). */
  creator: text("creator").$type<`0x${string}`>().notNull(),
  createdAt: int8("created_at").notNull(),
  createdBlock: int8("created_block").notNull(),
  createdTx: text("created_tx").$type<`0x${string}`>().notNull(),
  asset: text("asset").$type<`0x${string}`>().notNull(),
  poolId: text("pool_id").$type<`0x${string}`>().notNull(),
  coinIs0: boolean("coin_is0").notNull(),
  startTick: integer("start_tick").notNull(),
  startPrice: wei("start_price").notNull(),
  metadataUri: text("metadata_uri").notNull(),
  description: text("description"),
  image: text("image"),
  x: text("x"),
  telegram: text("telegram"),
  website: text("website"),
  /** Metadata is fetched after the token row is written; failed fetches are retried a few times. */
  metaPending: boolean("meta_pending").notNull(),
  metaAttempts: integer("meta_attempts").notNull(),
  /** Locked position (LiquidityLocked). */
  liquidity: wei("liquidity").notNull(),
  /** Spot price (priceX18) and market cap (asset smallest units) after the last swap. */
  price: wei("price").notNull(),
  mcap: wei("mcap").notNull(),
  volumeAll: wei("volume_all").notNull(),
  tradesCount: integer("trades_count").notNull(),
  /** Holders with balance > 0, excluding zero address, the locker and the PoolManager. */
  holdersCount: integer("holders_count").notNull(),
  lastBuyAt: int8("last_buy_at"),
  lastTradeAt: int8("last_trade_at"),
  /** Asset side of the pool fees credited to the creator (FeesDeposited) and claimed (CreatorFeesClaimed). */
  creatorFeesAccrued: wei("creator_fees_accrued").notNull(),
  creatorFeesClaimed: wei("creator_fees_claimed").notNull(),
  /** Coin side of the pool fees paid out by the locker (FeesCollected). */
  coinFeesCreator: wei("coin_fees_creator").notNull(),
  coinFeesProtocol: wei("coin_fees_protocol").notNull(),
});

export const trade = ix.table("trade", {
  /** `${txHash}-${logIndex}` */
  id: text("id").primaryKey(),
  token: text("token").$type<`0x${string}`>().notNull(),
  asset: text("asset").$type<`0x${string}`>().notNull(),
  trader: text("trader").$type<`0x${string}`>().notNull(),
  side: text("side").$type<"buy" | "sell">().notNull(),
  /** Buy: asset paid incl. fee. Sell: asset received. */
  assetAmount: wei("asset_amount").notNull(),
  tokenAmount: wei("token_amount").notNull(),
  /** The 1% fee valued in the asset (sells pay it in coins). */
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
    interval: text("interval").$type<"1m" | "5m" | "15m" | "1h" | "4h" | "1d">().notNull(),
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
    fees: wei("fees").notNull(),
    trades: integer("trades").notNull(),
    launches: integer("launches").notNull(),
    protocolClaimed: wei("protocol_claimed").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.asset] })],
);

export const account = ix.table("account", {
  address: text("address").$type<`0x${string}`>().primaryKey(),
  /** Coins launched by this address (original creator). */
  createdCount: integer("created_count").notNull(),
  tradesCount: integer("trades_count").notNull(),
});

/** Every coin's pool: v4 poolId → coin (for Swap logs). */
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
    launchpad text NOT NULL,
    version integer NOT NULL,
    start_block bigint NOT NULL,
    cursor bigint NOT NULL,
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
    start_mcap ${W},
    start_tick integer NOT NULL,
    listed_at bigint NOT NULL,
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
    pool_id text NOT NULL,
    coin_is0 boolean NOT NULL,
    start_tick integer NOT NULL,
    start_price ${W},
    metadata_uri text NOT NULL,
    description text,
    image text,
    x text,
    telegram text,
    website text,
    meta_pending boolean NOT NULL,
    meta_attempts integer NOT NULL,
    liquidity ${W},
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
    coin_fees_protocol ${W}
  )`,
  `CREATE INDEX IF NOT EXISTS token_creator_idx ON ${S}.token (creator)`,
  `CREATE INDEX IF NOT EXISTS token_created_at_idx ON ${S}.token (created_at)`,
  `CREATE INDEX IF NOT EXISTS token_last_buy_idx ON ${S}.token (last_buy_at)`,
  `CREATE INDEX IF NOT EXISTS token_asset_idx ON ${S}.token (asset)`,
  `CREATE INDEX IF NOT EXISTS token_meta_pending_idx ON ${S}.token (meta_pending) WHERE meta_pending`,
  `CREATE TABLE IF NOT EXISTS ${S}.trade (
    id text PRIMARY KEY,
    token text NOT NULL,
    asset text NOT NULL,
    trader text NOT NULL,
    side text NOT NULL,
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
    protocol_claimed ${W},
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

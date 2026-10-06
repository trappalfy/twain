/**
 * REST contract between the built-in indexer (web/indexer, routes under /api) and the web app.
 * Amounts are decimal strings in the smallest unit of their currency (coin: 18 decimals; asset: its own decimals).
 * Prices: `priceX18` = the asset's smallest units per 1 whole coin × 1e18 (see packages/shared/src/pool.ts).
 * USD figures are numbers computed at read time from the asset's current USD price; null when it is unknown.
 * Timestamps are unix seconds. Addresses lowercase.
 */
export type Hex = `0x${string}`;
export type SortKey = "recentBuys" | "newest" | "oldest" | "marketCap" | "volume";
export type WindowKey = "all" | "24h" | "7d";
export type Interval = "1s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** native = ETH, stock = Robinhood stock token, token = any other ERC-20 Pons V2 accepts as a pair. */
export type AssetKind = "native" | "stock" | "token";

export type AssetInfo = {
  address: Hex; // 0x000…000 for native ETH
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  kind: AssetKind;
  usd: number | null; // USD per whole unit
};

/** GET /api/assets — ETH plus every ERC-20 Pons V2 approves as a pair asset, with its curve terms (smallest units). */
export type ListedAsset = AssetInfo & {
  enabled: boolean; // currently approved by Pons
  phantomQuote: string; // virtual quote reserve a new curve starts with
  graduationThreshold: string; // real quote the curve raises before it graduates into the v4 pool
  startMcap: string; // market cap at launch (= phantomQuote: the whole supply at the start price)
  graduationMcap: string; // market cap when the curve completes
  coins: number; // twain coins launched against it
};
export type AssetsResponse = ListedAsset[];

export type TokenMeta = {
  description: string | null;
  image: string | null; // resolved https URL (gateway), never raw ipfs://
  x: string | null;
  telegram: string | null;
  website: string | null;
};

/** curve = trading on the Pons curve; graduating = curve completed, v4 pool not seeded yet; pool = Uniswap v4 pool. */
export type CoinPhase = "curve" | "graduating" | "pool" | "rescued";

export type TokenSummary = {
  address: Hex;
  name: string;
  symbol: string;
  creator: Hex; // current creator (the vault's creator)
  createdAt: number;
  createdBlock: number;
  metadataUri: string;
  meta: TokenMeta;
  asset: AssetInfo;
  curve: Hex; // Pons curve (trades before graduation)
  vault: Hex; // TwainFeeVault (Pons creator fee recipient)
  phase: CoinPhase;
  progressBps: number; // share of the curve's sellable allocation bought (10,000 = graduated)
  poolId: Hex; // graduated Uniswap v4 pool (Pons meme hook, fee 0, spacing 200); trades there once phase = pool
  coinIsCurrency0: boolean;
  priceX18: string;
  mcapAsset: string;
  priceUsd: number | null;
  mcapUsd: number | null;
  volumeAsset24h: string; // rolling 24h, asset side of every swap
  volumeAsset7d: string;
  volumeAssetAll: string;
  volumeUsd24h: number | null;
  change24hPct: number | null; // price change vs 24h ago (rolling); null if no data
  tradesCount: number;
  holdersCount: number;
  lastBuyAt: number | null;
  lastTradeAt: number | null;
};

export type TokenDetail = TokenSummary & {
  startPriceX18: string;
  feeBps: number; // Pons fee per trade (curve fee, then the hook's fee in the pool)
  taxBps: number; // creator tax per trade (twain coins: CREATOR_TAX_BPS)
  graduationThreshold: string; // quote the curve raises before graduating
  quoteReserve: string | null; // curve reserves (phase = curve), null after graduation
  tokenReserve: string | null;
  creatorFeesAccrued: string; // creator's share split by the vault so far, pair asset
  creatorFeesClaimed: string; // paid out to the creator, pair asset
  coinFeesToCreator: string; // creator's share in the coin itself (rare: Pons rescue/vest paths)
  /** Pons owner proposed to move this coin's fee recipient away from its vault (3-day timelock). */
  feeRecipientChange: { proposedRecipient: Hex; effectiveAt: number; expiresAt: number } | null;
};

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/** GET /api/tokens?asset=&sort=SortKey&window=WindowKey&q=&page=1&pageSize=25 */
export type TokensQuery = {
  asset?: Hex | "all";
  sort?: SortKey;
  window?: WindowKey;
  q?: string;
  page?: number;
  pageSize?: number;
};
export type TokensResponse = Page<TokenSummary>;

/** GET /api/tokens/:address */
export type TokenResponse = TokenDetail;

/** GET /api/tokens/:address/candles?interval=1m&from=&to=  (ascending by time) */
export type Candle = {
  time: number; // bucket start
  open: string; // priceX18
  high: string;
  low: string;
  close: string;
  volumeAsset: string;
};
export type CandlesResponse = Candle[];

/** GET /api/tokens/:address/trades?limit=50&before=<cursor>  (newest first) */
export type Trade = {
  id: string; // `${txHash}-${logIndex}`
  txHash: Hex;
  blockNumber: number;
  timestamp: number;
  token: Hex;
  symbol?: string;
  asset: AssetInfo;
  trader: Hex;
  side: "buy" | "sell";
  assetAmount: string; // buy: asset paid incl. fees; sell: asset received
  tokenAmount: string;
  feeAsset: string; // every fee of the trade (Pons fee + creator tax + snipe tax), valued in the asset
  venue: "curve" | "pool";
  priceX18: string; // spot after the trade
};
export type TradesResponse = { items: Trade[]; nextCursor: string | null };

/** GET /api/tokens/:address/holders?limit=20 */
export type Holder = {
  account: Hex;
  balance: string;
  shareBps: number; // of TOTAL_SUPPLY
  label: "curve" | "pool" | "creator" | null;
};
export type HoldersResponse = Holder[];

/** Per-asset totals behind the USD figures. */
export type AssetTotals = { asset: AssetInfo; volume: string; fees: string; launches: number };

/** GET /api/stats?window=24h|all  — 24h = last completed UTC day */
export type ProtocolStats = {
  window: "24h" | "all";
  updatedAt: number;
  latestCompleteDay: string | null; // YYYY-MM-DD (UTC)
  volumeUsd: number | null;
  volumeChangePct: number | null; // vs prior day (24h only)
  launches: number;
  launchesChangePct: number | null;
  uniqueCreators: number; // lifetime
  feesUsd: { creators: number | null; protocol: number | null };
  byAsset: AssetTotals[];
};

/** GET /api/stats/daily?days=14  (ascending, completed UTC days only; USD at current asset prices) */
export type DailyPoint = { day: string; volumeUsd: number | null; launches: number };
export type DailyResponse = DailyPoint[];

/** GET /api/accounts/:address */
export type CreatorFees = { asset: AssetInfo; accrued: string; claimed: string };
export type AccountResponse = {
  address: Hex;
  created: TokenSummary[];
  creatorFees: CreatorFees[];
  tradesCount: number;
};

/** GET /api/accounts/:address/holdings */
export type Holding = { token: TokenSummary; balance: string };
export type HoldingsResponse = Holding[];

/** GET /api/accounts/:address/trades?limit=50&before= */
export type AccountTradesResponse = TradesResponse;

/** GET /api/search?q=  (name/symbol prefix or address; max 10) */
export type SearchResponse = TokenSummary[];

/** GET /api/top?limit=10  (by USD market cap) */
export type TopResponse = TokenSummary[];

/** GET /api/eth-usd  (cached ~60s) */
export type EthUsdResponse = { usd: number | null; updatedAt: number };

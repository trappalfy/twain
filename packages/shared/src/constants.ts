/** Protocol constants — must mirror contracts/src/Constants.sol exactly. */
export const DECIMALS = 18;
export const WAD = 10n ** 18n;

/** Every coin: 1,000,000,000 units with 18 decimals, all of it in its pool from the first block. */
export const TOTAL_SUPPLY = 1_000_000_000n * WAD;
export const TOTAL_SUPPLY_WHOLE = 1_000_000_000n;

export const BPS = 10_000n;

/** Uniswap v4 pool parameters of every coin: static 1% fee, no hook. */
export const POOL_LP_FEE = 10_000; // pips
export const POOL_FEE_PIPS = 1_000_000n;
export const POOL_TICK_SPACING = 200;
export const MIN_USABLE_TICK = -887_200;
export const MAX_USABLE_TICK = 887_200;
export const POOL_HOOKS = "0x0000000000000000000000000000000000000000";

/** Pool fees: 60% to the coin's creator, 40% to the protocol. */
export const CREATOR_FEE_SHARE = 60n;
export const PROTOCOL_FEE_SHARE = 40n;

/** Native ETH as an asset (address zero, sorts first in every pool). */
export const NATIVE_ASSET = "0x0000000000000000000000000000000000000000";

/** Human-readable parameter table (UI, docs, OG). */
export const PARAMS = {
  supply: "1,000,000,000",
  poolFeePct: "1%",
  creatorFeePct: "0.6%",
  protocolFeePct: "0.4%",
  feeSplit: "60/40",
  launchFeeEth: "0",
} as const;

export const TOKEN_LIMITS = {
  nameMax: 32,
  symbolMax: 10,
  descriptionMax: 280,
  imageMaxBytes: 4 * 1024 * 1024,
  imageTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
} as const;

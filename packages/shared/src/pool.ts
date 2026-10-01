/**
 * Pool math for coins launched by contracts/src/Launchpad.sol. Every coin trades in one Uniswap v4 pool against
 * its asset; the whole supply sits in a single-sided position that starts at the asset's start tick.
 *
 * Price convention used across the API and UI: `priceX18` = the asset's smallest units per 1 whole coin, × 1e18
 * (so 6-decimal assets keep precision). Market cap in the asset's smallest units = priceX18 / 1e9.
 */
import { CREATOR_FEE_SHARE, POOL_FEE_PIPS, POOL_LP_FEE, TOTAL_SUPPLY, TOTAL_SUPPLY_WHOLE, WAD } from "./constants";

const Q32 = 1n << 32n;
const Q192 = 1n << 192n;
const MAX_UINT256 = (1n << 256n) - 1n;
const E36 = WAD * WAD;

/** TickMath.getSqrtPriceAtTick (Uniswap v4), bit for bit. */
export function sqrtPriceAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > 887_272n) throw new Error(`tick out of range: ${tick}`);
  let r = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) if ((absTick & bit) !== 0n) r = (r * mul) >> 128n;
  if (tick > 0) r = MAX_UINT256 / r;
  return (r >> 32n) + (r % Q32 === 0n ? 0n : 1n);
}

/** Price (asset units per whole coin × 1e18) from a pool's sqrtPriceX96; `coinIs0` = the coin is currency0. */
export function priceX18FromSqrt(sqrtPriceX96: bigint, coinIs0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  // pool price = currency1 per currency0 = sq / 2^192
  return coinIs0 ? (sq * E36) / Q192 : (E36 * Q192) / sq;
}

/** Start price of a coin: `startTick` is "asset per coin", the same for both currency orders. */
export const startPriceX18 = (startTick: number) => priceX18FromSqrt(sqrtPriceAtTick(startTick), true);

/** sqrtPriceX96 a coin's pool opens at. */
export const openingSqrtPrice = (startTick: number, coinIs0: boolean) => sqrtPriceAtTick(coinIs0 ? startTick : -startTick);

/** Market cap in the asset's smallest units. */
export const mcapFromPriceX18 = (priceX18: bigint) => (priceX18 * TOTAL_SUPPLY_WHOLE) / WAD;

/** A coin is currency0 of its pool when its address sorts before the asset's (never against native ETH). */
export const coinIsCurrency0 = (coin: string, asset: string) => BigInt(coin) < BigInt(asset);

export type PoolKey = { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` };

/**
 * Coins out of a first buy at the start price: x·y = k with virtual reserves (start mcap, supply), after the 1%
 * fee. The contract's single-sided position reproduces this to ~1e-12; use it for previews, and the simulated
 * `create` call for the exact figure.
 */
export function quoteFromStart(startTick: number, assetIn: bigint): bigint {
  const vAsset = mcapFromPriceX18(startPriceX18(startTick));
  const net = assetIn - (assetIn * BigInt(POOL_LP_FEE) + POOL_FEE_PIPS - 1n) / POOL_FEE_PIPS;
  if (vAsset === 0n || net <= 0n) return 0n;
  return TOTAL_SUPPLY - (vAsset * TOTAL_SUPPLY) / (vAsset + net);
}

/** Creator / protocol parts of a fee amount (60/40). */
export function splitFee(fee: bigint) {
  const creatorFee = (fee * CREATOR_FEE_SHARE) / 100n;
  return { creatorFee, protocolFee: fee - creatorFee };
}

export const applySlippage = (amount: bigint, slippageBps: number) => (amount * (10_000n - BigInt(slippageBps))) / 10_000n;

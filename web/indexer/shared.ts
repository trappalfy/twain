/** Helpers shared by the sync (apply.ts) and the API (api.ts). */
import { PONS_V2, UNISWAP_V4, type Interval } from "@twain/shared";
import { config } from "@/lib/config";

export type Hex = `0x${string}`;

export const lc = (a: string) => a.toLowerCase() as Hex;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
export const LAUNCHER = lc(config.deployment.launcher);
export const POOL_MANAGER = lc(UNISWAP_V4.poolManager);
export const PONS_FACTORY = lc(PONS_V2.factory);
export const MEME_HOOK = lc(PONS_V2.memeHook);

/**
 * Pons V2 contracts that hold coins without owning them (read from the factory, 2026-10-02): the launch locker keeps
 * the graduated positions and the supply locked forever at graduation, the graduation executor and the factory hold
 * coins mid-graduation, the fee escrow and the buyback vault hold coin-side fees.
 */
const PONS_HOLDERS = [
  PONS_FACTORY,
  MEME_HOOK,
  lc(PONS_V2.feeEscrow),
  lc("0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952"), // PonsV2LaunchLocker
  lc("0xC7819B64A1dAECD7eC19856d026cb14EfBd89046"), // PonsV2GraduationExecutor
  lc("0x42df2a798f82289E177311362e8f5ccC45c1219c"), // PonsV2BuybackVault
];

/** Addresses that are never holders of any coin: zero, twain's launcher and Pons' own contracts. */
export const INFRA: readonly Hex[] = [ZERO_ADDRESS, LAUNCHER, ...PONS_HOLDERS];
const INFRA_SET = new Set<string>(INFRA);

type CoinAddrs = { curve: Hex; vault: Hex };

/**
 * Holders that count towards holdersCount: everyone except infrastructure, the PoolManager (the pool's coins), the
 * coin's own curve (unsold supply) and its fee vault.
 */
export const isCountedHolder = (a: Hex, coin: CoinAddrs | undefined) =>
  !INFRA_SET.has(a) && a !== POOL_MANAGER && (!coin || (a !== coin.curve && a !== coin.vault));

export const INTERVALS: ReadonlyArray<readonly [Interval, number]> = [
  ["1s", 1],
  ["1m", 60],
  ["5m", 300],
  ["15m", 900],
  ["1h", 3_600],
  ["4h", 14_400],
  ["1d", 86_400],
];

export const DAY = 86_400;
export const dayStartOf = (ts: number) => ts - (((ts % DAY) + DAY) % DAY);
export const dayKey = (dayStart: number) => new Date(dayStart * 1000).toISOString().slice(0, 10);

export const E36 = 10n ** 36n;

/** Market cap in the asset's smallest units: priceX18 × supply (18-decimal units) / 1e36. */
export const mcapOf = (priceX18: bigint, supply: bigint) => (priceX18 * supply) / E36;

/** Coin amount (18 decimals) valued in the asset's smallest units at priceX18. */
export const coinValue = (amount: bigint, priceX18: bigint) => (amount * priceX18) / E36;

export const chunk = <T,>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

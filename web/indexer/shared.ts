/** Helpers shared by the sync (apply.ts) and the API (api.ts). */
import { UNISWAP_V4, type Interval } from "@lancio/shared";
import { config } from "@/lib/config";

export type Hex = `0x${string}`;

export const lc = (a: string) => a.toLowerCase() as Hex;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
export const LAUNCHPAD = lc(config.deployment.launchpad);
export const LOCKER = lc(config.deployment.locker);
export const POOL_MANAGER = lc(UNISWAP_V4.poolManager);

/** Addresses excluded from holdersCount: the pool's coins sit in the PoolManager, rounding dust in the locker. */
export const isCountedHolder = (a: string) => {
  const x = a.toLowerCase();
  return x !== ZERO_ADDRESS && x !== LOCKER && x !== POOL_MANAGER && x !== LAUNCHPAD;
};

export const INTERVALS: ReadonlyArray<readonly [Interval, number]> = [
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

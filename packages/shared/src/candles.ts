import type { Interval } from "./api-types";

/** Length of each chart interval, in seconds. */
export const INTERVAL_SECONDS: Readonly<Record<Interval, number>> = {
  "1s": 1,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
};

type Candle = { time: number; open: string; high: string; low: string; close: string; volumeAsset: string };

/**
 * One bar per interval, as a trading chart expects. The indexer stores only buckets that had a trade, and the chart's
 * time axis places bars by index, so a coin trading every 3 minutes would show the same few bars side by side on 1s and
 * 1m. Buckets without a trade become flat bars at the previous close, from the launch bucket (at `startPrice`) or the
 * first candle, up to the bucket of `now`; only the latest `maxBars` are kept.
 */
export function fillCandles(
  candles: readonly Candle[],
  opts: { step: number; now: number; from?: number; startPrice?: string; maxBars: number },
): Candle[] {
  if (candles.length === 0) return [];
  const { step, maxBars } = opts;
  const bucket = (t: number) => t - (((t % step) + step) % step);
  const first = candles[0]!.time;
  const last = candles[candles.length - 1]!.time;
  const end = Math.max(bucket(opts.now), last);
  const launch = opts.from !== undefined && opts.startPrice !== undefined ? Math.min(bucket(opts.from), first) : first;
  const start = Math.max(launch, end - (maxBars - 1) * step);

  let i = 0;
  let prev = launch < first ? opts.startPrice! : candles[0]!.open;
  for (; i < candles.length && candles[i]!.time < start; i++) prev = candles[i]!.close;

  const out: Candle[] = [];
  for (let t = start; t <= end; t += step) {
    const c = candles[i];
    if (c && c.time === t) {
      out.push(c);
      prev = c.close;
      i++;
    } else {
      out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volumeAsset: "0" });
    }
  }
  return out;
}

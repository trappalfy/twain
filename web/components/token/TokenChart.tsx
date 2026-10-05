"use client";

import {
  COPY,
  INTERVAL_SECONDS,
  TOTAL_SUPPLY,
  WAD,
  fillCandles,
  formatTiny,
  formatUsd,
  priceX18ToNumber,
  sig,
  type Interval,
  type TokenDetail,
} from "@twain/shared";
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  type AutoscaleInfo,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, PillTabs, Skeleton } from "@/components/ui";
import { useCandles } from "@/lib/api";
import { cssVar } from "@/lib/theme";
import { cn } from "@/lib/utils";

type Metric = "price" | "mcap";
type Unit = "usd" | "asset";

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1s", label: "1s" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1D" },
];
const METRICS: { value: Metric; label: string }[] = [
  { value: "price", label: "Price" },
  { value: "mcap", label: "MCap" },
];

/** Whole tokens in the supply (1e9): MCap = price per token × supply. */
const SUPPLY = Number(TOTAL_SUPPLY / WAD);
/** Bars kept in view on load (older ones are a scroll away). */
const VISIBLE_BARS = 70;
/** Bars drawn per interval once empty buckets are filled (1s: the last ~83 minutes, 1m: ~3.5 days). */
const MAX_BARS = 5_000;
const HEIGHT = "h-[320px] md:h-[420px]";

/**
 * Keeps the price scale at least ±1% around the price. A stretch without trades is a flat line; the default autoscale
 * would shrink to it and label every gridline with the same rounded price.
 */
function minPriceRange(original: () => AutoscaleInfo | null): AutoscaleInfo | null {
  const info = original();
  if (!info?.priceRange) return info;
  const { minValue, maxValue } = info.priceRange;
  const mid = (minValue + maxValue) / 2;
  const half = Math.abs(mid) * 0.01;
  if (maxValue - minValue >= 2 * half) return info;
  return { ...info, priceRange: { minValue: mid - half, maxValue: mid + half } };
}

/** Hex colour → rgba with alpha (theme tokens used here are plain hex). */
function alpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function TokenChart({ token, indexing, className }: { token: TokenDetail; indexing?: boolean; className?: string }) {
  const [interval, setIv] = useState<Interval>("5m");
  const [metric, setMetric] = useState<Metric>("mcap");
  const [unitPref, setUnit] = useState<Unit>("usd");
  const assetUsd = token.asset.usd;
  const unit: Unit = assetUsd == null ? "asset" : unitPref;
  const candles = useCandles(indexing ? null : token.address, interval);
  // The API returns only buckets with a trade; the chart needs one bar per interval up to now. Previous-interval data
  // shown while the new one loads is left as is (its buckets do not match this interval).
  const { data, isPlaceholderData, dataUpdatedAt } = candles;
  const bars = useMemo(
    () =>
      data && !isPlaceholderData
        ? fillCandles(data, {
            step: INTERVAL_SECONDS[interval],
            now: Math.floor(dataUpdatedAt / 1000),
            from: token.createdAt,
            startPrice: token.startPriceX18,
            maxBars: MAX_BARS,
          })
        : data,
    [data, isPlaceholderData, dataUpdatedAt, interval, token.createdAt, token.startPriceX18],
  );

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs size="sm" aria-label="Interval" value={interval} onChange={setIv} items={INTERVALS} />
        <div className="flex flex-wrap items-center gap-2">
          <PillTabs size="sm" aria-label="Series" value={metric} onChange={setMetric} items={METRICS} />
          <PillTabs
            size="sm"
            aria-label="Currency"
            value={unit}
            onChange={setUnit}
            items={[
              { value: "usd", label: "USD", disabled: assetUsd == null },
              { value: "asset", label: token.asset.symbol },
            ]}
          />
        </div>
      </div>

      <div className="mt-5">
        {indexing ? (
          <div className={cn("relative", HEIGHT)}>
            <Skeleton className="size-full rounded-card" />
            <p className="absolute inset-0 grid place-items-center text-sm text-muted">Indexing…</p>
          </div>
        ) : candles.isPending ? (
          <Skeleton className={cn("w-full rounded-card", HEIGHT)} />
        ) : (
          <CandleChart
            token={token}
            candles={bars}
            failed={candles.isError && !candles.data}
            metric={metric}
            unit={unit}
            assetUsd={assetUsd}
            seconds={interval === "1s"}
            fitKey={`${token.address}|${interval}|${metric}|${unit}`}
          />
        )}
      </div>
    </Card>
  );
}

function CandleChart({
  token,
  candles,
  failed,
  metric,
  unit,
  assetUsd,
  seconds,
  fitKey,
}: {
  token: TokenDetail;
  candles: { time: number; open: string; high: string; low: string; close: string }[] | undefined;
  failed: boolean;
  metric: Metric;
  unit: Unit;
  assetUsd: number | null;
  /** 1-second candles: show seconds on the time axis. */
  seconds: boolean;
  fitKey: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const fitted = useRef("");

  const factor = (metric === "mcap" ? SUPPLY : 1) * (unit === "usd" && assetUsd != null ? assetUsd : 1);
  const decimals = token.asset.decimals;
  const empty = !failed && (candles?.length ?? 0) === 0;

  const bars = useMemo<CandlestickData<UTCTimestamp>[]>(() => {
    const v = (p: string) => priceX18ToNumber(p, decimals) * factor;
    return (candles ?? []).map((c) => ({ time: c.time as UTCTimestamp, open: v(c.open), high: v(c.high), low: v(c.low), close: v(c.close) }));
  }, [candles, factor, decimals]);

  // No trades yet: a flat line at the current (starting) price from launch to now.
  const flat = useMemo<LineData<UTCTimestamp>[]>(() => {
    if (!empty) return [];
    const now = Math.floor(Date.now() / 1000);
    const from = token.createdAt && token.createdAt < now - 60 ? token.createdAt : now - 3600;
    const value = priceX18ToNumber(token.priceX18, decimals) * factor;
    return [
      { time: from as UTCTimestamp, value },
      { time: now as UTCTimestamp, value },
    ];
  }, [empty, token.createdAt, token.priceX18, factor, decimals]);

  // Price format: formatter per mode + a base (1/minMove) about 5 significant digits below the smallest value,
  // so tiny prices (1e-10 and below) still get a usable scale. `base` avoids float issues of 1/minMove.
  const priceFormat = useMemo(() => {
    const values = bars.length ? bars.map((b) => b.low) : flat.map((p) => p.value);
    const min = Math.min(...values.filter((x) => x > 0));
    const decimals = isFinite(min) ? Math.min(18, Math.max(0, 4 - Math.floor(Math.log10(min)))) : 2;
    const base = 10 ** decimals;
    const formatter = (x: number) =>
      unit === "usd" ? (metric === "mcap" ? formatUsd(x) : `$${formatTiny(x)}`) : metric === "mcap" ? sig(x, 4) : formatTiny(x);
    return { type: "custom" as const, formatter, base, minMove: 1 / base };
  }, [bars, flat, unit, metric]);

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, fontSize: 12, attributionLogo: true },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 2 },
    });
    chart.current = c;
    candleSeries.current = c.addSeries(CandlestickSeries, { priceLineVisible: true, autoscaleInfoProvider: minPriceRange });
    lineSeries.current = c.addSeries(LineSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      lastValueVisible: true,
      autoscaleInfoProvider: minPriceRange,
    });
    return () => {
      c.remove();
      chart.current = null;
      candleSeries.current = null;
      lineSeries.current = null;
      fitted.current = "";
    };
  }, []);

  // Colours from the CSS variables of the (only) dark theme.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const text = cssVar("--muted");
    const border = cssVar("--border");
    const buy = cssVar("--buy");
    const sell = cssVar("--sell");
    c.applyOptions({
      layout: { textColor: text, fontFamily: getComputedStyle(document.body).fontFamily },
      grid: { vertLines: { color: alpha(border, 0.45) }, horzLines: { color: alpha(border, 0.45) } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
      crosshair: {
        vertLine: { color: alpha(text, 0.5), labelBackgroundColor: cssVar("--surface-2") },
        horzLine: { color: alpha(text, 0.5), labelBackgroundColor: cssVar("--surface-2") },
      },
    });
    candleSeries.current?.applyOptions({
      upColor: buy,
      downColor: sell,
      borderUpColor: buy,
      borderDownColor: sell,
      wickUpColor: buy,
      wickDownColor: sell,
    });
    lineSeries.current?.applyOptions({ color: cssVar("--accent") });
  }, []);

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { secondsVisible: seconds } });
  }, [seconds]);

  // Data.
  useEffect(() => {
    const c = chart.current;
    if (!c || !candleSeries.current || !lineSeries.current) return;
    const ts = c.timeScale();
    // New bars arrive every interval: keep following the latest one unless the viewer scrolled back into history.
    const offset = ts.scrollPosition();
    const following = fitted.current === fitKey && offset > -0.5;
    candleSeries.current.applyOptions({ priceFormat });
    lineSeries.current.applyOptions({ priceFormat });
    candleSeries.current.setData(bars);
    lineSeries.current.setData(flat);
    if (fitted.current !== fitKey && (bars.length || flat.length)) {
      fitted.current = fitKey;
      if (bars.length) ts.setVisibleLogicalRange({ from: bars.length - VISIBLE_BARS, to: bars.length + 2 });
      else ts.fitContent();
    } else if (following) {
      ts.scrollToPosition(offset, false);
    }
  }, [bars, flat, priceFormat, fitKey]);

  return (
    <div className={cn("relative", HEIGHT)}>
      <div ref={el} className="absolute inset-0" />
      {(empty || failed) && (
        <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-muted">
          {failed ? "Chart data is unavailable right now." : COPY.token.waitingFirstTrade}
        </p>
      )}
    </div>
  );
}

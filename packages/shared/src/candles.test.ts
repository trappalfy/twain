import { describe, expect, it } from "vitest";
import { fillCandles, INTERVAL_SECONDS } from "./candles";

const bar = (time: number, open: string, close: string, high = close, low = open, volumeAsset = "5") => ({
  time,
  open,
  high,
  low,
  close,
  volumeAsset,
});
const flat = (time: number, price: string) => ({ time, open: price, high: price, low: price, close: price, volumeAsset: "0" });

describe("fillCandles", () => {
  it("returns nothing without candles", () => {
    expect(fillCandles([], { step: 60, now: 600, maxBars: 100 })).toEqual([]);
  });

  it("fills every empty bucket with a flat bar at the previous close, up to the bucket of now", () => {
    const out = fillCandles([bar(60, "10", "12"), bar(240, "12", "9")], { step: 60, now: 365, maxBars: 100 });
    expect(out).toEqual([bar(60, "10", "12"), flat(120, "12"), flat(180, "12"), bar(240, "12", "9"), flat(300, "9"), flat(360, "9")]);
  });

  it("gives one bar per second on the 1s interval", () => {
    const out = fillCandles([bar(100, "1", "2"), bar(103, "2", "3")], { step: INTERVAL_SECONDS["1s"], now: 104, maxBars: 100 });
    expect(out.map((c) => c.time)).toEqual([100, 101, 102, 103, 104]);
    expect(out[2]).toEqual(flat(102, "2"));
  });

  it("starts at the launch bucket at the start price when the launch is known", () => {
    const out = fillCandles([bar(180, "7", "8")], { step: 60, now: 190, from: 75, startPrice: "7", maxBars: 100 });
    expect(out).toEqual([flat(60, "7"), flat(120, "7"), bar(180, "7", "8")]);
  });

  it("keeps only the latest maxBars, opening the window at the close before it", () => {
    const out = fillCandles([bar(0, "1", "4"), bar(600, "4", "6")], { step: 60, now: 780, maxBars: 4 });
    expect(out).toEqual([bar(600, "4", "6"), flat(660, "6"), flat(720, "6"), flat(780, "6")]);
    const earlier = fillCandles([bar(0, "1", "4"), bar(600, "4", "6")], { step: 60, now: 660, maxBars: 4 });
    expect(earlier).toEqual([flat(480, "4"), flat(540, "4"), bar(600, "4", "6"), flat(660, "6")]);
  });

  it("never drops the last candle when the clock is behind it", () => {
    const out = fillCandles([bar(120, "1", "2")], { step: 60, now: 30, maxBars: 10 });
    expect(out).toEqual([bar(120, "1", "2")]);
  });
});

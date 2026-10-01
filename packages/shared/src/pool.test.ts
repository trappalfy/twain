import { describe, expect, it } from "vitest";
import { mcapFromPriceX18, priceX18FromSqrt, quoteFromStart, sqrtPriceAtTick, startPriceX18 } from "./pool";

// Reference values from the Solidity TickMath / Launchpad (contracts, forge).
describe("sqrtPriceAtTick", () => {
  const vectors: [number, bigint][] = [
    [0, 79228162514264337593543950336n],
    [-197200, 4139520951870358439442244n],
    [197200, 1516383612589398750741263983824426n],
    [-414000, 81177051551811462508n],
    [123457, 37982211131736002307691248219731n],
    [-887272, 4295128739n],
    [887272, 1461446703485210103287273052203988822378723970342n],
    [-1, 79224201403219477170569942574n],
  ];
  it.each(vectors)("tick %i", (tick, want) => expect(sqrtPriceAtTick(tick)).toBe(want));
  it("rejects out-of-range ticks", () => expect(() => sqrtPriceAtTick(887273)).toThrow());
});

describe("prices", () => {
  it("ETH start: tick -197200 ≈ 2.73 ETH market cap, rounded down", () => {
    const mcap = mcapFromPriceX18(startPriceX18(-197200));
    expect(mcap).toBeLessThanOrEqual(2_730_000_000_000_000_000n);
    expect(mcap).toBeGreaterThan(2_670_000_000_000_000_000n);
  });
  it("is the same price for both currency orders", () => {
    const s0 = sqrtPriceAtTick(-177400); // coin = currency0: pool price = asset per coin
    const s1 = sqrtPriceAtTick(177400); // coin = currency1: pool price = coin per asset
    const a = priceX18FromSqrt(s0, true);
    const b = priceX18FromSqrt(s1, false);
    expect(Number(a - b) / Number(a)).toBeLessThan(1e-12);
  });
  it("first-buy preview matches the contract (1 ETH at the ETH start)", () => {
    const out = quoteFromStart(-197200, 10n ** 18n);
    const contract = 266138765946600838427802342n;
    expect(Math.abs(Number(out - contract)) / Number(contract)).toBeLessThan(1e-9);
  });
});

import type { Address } from "viem";
import type { CoinPhase } from "./api-types";

/**
 * Pons V2 on Robinhood Chain (verified sources on Blockscout, checked 2026-10-02). twain launches every coin through
 * the official factory via TwainLauncher; the coin trades on its Pons curve until the sellable allocation is bought
 * out, then in a Uniswap v4 pool with the Pons meme hook.
 */
export const PONS_V2 = {
  factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  feeEscrow: "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e",
  memeHook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
  /** L2 block the factory was deployed in (start of pair-token approvals). */
  factoryDeployBlock: 26_841_846,
} as const satisfies Record<string, Address | number>;

/** Pons launch config every twain coin uses: 1B supply, 1% curve fee, graduation into a v4 pool (fee 0, spacing 200). */
export const LAUNCH_CONFIG_ID = 0n;
export const PONS_POOL_FEE = 0;
export const PONS_TICK_SPACING = 200;

/** Pons base fee on every trade, on the quote leg: 1% (curve fee before graduation, hook fee after). */
export const PONS_FEE_BPS = 100n;
/** Pons keeps 30% of its base fee; 70% goes to the coin's fee recipient (its twain vault). */
export const PONS_PROTOCOL_SHARE_BPS = 3_000n;
/** twain creator tax on every trade, paid entirely to the coin's vault. Mirrors TwainLauncher.CREATOR_TAX_BPS. */
export const CREATOR_TAX_BPS = 100n;

export const BASIS_POINTS = 10_000n;

/** Pons GraduationPhase: 0 NotGraduated → 1 Swept → 2 PoolCreated (3 Rescued: reserves recovered by the owner). */
export function coinPhase(ponsPhase: number): CoinPhase {
  return (["curve", "graduating", "pool", "rescued"] as const)[ponsPhase] ?? "curve";
}

/** Tokens the curve keeps back for the pool: supply · phantom / (phantom + threshold), as in PonsV2BondingCurve.initialize. */
export function reservedTokens(supply: bigint, phantomQuote: bigint, graduationThreshold: bigint): bigint {
  return (supply * phantomQuote) / (phantomQuote + graduationThreshold);
}

/** Curve price: smallest quote units per whole coin × 1e18 (the API's `priceX18`). */
export function curvePriceX18(quoteReserve: bigint, tokenReserve: bigint): bigint {
  return tokenReserve === 0n ? 0n : (quoteReserve * 10n ** 36n) / tokenReserve;
}

/** Share of the sellable allocation bought so far, in bps (10,000 = ready to graduate). */
export function curveProgressBps(tokenReserve: bigint, supply: bigint, reserved: bigint): number {
  const sellableTotal = supply - reserved;
  if (sellableTotal <= 0n) return 10_000;
  const sold = supply - tokenReserve;
  return Number(sold >= sellableTotal ? 10_000n : (sold * 10_000n) / sellableTotal);
}

/** Pons snipe tax for a buy `elapsed` seconds after launch: start >> (elapsed·14/window), 0 once the window ends. */
export function snipeTaxBps(elapsed: bigint, startBps: bigint, windowSeconds: bigint): bigint {
  if (startBps === 0n || windowSeconds === 0n || elapsed >= windowSeconds) return 0n;
  return startBps >> ((elapsed * 14n) / windowSeconds);
}

const amountOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint =>
  amountIn === 0n || reserveIn === 0n || reserveOut === 0n ? 0n : (amountIn * reserveOut) / (reserveIn + amountIn);

const amountIn = (out: bigint, reserveIn: bigint, reserveOut: bigint): bigint =>
  (out * reserveIn * BASIS_POINTS) / ((reserveOut - out) * BASIS_POINTS) + 1n;

export type CurveState = {
  quoteReserve: bigint;
  tokenReserve: bigint;
  reserved: bigint;
  feeBps: bigint;
  taxBps: bigint;
};

export type CurveBuyQuote = {
  tokensOut: bigint;
  /** Quote actually taken (fees included); the rest of `quoteIn` is refunded when the allocation runs out. */
  spent: bigint;
  refund: bigint;
  fee: bigint;
  tax: bigint;
  snipeTax: bigint;
  /** The allocation ran out: this buy completes the curve. */
  completes: boolean;
};

/** Mirrors PonsV2BondingCurve.buy exactly, including the partial fill at the end of the allocation. */
export function quoteCurveBuy(c: CurveState, quoteIn: bigint, snipeBps = 0n): CurveBuyQuote {
  const zero = { tokensOut: 0n, spent: 0n, refund: quoteIn, fee: 0n, tax: 0n, snipeTax: 0n, completes: false };
  const sellable = c.tokenReserve > c.reserved ? c.tokenReserve - c.reserved : 0n;
  if (quoteIn === 0n || sellable === 0n) return zero;
  let snipe = snipeBps;
  if (snipe !== 0n) {
    const max = BASIS_POINTS - c.feeBps - c.taxBps - 100n;
    if (snipe > max) snipe = max;
  }
  let spent = quoteIn;
  let fee = (spent * c.feeBps) / BASIS_POINTS;
  let tax = (spent * c.taxBps) / BASIS_POINTS;
  let snipeTax = (spent * snipe) / BASIS_POINTS;
  let tokensOut = amountOut(spent - fee - tax - snipeTax, c.quoteReserve, c.tokenReserve);
  let completes = false;
  if (tokensOut >= sellable) {
    completes = true;
    if (tokensOut > sellable) {
      tokensOut = sellable;
      const net = amountIn(sellable, c.quoteReserve, c.tokenReserve);
      const denom = BASIS_POINTS - c.feeBps - c.taxBps - snipe;
      const needed = (net * BASIS_POINTS + denom - 1n) / denom; // mulDiv rounding up
      spent = needed < quoteIn ? needed : quoteIn;
      fee = (spent * c.feeBps) / BASIS_POINTS;
      tax = (spent * c.taxBps) / BASIS_POINTS;
      snipeTax = (spent * snipe) / BASIS_POINTS;
    }
  }
  return { tokensOut, spent, refund: quoteIn - spent, fee, tax, snipeTax, completes };
}

export type CurveSellQuote = { quoteOut: bigint; gross: bigint; fee: bigint; tax: bigint };

/** Mirrors PonsV2BondingCurve.sell: fees come out of the gross quote. */
export function quoteCurveSell(c: CurveState, tokensIn: bigint): CurveSellQuote {
  const gross = amountOut(tokensIn, c.tokenReserve, c.quoteReserve);
  const fee = (gross * c.feeBps) / BASIS_POINTS;
  const tax = (gross * c.taxBps) / BASIS_POINTS;
  return { quoteOut: gross - fee - tax, gross, fee, tax };
}

/** Applies a curve trade event to the reserves (indexer replay; CurveBuy/CurveSell amounts as emitted). */
export function applyCurveBuy(c: CurveState, spent: bigint, tokensOut: bigint, feeInclSnipe: bigint, tax: bigint) {
  return { ...c, quoteReserve: c.quoteReserve + spent - feeInclSnipe - tax, tokenReserve: c.tokenReserve - tokensOut };
}
export function applyCurveSell(c: CurveState, tokensIn: bigint, quoteOut: bigint, fee: bigint, tax: bigint) {
  return { ...c, quoteReserve: c.quoteReserve - (quoteOut + fee + tax), tokenReserve: c.tokenReserve + tokensIn };
}

/** The share of every trade's quote leg that reaches the coin's vault: 70% of the Pons fee + the creator tax. */
export const VAULT_SHARE_BPS =
  (PONS_FEE_BPS * (BASIS_POINTS - PONS_PROTOCOL_SHARE_BPS)) / BASIS_POINTS + CREATOR_TAX_BPS; // 170 = 1.7%

/**
 * Creator side of fees still held by a coin's curve (not yet swept to Pons' escrow): 70% of the Pons fee bucket
 * (fee + snipe tax) and the whole creator tax. The vault receives this at the next sweep (its harvest does it).
 */
export function curveCreatorSide(quoteFeeBalance: bigint, creatorTaxBalance: bigint): bigint {
  return (quoteFeeBalance * (BASIS_POINTS - PONS_PROTOCOL_SHARE_BPS)) / BASIS_POINTS + creatorTaxBalance;
}

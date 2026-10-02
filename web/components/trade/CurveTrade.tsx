"use client";

import {
  applySlippage,
  BASIS_POINTS,
  COPY,
  formatAsset,
  formatPct,
  formatTokens,
  PARAMS,
  quoteCurveBuy,
  quoteCurveSell,
  type CurveState,
  type TokenDetail,
} from "@twain/shared";
import { ponsCurveAbi, ponsFactoryAbi, tokenAbi } from "@twain/shared/abi";
import { useState } from "react";
import { maxUint256, zeroAddress, type Address, type Hash } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { revertErrorName } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { useTx } from "@/lib/tx";
import { isNative, LIVE, parseAmount, PONS_FACTORY, REFRESH_MS, useDebounced, useWallet, type Side } from "./hooks";
import { formatImpact, IMPACT_WARN_BPS, NOT_CONFIGURED } from "./format";
import { Notice, resolveAction, TradeForm, type QuoteRow } from "./TradeForm";

/**
 * Gas for a buy that completes the curve: Pons tries to graduate inside it under a try/catch, which gas estimation
 * cannot see, so an estimated limit can leave the graduation out of gas. Robinhood Chain gas is cheap.
 */
const COMPLETING_BUY_GAS = 4_000_000n;

/** Map Pons curve reverts to plain text before the standard toast flow sees them. */
async function withCurveErrors(send: () => Promise<Hash>): Promise<Hash> {
  try {
    return await send();
  } catch (err) {
    const name = revertErrorName(err);
    if (name === "SlippageExceeded") throw new Error(COPY.errors.SlippageExceeded);
    if (name === "CurveGraduated") throw new Error("This coin has just moved to its Uniswap pool. Trade there.");
    throw err;
  }
}

/**
 * Buy / sell a coin on its Pons launch curve (before it graduates into the Uniswap pool). Quotes are computed in the
 * browser with the curve's exact formula from its live reserves; the snipe tax of the first seconds is read from the
 * curve for the connected wallet. ETH is paid as msg.value, an ERC-20 pair asset and sold coins are approved to the
 * curve itself.
 */
export function CurveTrade({ token, side, slippageBps }: { token: TokenDetail; side: Side; slippageBps: number }) {
  const sym = token.symbol;
  const asset = token.asset;
  const curve = token.curve as Address;
  const wallet = useWallet(token.address, asset);
  const tx = useTx();
  const [input, setInput] = useState("");
  const inDecimals = side === "buy" ? asset.decimals : 18;
  const typed = parseAmount(input, inDecimals);
  const debounced = useDebounced(typed);
  const owner = wallet.address ?? zeroAddress;
  const tokenIn: Address = side === "buy" ? asset.address : token.address;
  const erc20In = !(side === "buy" && isNative(asset));

  const c = { address: curve, abi: ponsCurveAbi } as const;
  const reads = useReadContracts({
    contracts: [
      { ...c, functionName: "getReserves" },
      { ...c, functionName: "reservedTokens" },
      { ...c, functionName: "feeBps" },
      { ...c, functionName: "creatorTaxBps" },
      { ...c, functionName: "currentSnipeTaxBps", args: [owner] },
    ],
    allowFailure: false,
    query: { enabled: LIVE, refetchInterval: REFRESH_MS },
  });
  const [reserves, reserved, feeBps, taxBps, snipeBps] = reads.data ?? [];
  // ERC-20 input (the pair asset on a buy, the coin on a sell) is pulled by the curve itself.
  const allowanceQ = useReadContract({
    address: tokenIn,
    abi: tokenAbi,
    functionName: "allowance",
    args: [owner, curve],
    query: { enabled: LIVE && erc20In && !!wallet.address, refetchInterval: REFRESH_MS * 2 },
  });
  const allowance = allowanceQ.data;
  const state: CurveState | null =
    reserves && reserved !== undefined && feeBps !== undefined && taxBps !== undefined
      ? { quoteReserve: reserves[0], tokenReserve: reserves[1], reserved, feeBps, taxBps }
      : null;
  const snipe = side === "buy" ? (snipeBps ?? 0n) : 0n;

  const buy = state && side === "buy" && debounced ? quoteCurveBuy(state, debounced, snipe) : null;
  const sell = state && side === "sell" && debounced ? quoteCurveSell(state, debounced) : null;
  const out = buy ? buy.tokensOut : sell ? sell.quoteOut : null;
  const stale = typed !== debounced;
  const quoteLoading = !!typed && (stale || (LIVE && !state));

  // Price impact against the spot price after fees: spot = quoteReserve / tokenReserve.
  const impact = (() => {
    if (!state || !debounced || out === null || out === 0n) return null;
    const feeBpsTotal = state.feeBps + state.taxBps + (side === "buy" ? snipe : 0n);
    const net = (debounced * (BASIS_POINTS - feeBpsTotal)) / BASIS_POINTS;
    const expected = side === "buy" ? (net * state.tokenReserve) / state.quoteReserve : (net * state.quoteReserve) / state.tokenReserve;
    if (expected === 0n || out >= expected) return 0;
    return Number(((expected - out) * 10_000n) / expected);
  })();
  const fees = buy ? buy.fee + buy.tax + buy.snipeTax : sell ? sell.fee + sell.tax : null;
  const minOut = out !== null ? applySlippage(out, slippageBps) : null;

  const fmtOut = (v: bigint) => (side === "buy" ? formatTokens(v, sym) : formatAsset(v, asset));
  const rows: QuoteRow[] = [
    { label: "You receive", value: out !== null ? fmtOut(out) : "—" },
    {
      label: "Price impact",
      value: impact === null ? "—" : formatImpact(impact),
      tone: impact !== null && impact >= IMPACT_WARN_BPS ? "sell" : undefined,
    },
    {
      label: `Fees (${PARAMS.tradeFeePct}${snipe > 0n ? " + snipe tax" : ""})`,
      value: fees !== null && typed ? formatAsset(fees, asset) : "—",
      tone: snipe > 0n ? "sell" : undefined,
    },
    { label: "Min received", value: minOut !== null ? fmtOut(minOut) : "—" },
  ];

  const inSymbol = side === "buy" ? asset.symbol : `$${sym}`;
  const needsApproval = erc20In && !!typed && allowance !== undefined && allowance < typed;
  const approve = async () => {
    const rc = await tx.run(
      () => tx.writeContractAsync({ address: tokenIn, abi: tokenAbi, functionName: "approve", args: [curve, maxUint256] }),
      { success: `${inSymbol} approved` },
    );
    if (rc) void allowanceQ.refetch();
  };

  const execute = async () => {
    if (!typed || minOut === null || !wallet.address) return;
    const amount = typed;
    const recipient = wallet.address;
    const rc = await tx.run(() =>
      withCurveErrors(() =>
        side === "buy"
          ? tx.writeContractAsync({
              ...c,
              functionName: "buy",
              args: [amount, minOut, recipient],
              value: erc20In ? undefined : amount,
              gas: buy?.completes ? COMPLETING_BUY_GAS : undefined,
            })
          : tx.writeContractAsync({ ...c, functionName: "sell", args: [amount, minOut, recipient] }),
      ),
    );
    if (rc?.status === "success") {
      setInput("");
      wallet.refetchBalances();
      void reads.refetch();
    }
  };

  // The allocation sold out but Pons' automatic graduation did not run: anyone can finish it.
  const finishGraduation = async () => {
    const rc = await tx.run(
      () => tx.writeContractAsync({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: "graduate", args: [token.address], gas: COMPLETING_BUY_GAS }),
      { pending: "Moving to Uniswap…", success: "The curve is closed. The Uniswap pool opens next." },
    );
    if (rc) void reads.refetch();
  };
  const soldOut = state !== null && state.tokenReserve <= state.reserved;

  const action = resolveAction({
    wallet,
    side,
    symbol: sym,
    assetSymbol: asset.symbol,
    amount: typed,
    txStatus: tx.status,
    blocked: !LIVE ? NOT_CONFIGURED : soldOut ? "Moving to Uniswap" : null,
    approval: needsApproval ? { label: `Approve ${inSymbol}`, run: () => void approve() } : null,
    ready: out !== null && out > 0n && !quoteLoading && (!erc20In || allowance !== undefined),
    execute: () => void execute(),
  });

  const notices = (
    <>
      {snipe > 0n && (
        <Notice tone="sell">
          Launch snipe tax: {formatPct(Number(snipe) / 100)} of this buy for the first {PARAMS.snipeWindow} of the coin.
          It drops to zero within seconds.
        </Notice>
      )}
      {buy?.completes && (
        <Notice tone="gold">
          This buy completes the launch curve{buy.refund > 0n ? ` (${formatAsset(buy.refund, asset)} is returned)` : ""}.
          The coin then moves to its Uniswap pool.
        </Notice>
      )}
      {soldOut && (
        <Notice>
          The curve is sold out and moves to its Uniswap pool next; trading continues there. Anyone can finish the move.
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full"
            loading={tx.status === "confirm" || tx.status === "pending"}
            disabled={!wallet.connected || wallet.wrongChain || tx.busy}
            onClick={() => void finishGraduation()}
          >
            Finish the move to Uniswap
          </Button>
        </Notice>
      )}
    </>
  );

  return (
    <TradeForm
      side={side}
      symbol={sym}
      asset={asset}
      input={input}
      onInput={setInput}
      wallet={wallet}
      rows={rows}
      quoteLoading={quoteLoading}
      notices={notices}
      action={action}
    />
  );
}

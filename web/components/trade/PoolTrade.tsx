"use client";

import { applySlippage, COPY, formatAsset, formatTokens, PARAMS, POOL_LP_FEE, UNISWAP_V4, type TokenDetail } from "@twain/shared";
import { permit2Abi, stateViewAbi, tokenAbi, v4QuoterAbi } from "@twain/shared/abi";
import { useMemo, useState } from "react";
import { maxUint256, zeroAddress, type Address, type Hash } from "viem";
import { useReadContract, useSimulateContract } from "wagmi";
import { revertErrorName, toFriendlyError } from "@/lib/errors";
import { useTx } from "@/lib/tx";
import {
  coinPoolKey,
  encodeExactInSingle,
  PERMIT2_EXPIRATION_SECONDS,
  POOL_FEE_PIPS,
  poolIdOf,
  poolImpactBps,
  routerAbi,
} from "@/lib/uniswap";
import { deadlineFromNow, isNative, LIVE, parseAmount, REFRESH_MS, useDebounced, useWallet, type Side } from "./hooks";
import { formatImpact, IMPACT_WARN_BPS, NOT_CONFIGURED } from "./format";
import { Notice, resolveAction, TradeForm, type QuoteRow } from "./TradeForm";

const ROUTER = UNISWAP_V4.universalRouter;
const PERMIT2 = UNISWAP_V4.permit2;
const FEE_LABEL = `Pool fee (${PARAMS.poolFeePct})`;

/** Map Universal Router / Permit2 reverts to plain text before the standard toast flow sees them. */
async function withPoolErrors(send: () => Promise<Hash>): Promise<Hash> {
  try {
    return await send();
  } catch (err) {
    const name = revertErrorName(err);
    if (name === "V4TooLittleReceived" || name === "V4TooLittleReceivedPerHopSingle") throw new Error(COPY.errors.SlippageExceeded);
    if (name === "TransactionDeadlinePassed") throw new Error(COPY.errors.DeadlineExpired);
    if (name === "AllowanceExpired" || name === "InsufficientAllowance")
      throw new Error("The router allowance is missing or expired. Allow it again.");
    throw err;
  }
}

/**
 * Buy / sell a coin in its Uniswap v4 pool through the Universal Router. Buy = asset → coin, sell = coin → asset.
 * Native ETH goes in as msg.value; any ERC-20 input (the coin, or an asset such as a stock token) goes through
 * Permit2: approve it for Permit2 once, then allow the router for this amount.
 */
export function PoolTrade({ token, side, slippageBps }: { token: TokenDetail; side: Side; slippageBps: number }) {
  const sym = token.symbol;
  const asset = token.asset;
  const wallet = useWallet(token.address, asset);
  const tx = useTx();
  const [input, setInput] = useState("");
  const inDecimals = side === "buy" ? asset.decimals : 18;
  const typed = parseAmount(input, inDecimals);
  const debounced = useDebounced(typed);
  const owner = wallet.address ?? zeroAddress;

  const key = useMemo(() => coinPoolKey(token.address, asset.address), [token.address, asset.address]);
  const poolId = useMemo(() => poolIdOf(key), [key]);
  // Buy moves the asset into the pool: towards currency1 when the asset is currency0 (the coin is currency1).
  const zeroForOne = side === "buy" ? !token.coinIsCurrency0 : token.coinIsCurrency0;
  const tokenIn: Address = side === "buy" ? asset.address : token.address;
  const erc20In = !(side === "buy" && isNative(asset));

  const quoteSim = useSimulateContract({
    address: UNISWAP_V4.quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne, exactAmount: debounced ?? 0n, hookData: "0x" }],
    query: { enabled: LIVE && !!debounced, refetchInterval: REFRESH_MS },
  });
  const slot0 = useReadContract({
    address: UNISWAP_V4.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId],
    query: { enabled: LIVE, refetchInterval: REFRESH_MS },
  });

  // ERC-20 input: token → Permit2 (ERC-20 approve, once), then Permit2 → Universal Router (this amount).
  const allowanceReads = LIVE && erc20In && !!wallet.address;
  const erc20Allowance = useReadContract({
    address: tokenIn,
    abi: tokenAbi,
    functionName: "allowance",
    args: [owner, PERMIT2],
    query: { enabled: allowanceReads, refetchInterval: REFRESH_MS * 2 },
  });
  const permit2Allowance = useReadContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, tokenIn, ROUTER],
    query: { enabled: allowanceReads, refetchInterval: REFRESH_MS * 2 },
  });

  const out = typed && quoteSim.data ? quoteSim.data.result[0] : null;
  const stale = typed !== debounced;
  const quoteLoading = !!typed && (stale || (LIVE && quoteSim.isLoading));
  const quoteError = LIVE && !!typed && !stale && !quoteSim.data && quoteSim.error ? toFriendlyError(quoteSim.error) : null;
  const impact =
    out !== null && debounced && slot0.data
      ? poolImpactBps({ sqrtPriceX96: slot0.data[0], zeroForOne, amountIn: debounced, amountOut: out })
      : null;
  const fee = debounced ? (debounced * BigInt(POOL_LP_FEE)) / POOL_FEE_PIPS : null;
  const minOut = out !== null ? applySlippage(out, slippageBps) : null;

  const fmtOut = (v: bigint) => (side === "buy" ? formatTokens(v, sym) : formatAsset(v, asset));
  const fmtIn = (v: bigint) => (side === "buy" ? formatAsset(v, asset) : formatTokens(v, sym));
  const rows: QuoteRow[] = [
    { label: "You receive", value: out !== null ? fmtOut(out) : "—" },
    {
      label: "Price impact",
      value: impact === null ? "—" : formatImpact(impact),
      tone: impact !== null && impact >= IMPACT_WARN_BPS ? "sell" : undefined,
    },
    { label: FEE_LABEL, value: fee !== null && typed ? fmtIn(fee) : "—" },
    { label: "Min received", value: minOut !== null ? fmtOut(minOut) : "—" },
  ];

  // Approval steps (ERC-20 input only).
  const inSymbol = side === "buy" ? asset.symbol : `$${sym}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const needsErc20 = erc20In && !!typed && erc20Allowance.data !== undefined && erc20Allowance.data < typed;
  const needsPermit =
    erc20In &&
    !!typed &&
    !!permit2Allowance.data &&
    (permit2Allowance.data[0] < typed || permit2Allowance.data[1] <= nowSec + 60);
  const allowancesLoaded = !erc20In || (erc20Allowance.data !== undefined && permit2Allowance.data !== undefined);

  const approveToken = async () => {
    const rc = await tx.run(
      () => tx.writeContractAsync({ address: tokenIn, abi: tokenAbi, functionName: "approve", args: [PERMIT2, maxUint256] }),
      { success: `${inSymbol} approved for Permit2` },
    );
    if (rc) void erc20Allowance.refetch();
  };
  const permitRouter = async () => {
    if (!typed) return;
    const amount = typed;
    const expiration = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRATION_SECONDS;
    const rc = await tx.run(
      () =>
        tx.writeContractAsync({
          address: PERMIT2,
          abi: permit2Abi,
          functionName: "approve",
          args: [tokenIn, ROUTER, amount, expiration],
        }),
      { success: "Uniswap router allowed" },
    );
    if (rc) void permit2Allowance.refetch();
  };

  const execute = async () => {
    if (!typed || minOut === null) return;
    const amountIn = typed;
    const args = encodeExactInSingle({ key, zeroForOne, amountIn, minAmountOut: minOut, deadline: deadlineFromNow() });
    const rc = await tx.run(() =>
      withPoolErrors(() =>
        tx.writeContractAsync({
          address: ROUTER,
          abi: routerAbi,
          functionName: "execute",
          args,
          value: erc20In ? undefined : amountIn,
        }),
      ),
    );
    if (rc?.status === "success") {
      setInput("");
      wallet.refetchBalances();
    }
  };

  const approval = needsErc20
    ? { label: `Approve ${inSymbol} · 1 of 2`, run: () => void approveToken() }
    : needsPermit
      ? { label: "Allow Uniswap router · 2 of 2", run: () => void permitRouter() }
      : null;

  const action = resolveAction({
    wallet,
    side,
    symbol: sym,
    assetSymbol: asset.symbol,
    amount: typed,
    txStatus: tx.status,
    blocked: !LIVE ? NOT_CONFIGURED : quoteError ? "Quote unavailable" : null,
    approval,
    ready: out !== null && !quoteLoading && allowancesLoaded,
    execute: () => void execute(),
  });

  const notices = (
    <>
      {quoteError && <Notice tone="sell">{quoteError}</Notice>}
      {approval && tx.status !== "confirm" && tx.status !== "pending" && (
        <Notice>
          Uniswap takes {inSymbol} through Permit2: approve it for Permit2 once, then allow the Uniswap router to spend
          this amount.
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

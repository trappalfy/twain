"use client";

import { COPY, formatAsset, formatPct, type TokenDetail } from "@twain/shared";
import { ponsFactoryAbi } from "@twain/shared/abi";
import Link from "next/link";
import { useState } from "react";
import { TwainMark } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PillTabs } from "@/components/ui/PillTabs";
import { useTx } from "@/lib/tx";
import { CurveTrade } from "./CurveTrade";
import { LIVE, PONS_FACTORY, usePhase, type Side } from "./hooks";
import { PoolTrade } from "./PoolTrade";
import { SlippageSettings, useSlippage } from "./SlippageSettings";

const SIDES = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
] as const;

/**
 * Trade panel (right column). A twain coin trades on its Pons launch curve until the curve's allocation is bought
 * out, then in its Uniswap v4 pool (Pons meme hook) through the Universal Router.
 */
export function TradePanel({ token, initialSide = "buy" }: { token: TokenDetail; initialSide?: "buy" | "sell" }) {
  const [side, setSide] = useState<Side>(initialSide);
  const [prevInitial, setPrevInitial] = useState(initialSide);
  if (initialSide !== prevInitial) {
    setPrevInitial(initialSide);
    setSide(initialSide);
  }
  const [slippageBps, setSlippageBps] = useSlippage();
  const { phase, refetch } = usePhase(token);

  return (
    <Card as="section" aria-label={`Trade $${token.symbol}`} className="md:p-6">
      <div className="flex items-center justify-between gap-3">
        <PillTabs value={side} onChange={setSide} items={SIDES} aria-label="Trade side" />
        <SlippageSettings bps={slippageBps} onChange={setSlippageBps} />
      </div>

      {phase === "curve" && <CurvePlate token={token} />}
      {phase === "pool" && <LockedPlate pair={token.asset.symbol} />}

      <div className="mt-5">
        {phase === "curve" && <CurveTrade key={`curve-${side}`} token={token} side={side} slippageBps={slippageBps} />}
        {phase === "pool" && <PoolTrade key={`pool-${side}`} token={token} side={side} slippageBps={slippageBps} />}
        {phase === "graduating" && <Graduating token={token} onDone={refetch} />}
        {phase === "rescued" && (
          <p className="rounded-card border border-border bg-surface-2 px-4 py-3.5 text-sm text-muted">
            This coin could not open its Uniswap pool, and Pons recovered its reserves. Trading is closed.
          </p>
        )}
      </div>
    </Card>
  );
}

/** Before graduation: how far the curve is from moving into its Uniswap pool. */
function CurvePlate({ token }: { token: TokenDetail }) {
  const pct = Math.min(100, token.progressBps / 100);
  return (
    <div className="mt-5 rounded-card border border-border bg-surface-2 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-text">Launch curve</span>
        <span className="text-muted tabular">{formatPct(pct)} to Uniswap</span>
      </div>
      <div
        className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label="Progress to the Uniswap pool"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-13 text-muted">
        Moves to a locked Uniswap pool once the curve raises {formatAsset(token.graduationThreshold, token.asset)}.{" "}
        <Link href="/docs/the-price" className="underline decoration-border underline-offset-4 hover:text-text">
          How it works
        </Link>
      </p>
    </div>
  );
}

/** The curve completed: anyone can open the Uniswap pool (Pons usually does it within seconds). */
function Graduating({ token, onDone }: { token: TokenDetail; onDone: () => void }) {
  const tx = useTx();
  const open = async () => {
    const rc = await tx.run(
      () =>
        tx.writeContractAsync({
          address: PONS_FACTORY,
          abi: ponsFactoryAbi,
          functionName: "createGraduatedPool",
          args: [token.address],
        }),
      { pending: "Opening the pool…", success: "The Uniswap pool is open" },
    );
    if (rc) onDone();
  };
  return (
    <div className="rounded-card border border-border bg-surface-2 px-4 py-4">
      <p className="text-sm font-medium text-text">The launch curve is complete</p>
      <p className="mt-1.5 text-13 text-muted">
        ${token.symbol} is moving into its Uniswap pool. This usually takes a few seconds; anyone can finish it.
      </p>
      <Button
        className="mt-4 w-full"
        loading={tx.status === "confirm" || tx.status === "pending"}
        disabled={!LIVE || tx.status === "confirm" || tx.status === "pending"}
        onClick={() => void open()}
      >
        Open the Uniswap pool
      </Button>
    </div>
  );
}

function LockedPlate({ pair }: { pair: string }) {
  return (
    <div className="mt-5 rounded-card border border-border bg-surface-2 px-4 py-3.5">
      <p className="flex items-center gap-2 text-sm font-medium text-accent-text">
        <TwainMark className="size-3 shrink-0 text-brand" />
        {COPY.token.lockedPlate}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-13 text-muted">
        <span>Trading against {pair} in the Uniswap v4 pool.</span>
        <Link href="/docs/liquidity-lock" className="underline decoration-border underline-offset-4 hover:text-text">
          How the lock works
        </Link>
      </p>
    </div>
  );
}

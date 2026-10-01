"use client";

import { assetToUsd, formatAsset, formatEth, formatUsd, weiToUsd } from "@lancio/shared";
import { useEthUsd } from "@/lib/api";
import { cn } from "@/lib/utils";

/** "$22k" from wei; falls back to the ETH amount while/if the ETH price is unavailable. */
export function UsdAmount({ wei, className }: { wei: bigint | string; className?: string }) {
  const { data } = useEthUsd();
  const usd = data?.usd ?? null;
  return <span className={cn("tabular", className)}>{usd == null ? formatEth(wei) : formatUsd(weiToUsd(wei, usd))}</span>;
}

/** USD value of an amount in the coin's asset ("$1.2k"); the asset amount when the asset has no USD price. */
export function AssetValue({
  amount,
  asset,
  className,
}: {
  amount: bigint | string;
  asset: { decimals: number; symbol: string; usd: number | null };
  className?: string;
}) {
  const usd = assetToUsd(amount, asset.decimals, asset.usd);
  return <span className={cn("tabular", className)}>{usd == null ? formatAsset(amount, asset) : formatUsd(usd)}</span>;
}

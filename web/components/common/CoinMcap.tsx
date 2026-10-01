import { formatAsset, formatUsd, type TokenSummary } from "@lancio/shared";
import { cn } from "@/lib/utils";

/** A coin's market cap in USD, or in its asset when the asset has no USD price. */
export function CoinMcap({ token, className }: { token: Pick<TokenSummary, "mcapUsd" | "mcapAsset" | "asset">; className?: string }) {
  return (
    <span className={cn("tabular", className)}>
      {token.mcapUsd != null ? formatUsd(token.mcapUsd) : formatAsset(token.mcapAsset, token.asset)}
    </span>
  );
}

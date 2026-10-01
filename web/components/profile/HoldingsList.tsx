"use client";

import { assetToUsd, formatAsset, formatTokens, formatUsd, type AssetInfo, type Holding } from "@twain/shared";
import Link from "next/link";
import { AssetIcon, TokenImage } from "@/components/common";

/** Value at the current pool price, in the coin's asset (smallest units): balance × priceX18 / 1e36. */
const valueOf = (h: Holding) => (BigInt(h.balance) * BigInt(h.token.priceX18)) / 10n ** 36n;
const usdOf = (amount: bigint, asset: AssetInfo) => assetToUsd(amount, asset.decimals, asset.usd);

export function HoldingsList({ holdings }: { holdings: Holding[] }) {
  if (holdings.length === 0) return <p className="py-10 text-center text-sm text-muted">No coin balances at this address.</p>;

  const rows = holdings
    .map((h) => {
      const value = valueOf(h);
      return { h, value, usd: usdOf(value, h.token.asset) };
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const priced = rows.filter((r) => r.usd != null);
  const totalUsd = priced.length ? priced.reduce((s, r) => s + r.usd!, 0) : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-13 text-muted">Value at current prices</span>
        <span className="text-xl font-medium text-text tabular">{totalUsd == null ? "—" : formatUsd(totalUsd)}</span>
      </div>

      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-3 pb-2 text-xs text-muted md:grid">
        <span>Coin</span>
        <span className="text-right">Balance</span>
        <span className="text-right">Value</span>
      </div>
      <ul className="divide-y divide-border/70 border-t border-border/70">
        {rows.map(({ h, value, usd }) => (
          <li key={h.token.address}>
            <Link
              href={`/launchpad/${h.token.address}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]"
            >
              <div className="flex min-w-0 items-center gap-3">
                <TokenImage src={h.token.meta.image} alt={h.token.name} seed={h.token.address} size={40} />
                <div className="min-w-0">
                  <span className="block truncate font-medium text-text">{h.token.name}</span>
                  <div className="flex items-center gap-1.5 truncate text-13 text-muted">
                    {h.token.symbol} ·
                    <AssetIcon asset={h.token.asset} size={12} />
                    {h.token.asset.symbol} pair
                  </div>
                </div>
              </div>
              <div className="hidden text-right text-sm text-text tabular md:block">{formatTokens(h.balance)}</div>
              <div className="text-right">
                <div className="text-sm text-text tabular">{usd == null ? formatAsset(value, h.token.asset) : formatUsd(usd)}</div>
                <div className="text-xs text-muted tabular">
                  <span className="md:hidden">{formatTokens(h.balance, h.token.symbol)}</span>
                  {usd != null && (
                    <>
                      <span className="md:hidden"> · </span>
                      {formatAsset(value, h.token.asset)}
                    </>
                  )}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

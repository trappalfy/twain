"use client";

import { COPY, TOTAL_SUPPLY, formatAsset, formatPct, formatTokens, type AssetInfo } from "@lancio/shared";
import { AssetIcon } from "@/components/common";
import { Field } from "@/components/ui";
import { cn } from "@/lib/utils";

/** First buy: amount of the paired asset spent in the launch transaction, with the coins it returns. */
export function DevBuyField({
  value,
  onChange,
  onMax,
  balance,
  expected,
  symbol,
  asset,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onMax: () => void;
  balance: bigint;
  /** Coins the first buy returns (0n when empty). */
  expected: bigint;
  symbol: string;
  asset: AssetInfo;
  disabled?: boolean;
}) {
  const pct = Number((expected * 1_000_000n) / TOTAL_SUPPLY) / 10_000;
  const decimalRe = new RegExp(`^\\d*\\.?\\d{0,${asset.decimals}}$`);
  return (
    <Field label="First buy" htmlFor="dev-buy">
      <div
        className={cn(
          "rounded-2xl border border-border bg-surface-2 px-4 py-3 transition-colors focus-within:border-accent",
          disabled && "opacity-60",
        )}
      >
        <div className="flex items-center gap-3">
          <input
            id="dev-buy"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value.replace(",", ".");
              if (decimalRe.test(v)) onChange(v);
            }}
            className="min-w-0 flex-1 bg-transparent text-28 font-medium text-text outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={onMax}
            disabled={disabled}
            className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-text"
          >
            Max
          </button>
          <span className="flex items-center gap-1.5 text-sm font-medium text-text">
            <AssetIcon asset={asset} size={18} />
            {asset.symbol}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-13">
          <span className="text-muted">{COPY.create.devBuyHelper(formatAsset(balance, asset))}</span>
          {expected > 0n && (
            <span className="text-text">
              {formatTokens(expected, symbol || "coins")} · {formatPct(pct)} of supply
            </span>
          )}
        </div>
      </div>
    </Field>
  );
}

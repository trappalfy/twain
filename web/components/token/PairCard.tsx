"use client";

import { explorerToken, formatTiny, type TokenDetail } from "@twain/shared";
import { ArrowUpRight } from "lucide-react";
import { AssetIcon } from "@/components/common";
import { Card } from "@/components/ui";

const KIND: Record<TokenDetail["asset"]["kind"], string> = {
  native: "Native ETH",
  stock: "Robinhood stock token",
  token: "Token",
};

/** The asset the coin is paired with: every trade is priced and settled in it. */
export function PairCard({ token }: { token: TokenDetail }) {
  const a = token.asset;
  return (
    <Card>
      <p className="text-13 text-muted">Paired with</p>
      <div className="mt-3 flex items-center gap-3">
        <AssetIcon asset={a} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium text-text">
            {a.name} <span className="text-muted">{a.symbol}</span>
          </p>
          <p className="text-13 text-muted">{KIND[a.kind]}</p>
        </div>
        <div className="text-right">
          <p className="text-base font-medium text-text tabular">{a.usd != null ? `$${formatTiny(a.usd)}` : "—"}</p>
          {a.kind !== "native" && (
            <a
              href={explorerToken(a.address)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-13 text-muted underline decoration-border underline-offset-4 hover:text-text"
            >
              Contract
              <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

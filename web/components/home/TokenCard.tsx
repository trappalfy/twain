"use client";

import { formatPct, shortAddress, type TokenSummary } from "@twain/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { AssetIcon, CoinMcap, TimeAgo, TokenImage } from "@/components/common";
import { Badge, Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

const NEW_SECONDS = 3600;
const LAST_BUY_FRESH_SECONDS = 60;
const IMAGE_SIZES = "(min-width: 1280px) 220px, (min-width: 1024px) 25vw, (min-width: 768px) 33vw, (min-width: 480px) 50vw, 100vw";

export const tokenHref = (t: Pick<TokenSummary, "address">) => `/launchpad/${t.address}`;

/**
 * Card shell: the whole card is clickable through the name link stretched over it (after:inset-0),
 * so badges stay separate elements (no interactive content nested in <a>).
 */
function CardShell({ token, badges, children }: { token: TokenSummary; badges?: ReactNode; children: ReactNode }) {
  return (
    <article className="group relative flex flex-col rounded-card bg-surface-2 p-2.5 transition-[box-shadow,translate] duration-150 focus-within:ring-2 focus-within:ring-accent hover:-translate-y-0.5 hover:shadow-pop motion-reduce:hover:translate-y-0">
      <div className="relative aspect-square w-full overflow-hidden rounded-image">
        <TokenImage src={token.meta.image} alt="" seed={token.address} size="fill" sizes={IMAGE_SIZES} />
        {badges && <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">{badges}</div>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col px-1.5 pt-3 pb-1">
        <h3 className="truncate text-base font-medium text-text">
          <Link href={tokenHref(token)} className="outline-none after:absolute after:inset-0 after:rounded-card after:content-['']">
            {token.name}
          </Link>
        </h3>
        <p className="truncate text-13 text-muted">${token.symbol}</p>
        {children}
      </div>
    </article>
  );
}

function Mcap({ token }: { token: TokenSummary }) {
  return (
    <p className="mt-2 flex items-baseline gap-1.5">
      <CoinMcap token={token} className="text-lg font-semibold text-text" />
      <span className="text-xs text-muted">MC</span>
    </p>
  );
}

/** Explore card: image, badges, name, $TICKER, market cap, pair and 24h change, address, last buy. */
export function TokenCard({ token, now }: { token: TokenSummary; now: number }) {
  const isNew = now - token.createdAt < NEW_SECONDS;
  const change = token.change24hPct;
  return (
    <CardShell token={token} badges={isNew ? <Badge variant="new">New</Badge> : undefined}>
      <Mcap token={token} />
      <div className="mt-2.5 flex items-center justify-between gap-2 text-13">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted" title={`Paired with ${token.asset.name}`}>
          <AssetIcon asset={token.asset} size={14} />
          <span className="truncate">{token.asset.symbol} pair</span>
        </span>
        <span className={cn("tabular", change == null ? "text-muted" : change > 0 ? "text-buy" : change < 0 ? "text-sell" : "text-muted")}>
          {change == null ? "—" : formatPct(change, { sign: true })}
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-13">
        <span className="font-mono text-muted" title={token.address}>
          {shortAddress(token.address)}
        </span>
        <TimeAgo ts={token.lastBuyAt} freshSeconds={LAST_BUY_FRESH_SECONDS} className="text-13" />
      </div>
    </CardShell>
  );
}

export function TokenCardSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col rounded-card bg-surface-2 p-2.5", className)}>
      <Skeleton className="aspect-square w-full rounded-image bg-border/60" />
      <div className="px-1.5 pt-3 pb-1">
        <Skeleton className="h-5 w-2/3 bg-border/60" />
        <Skeleton className="mt-1.5 h-4 w-1/3 bg-border/60" />
        <Skeleton className="mt-3 h-6 w-1/2 bg-border/60" />
        <Skeleton className="mt-3 h-4 w-full bg-border/60" />
        <Skeleton className="mt-3 h-4 w-full bg-border/60" />
      </div>
    </div>
  );
}

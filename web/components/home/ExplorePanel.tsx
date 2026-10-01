"use client";

import { COPY } from "@twain/shared";
import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { AssetIcon } from "@/components/common";
import { Button, Card, CardHeader, CountPill, EmptyState, Pagination, PillTabs } from "@/components/ui";
import { useAssets, useStats, useTokens } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EXPLORE_PANEL_ANCHOR, exploreHref, GRID, PAGE_SIZE, SORTS, WINDOWS, type ExploreState } from "./query";
import { TokenCard, TokenCardSkeleton } from "./TokenCard";

export function ExplorePanel({ state }: { state: ExploreState }) {
  const { sort, window, asset, page } = state;
  const { data, isPending, isError, isPlaceholderData, dataUpdatedAt } = useTokens({ asset, sort, window, page, pageSize: PAGE_SIZE });
  const launched = useStats("all").data?.launches;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // Asset filter: only assets with coins (and the one selected, even if it has none).
  const pairs = (useAssets().data ?? []).filter((a) => a.coins > 0 || a.address === asset);
  const selected = pairs.find((a) => a.address === asset);
  const now = Math.floor(dataUpdatedAt / 1000); // "New" badge reference time, refreshed with every poll

  // Page links keep the scroll position; bring the top of the list back into view when the page changes.
  const prevPage = useRef(page);
  useEffect(() => {
    if (prevPage.current === page) return;
    prevPage.current = page;
    const el = document.getElementById(EXPLORE_PANEL_ANCHOR);
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  }, [page]);

  const tabs = (
    <>
      <div className="-mx-5 max-w-[calc(100%+2.5rem)] overflow-x-auto px-5 [scrollbar-width:none] lg:mx-0 lg:max-w-none lg:px-0">
        <PillTabs
          aria-label="Sort"
          size="sm"
          items={SORTS.map((s) => ({ href: exploreHref({ ...state, sort: s.value, page: 1 }), label: s.label, active: s.value === sort }))}
        />
      </div>
      <PillTabs
        aria-label="Time window"
        size="sm"
        items={WINDOWS.map((w) => ({ href: exploreHref({ ...state, window: w.value, page: 1 }), label: w.label, active: w.value === window }))}
      />
    </>
  );
  const assetTabs = pairs.length > 1 && (
    <div className="mt-5 -mx-5 overflow-x-auto px-5 [scrollbar-width:none] lg:mx-0 lg:px-0">
      <PillTabs
        aria-label="Paired with"
        size="sm"
        items={[
          { href: exploreHref({ ...state, asset: "all", page: 1 }), label: "All pairs", active: asset === "all" },
          ...pairs.map((a) => ({
            href: exploreHref({ ...state, asset: a.address, page: 1 }),
            label: (
              <span className="inline-flex items-center gap-1.5">
                <AssetIcon asset={a} size={14} />
                {a.symbol}
              </span>
            ),
            active: a.address === asset,
          })),
        ]}
      />
    </div>
  );

  return (
    <Card id={EXPLORE_PANEL_ANCHOR} as="section" aria-labelledby="explore-title" className="scroll-mt-[calc(var(--header-h)+16px)]">
      <CardHeader
        title={<span id="explore-title">{COPY.explore.title}</span>}
        count={launched != null ? <CountPill>{launched.toLocaleString("en-US")} launched</CountPill> : undefined}
        subtitle={COPY.explore.subtitle}
        actions={tabs}
      />

      {assetTabs}

      <div className="mt-6 md:mt-8">
        {isPending ? (
          <div className={GRID} aria-busy="true">
            {Array.from({ length: 10 }, (_, i) => (
              <TokenCardSkeleton key={i} />
            ))}
          </div>
        ) : isError && !data ? (
          <p className="py-12 text-center text-sm text-muted">Coins could not be loaded. Retrying.</p>
        ) : !data || data.items.length === 0 ? (
          page > 1 && data && data.total > 0 ? (
            <EmptyState
              title="This page is past the end of the list."
              action={
                <Button href={exploreHref({ ...state, page: 1 })} variant="outline">
                  Back to page 1
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={
                !launched
                  ? COPY.explore.empty
                  : selected
                    ? `No coins paired with ${selected.symbol}${window !== "all" ? " in this window" : ""} yet.`
                    : "No coins in this window."
              }
              action={
                <Button href="/launchpad/create">
                  <Plus size={16} aria-hidden />
                  Create
                </Button>
              }
            />
          )
        ) : (
          <ul className={cn(GRID, "transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData || undefined}>
            {data.items.map((t) => (
              <li key={t.address} className="flex flex-col [&>article]:flex-1">
                <TokenCard token={t} now={now} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {data && totalPages > 1 && (
        <Pagination className="mt-8" page={Math.min(page, totalPages)} totalPages={totalPages} hrefFor={(p) => exploreHref({ ...state, page: p })} />
      )}
    </Card>
  );
}

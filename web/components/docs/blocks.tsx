/**
 * Building blocks for docs MDX (content/docs/*.mdx). Server components only.
 * Protocol numbers come from @twain/shared — never typed in by hand here.
 */
import {
  EXPLORER_URL,
  PARAMS,
  POOL_FEE_PIPS,
  POOL_LP_FEE,
  TOTAL_SUPPLY,
  UNISWAP_V4,
  WAD,
  explorerAddress,
  formatEth,
  formatTokens,
  mcapFromPriceX18,
  quoteFromStart,
  splitFee,
  startPriceX18,
} from "@twain/shared";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { zeroAddress } from "viem";
import { CopyButton } from "@/components/common/CopyButton";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ layout blocks */

/** Highlighted note. Markdown inside works when separated by blank lines. */
export function Callout({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <aside className="my-8 rounded-card border border-border bg-surface-2 px-5 py-4 md:px-6 md:py-5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
      {title && <p className="text-sm font-semibold text-accent-text">{title}</p>}
      <div className="text-base leading-7 text-text/90">{children}</div>
    </aside>
  );
}

/** Diagram / image with caption (unfiltered — for charts, not paintings). */
export function Figure({ src, alt, width, height, caption }: { src: string; alt: string; width: number; height: number; caption?: ReactNode }) {
  return (
    <figure className="my-8">
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes="(min-width: 1024px) 768px, 100vw"
        className="h-auto w-full rounded-card border border-border"
      />
      {caption && <figcaption className="mt-3 text-sm leading-6 text-muted">{caption}</figcaption>}
    </figure>
  );
}

/** Label / value rows in a framed list. */
export function Facts({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("my-6 divide-y divide-border rounded-card border border-border", className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 md:px-5">
          <dt className="text-sm text-muted">{k}</dt>
          <dd className="text-sm font-medium text-text sm:text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Simple table (MDX has no GFM tables here). */
export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="my-6 overflow-x-auto rounded-card border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={cn("whitespace-nowrap border-b border-border px-4 py-3 font-medium text-muted", i === 0 ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((c, j) => (
                <td key={j} className={cn("px-4 py-3", j === 0 ? "text-left text-text" : "whitespace-nowrap text-right font-medium text-text")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** FAQ entry: native <details>, no client JS. */
export function Question({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border last:border-0 [&_p]:my-2 [&_p]:text-sm [&_p]:leading-6 [&_p]:text-muted">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-base font-medium text-text [&::-webkit-details-marker]:hidden">
        {q}
        <ChevronDown size={18} className="shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="pb-4 text-sm leading-6 text-muted">{children}</div>
    </details>
  );
}

export function QuestionList({ children }: { children: ReactNode }) {
  return <div className="my-6 rounded-card border border-border px-4 md:px-5">{children}</div>;
}

/* ------------------------------------------------------------------ protocol numbers */

const coins = (units: bigint) => `${formatTokens(units)} coins`;

/** ETH's start tick at the default start market cap (2.73 ETH, rounded down to the pool's price grid). */
const ETH_START_TICK = -197_200;

/** Every rule on one card (docs index). */
export function RulesTable() {
  return (
    <Facts
      rows={[
        ["Supply per coin", `${PARAMS.supply}, minted once`],
        ["Presale, team share, allocations", "None"],
        ["Where it trades", "Its own Uniswap v4 pool, from the launch transaction on"],
        ["Pool pair", "The coin and the asset its creator picked"],
        ["Liquidity", "The whole supply, locked forever"],
        ["Price", "x · y = k from the asset's start market cap"],
        ["Pool fee", `${PARAMS.poolFeePct} per trade: ${PARAMS.creatorFeePct} creator, ${PARAMS.protocolFeePct} protocol`],
        ["First buy", "Optional, by the creator, in the launch transaction"],
        ["Launch fee", `${PARAMS.launchFeeEth} ETH, gas only`],
      ]}
    />
  );
}

/** What a buy does to price and market cap, for a coin paired with ETH (start market cap ≈ 2.73 ETH). */
export function PriceTable() {
  const startMcap = mcapFromPriceX18(startPriceX18(ETH_START_TICK));
  const fee = (x: bigint) => (x * BigInt(POOL_LP_FEE) + POOL_FEE_PIPS - 1n) / POOL_FEE_PIPS;
  const rows = [WAD / 10n, WAD, 5n * WAD, 20n * WAD].map((spent) => {
    const out = quoteFromStart(ETH_START_TICK, spent);
    const vAsset = startMcap + spent - fee(spent);
    // x·y = k with (start mcap, supply): market cap = vAsset² / start mcap.
    const mcap = (vAsset * vAsset) / startMcap;
    const share = Number((out * 10_000n) / TOTAL_SUPPLY) / 100;
    return [formatEth(spent), `${coins(out)} (${share.toFixed(1)}%)`, `≈ ${formatEth(mcap)}`];
  });
  return <Table head={["First buy into a fresh ETH pair", "Coins out", "Market cap after"]} rows={rows} />;
}

/** What every pool looks like at launch. */
export function PoolParams() {
  return (
    <Facts
      rows={[
        ["Venue", "Uniswap v4 on Robinhood Chain"],
        ["Pair", "Coin / the asset picked at launch"],
        ["Liquidity", `${PARAMS.supply} coins, one position from the start price to the end of the range`],
        ["Asset in the pool at launch", "None: buyers bring it"],
        ["Pool fee", `${PARAMS.poolFeePct} per swap, fixed`],
        ["Hook", "None: a plain pool any router can trade"],
        ["Who opens the pool", "The launchpad, in the launch transaction"],
      ]}
    />
  );
}

/** Fee examples in a coin's paired asset (ETH here). */
export function FeeExamples() {
  const fee = (volume: bigint) => splitFee((volume * BigInt(POOL_LP_FEE)) / POOL_FEE_PIPS);
  return (
    <Table
      head={["Trading volume", "Pool fee", "Creator", "Protocol"]}
      rows={[WAD, 10n * WAD, 100n * WAD].map((v) => {
        const f = fee(v);
        return [formatEth(v), formatEth(f.creatorFee + f.protocolFee), formatEth(f.creatorFee), formatEth(f.protocolFee)];
      })}
    />
  );
}

/* ------------------------------------------------------------------ contracts */

type ContractRow = { name: string; role: string; address: string };

const LAUNCHPAD_CONTRACTS: ContractRow[] = [
  {
    name: "Launchpad",
    role: "Creates coins, opens their pools, keeps the asset list and the creator and protocol fee balances.",
    address: config.deployment.launchpad,
  },
  {
    name: "LiquidityLocker",
    role: "Owns every coin's pool position. It can only collect fees: there is no withdraw function.",
    address: config.deployment.locker,
  },
];

const UNISWAP_CONTRACTS: ContractRow[] = [
  { name: "PoolManager", role: "Holds every Uniswap v4 pool, including every coin's.", address: UNISWAP_V4.poolManager },
  { name: "Universal Router", role: "Executes the site's swaps.", address: UNISWAP_V4.universalRouter },
  { name: "V4 Quoter", role: "Quotes pool swaps before you sign.", address: UNISWAP_V4.quoter },
  { name: "StateView", role: "Reads pool prices and liquidity.", address: UNISWAP_V4.stateView },
  { name: "Permit2", role: "Approvals for swaps that pay with a token (selling a coin, buying with a stock token).", address: UNISWAP_V4.permit2 },
];

/** Contract addresses with Blockscout links. Launchpad addresses come from config (env). */
export function ContractList({ group }: { group: "launchpad" | "uniswap" }) {
  const rows = group === "launchpad" ? LAUNCHPAD_CONTRACTS : UNISWAP_CONTRACTS;
  return (
    <ul className="my-6 divide-y divide-border rounded-card border border-border">
      {rows.map((c) => {
        const deployed = c.address.toLowerCase() !== zeroAddress;
        return (
          <li key={c.name} className="flex flex-col gap-2 px-4 py-4 md:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-base font-medium text-text">{c.name}</span>
              {deployed && (
                <a
                  href={explorerAddress(c.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-accent-text hover:underline underline-offset-4"
                >
                  Blockscout <ArrowUpRight size={14} aria-hidden />
                </a>
              )}
            </div>
            <p className="text-sm text-muted">{c.role}</p>
            {deployed ? (
              <div className="flex items-center gap-1">
                <code className="break-all font-mono text-13 text-text">{c.address}</code>
                <CopyButton value={c.address} label={`Copy ${c.name} address`} className="shrink-0" />
              </div>
            ) : (
              <p className="text-sm text-muted">Published here once the contracts are deployed.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Chain line under the contract lists. */
export function ChainInfo() {
  return (
    <Facts
      rows={[
        ["Network", "Robinhood Chain"],
        ["Chain ID", String(config.chainId)],
        [
          "Explorer",
          <a key="x" href={EXPLORER_URL} target="_blank" rel="noreferrer" className="text-accent-text underline underline-offset-4 hover:no-underline">
            {EXPLORER_URL.replace(/^https:\/\//, "")}
          </a>,
        ],
      ]}
    />
  );
}

/**
 * Building blocks for docs MDX (content/docs/*.mdx). Server components only.
 * Protocol numbers come from @twain/shared or are computed here from it — never typed into the MDX by hand.
 */
import {
  BASIS_POINTS,
  CREATOR_FEE_SHARE,
  CREATOR_TAX_BPS,
  type CurveState,
  EXPLORER_URL,
  PARAMS,
  PONS_FEE_BPS,
  PONS_POOL_FEE,
  PONS_PROTOCOL_SHARE_BPS,
  PONS_TICK_SPACING,
  PONS_V2,
  PROTOCOL_FEE_SHARE,
  TOTAL_SUPPLY,
  TOTAL_SUPPLY_WHOLE,
  UNISWAP_V4,
  VAULT_SHARE_BPS,
  WAD,
  applyCurveBuy,
  curvePriceX18,
  explorerAddress,
  formatEth,
  formatTokens,
  quoteCurveBuy,
  reservedTokens,
  snipeTaxBps,
} from "@twain/shared";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
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

/**
 * Pons V2 terms behind the ETH examples, as the factory had them on 2026-10-02 (launch config 0 for an ETH pair:
 * phantomQuote 1.68 ETH, graduationThreshold 4.2 ETH; snipeTaxStartBps 9,900 over snipeTaxSeconds 3). Pons can change
 * them for new launches; a coin keeps the terms it launched with, and the Create page reads the live ones.
 */
const ETH_PHANTOM = (168n * WAD) / 100n;
const ETH_THRESHOLD = (42n * WAD) / 10n;
const SNIPE_START_BPS = 9_900n;
const SNIPE_SECONDS = 3n;

/** Pons V2 launch locker: `locker()` of the factory (read onchain 2026-10-02). */
const PONS_LAUNCH_LOCKER = "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952";

const pct = (bps: bigint) => `${Number(bps) / 100}%`;
const shareOf = (part: bigint, whole: bigint) => `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(1)}%`;
const coins = (units: bigint) => `${formatTokens(units)} coins`;
/** Whole-supply market cap at the curve's current price, in the asset's smallest units. */
const mcapOf = (quoteReserve: bigint, tokenReserve: bigint) => (curvePriceX18(quoteReserve, tokenReserve) * TOTAL_SUPPLY_WHOLE) / WAD;

const ETH_RESERVED = reservedTokens(TOTAL_SUPPLY, ETH_PHANTOM, ETH_THRESHOLD);
const ETH_SELLABLE = TOTAL_SUPPLY - ETH_RESERVED;
const ETH_CURVE: CurveState = {
  quoteReserve: ETH_PHANTOM,
  tokenReserve: TOTAL_SUPPLY,
  reserved: ETH_RESERVED,
  feeBps: PONS_FEE_BPS,
  taxBps: CREATOR_TAX_BPS,
};
/** When the allocation is sold out the curve holds phantom + threshold against the reserved coins. */
const ETH_GRAD_MCAP = mcapOf(ETH_PHANTOM + ETH_THRESHOLD, ETH_RESERVED);
/** Coins that match the raised asset at the curve's last price (PonsV2LaunchFactory._poolTokenAmount); the rest is locked. */
const ETH_POOL_COINS = (ETH_RESERVED * ETH_THRESHOLD) / (ETH_THRESHOLD + ETH_PHANTOM);
const ETH_LOCKED_COINS = ETH_RESERVED - ETH_POOL_COINS;

/** Snipe tax a buy pays `elapsed` whole seconds after launch, capped as the curve caps it (fee + tax + 1% stay payable). */
const snipeAt = (elapsed: bigint) => {
  const bps = snipeTaxBps(elapsed, SNIPE_START_BPS, SNIPE_SECONDS);
  const max = BASIS_POINTS - PONS_FEE_BPS - CREATOR_TAX_BPS - 100n;
  return bps > max ? max : bps;
};

/** Split of a trade's fees: what Pons keeps, what reaches the coin's vault, and the vault's 60/40 split. */
function feeParts(volume: bigint) {
  const total = (volume * (PONS_FEE_BPS + CREATOR_TAX_BPS)) / BASIS_POINTS;
  const vault = (volume * VAULT_SHARE_BPS) / BASIS_POINTS;
  const creator = (vault * CREATOR_FEE_SHARE) / 100n;
  return { total, pons: total - vault, vault, creator, twain: vault - creator };
}

/** Numbers for docs prose, all derived from the shared constants above (`{NUM.vault}` in MDX). */
export const NUM = {
  /** Share of the Pons fee Pons keeps / passes to the coin's vault. */
  ponsKeepsOfFee: pct(PONS_PROTOCOL_SHARE_BPS),
  vaultGetsOfFee: pct(BASIS_POINTS - PONS_PROTOCOL_SHARE_BPS),
  /** Shares of trading volume. */
  ponsKeeps: pct((PONS_FEE_BPS * PONS_PROTOCOL_SHARE_BPS) / BASIS_POINTS),
  vault: pct(VAULT_SHARE_BPS),
  /** The vault's split. */
  creatorSplit: `${CREATOR_FEE_SHARE}%`,
  twainSplit: `${PROTOCOL_FEE_SHARE}%`,
  /** ETH pair today. */
  ethStartMcap: formatEth(ETH_PHANTOM),
  ethRaise: formatEth(ETH_THRESHOLD),
  ethGradMcap: formatEth(ETH_GRAD_MCAP),
  ethSellable: shareOf(ETH_SELLABLE, TOTAL_SUPPLY),
  ethReserved: shareOf(ETH_RESERVED, TOTAL_SUPPLY),
  ethLocked: shareOf(ETH_LOCKED_COINS, TOTAL_SUPPLY),
  /** Snipe tax in the launch second. */
  snipeStart: pct(snipeAt(0n)),
} as const;

/** Every rule on one card (docs index). */
export function RulesTable() {
  return (
    <Facts
      rows={[
        ["Supply per coin", `${PARAMS.supply}, minted once, all of it to the launch curve`],
        ["Presale, team share, allocations", "None"],
        ["Launched through", "twain's launcher, on the Pons V2 launch factory"],
        ["Pair", "ETH or an asset Pons accepts, picked at launch, fixed for good"],
        ["First", "A launch curve: x · y = k from the pair's start market cap"],
        ["Then", "A Uniswap v4 pool, its liquidity locked forever"],
        ["Fee per trade", `${PARAMS.tradeFeePct}: ${PARAMS.ponsFeePct} Pons fee + ${PARAMS.creatorTaxPct} creator tax`],
        ["Creator earns", `${PARAMS.creatorEarnsPct} of trading volume, in the pair asset`],
        ["Snipe tax", `On buys in the first ${PARAMS.snipeWindow}, falling to zero`],
        ["First buy", "Optional, by the creator, in the launch transaction, no snipe tax"],
        ["Launch fee", "Pons' fee in ETH, shown in the form before you sign"],
      ]}
    />
  );
}

/** The launch curve of a coin paired with ETH, on today's Pons terms. */
export function CurveFacts() {
  return (
    <Facts
      rows={[
        ["Start market cap", `${NUM.ethStartMcap} for the whole supply`],
        ["For sale on the curve", `${coins(ETH_SELLABLE)} (${NUM.ethSellable} of supply)`],
        ["Kept back for the pool", `${coins(ETH_RESERVED)} (${NUM.ethReserved})`],
        ["The curve completes when it has raised", `${NUM.ethRaise}, after fees`],
        ["Market cap at that point", `≈ ${NUM.ethGradMcap}`],
        ["Fee per trade", PARAMS.tradeFeePct],
      ]}
    />
  );
}

/** What one buy does to a fresh ETH curve: coins out, share of supply, market cap after. */
export function FirstBuyTable() {
  const row = (quoteIn: bigint, label?: string) => {
    const q = quoteCurveBuy(ETH_CURVE, quoteIn);
    const after = applyCurveBuy(ETH_CURVE, q.spent, q.tokensOut, q.fee + q.snipeTax, q.tax);
    return [label ?? formatEth(quoteIn), coins(q.tokensOut), shareOf(q.tokensOut, TOTAL_SUPPLY), `≈ ${formatEth(mcapOf(after.quoteReserve, after.tokenReserve))}`];
  };
  // Asking for more than the curve holds buys the whole allocation; the curve refunds the rest.
  const all = quoteCurveBuy(ETH_CURVE, 2n * ETH_THRESHOLD);
  return (
    <Table
      head={["First buy into a fresh ETH curve", "Coins out", "Share of supply", "Market cap after"]}
      rows={[
        row(WAD / 10n),
        row(WAD / 2n),
        row(WAD),
        row(2n * WAD),
        row(all.spent, `${formatEth(all.spent)}: the whole allocation`),
      ]}
    />
  );
}

/** The snipe tax by whole seconds since the launch transaction's block. */
export function SnipeTaxTable() {
  const rows: ReactNode[][] = [];
  for (let s = 0n; s <= SNIPE_SECONDS; s++) {
    const label = s === 0n ? "In the launch second" : s === SNIPE_SECONDS ? `${s} seconds later and after` : `${s} second${s === 1n ? "" : "s"} later`;
    const bps = snipeAt(s);
    rows.push([label, bps === 0n ? "None" : `${pct(bps)} of the buy`]);
  }
  return <Table head={["A buy that lands", "Snipe tax, on top of the fees"]} rows={rows} />;
}

/** What a graduating ETH curve puts into its Uniswap pool. */
export function GraduationFacts() {
  return (
    <Facts
      rows={[
        ["Asset into the pool", `${NUM.ethRaise}: everything the curve raised`],
        ["Coins into the pool", `${coins(ETH_POOL_COINS)} (${shareOf(ETH_POOL_COINS, TOTAL_SUPPLY)} of supply)`],
        ["Coins locked outside the pool", `${coins(ETH_LOCKED_COINS)} (${NUM.ethLocked})`],
        ["Pool opens at", `The curve's last price, ≈ ${NUM.ethGradMcap} market cap`],
        ["Position", "Full range, minted to Pons' launch locker"],
      ]}
    />
  );
}

/** What every graduated pool looks like. */
export function PoolParams() {
  return (
    <Facts
      rows={[
        ["Venue", "Uniswap v4 on Robinhood Chain"],
        ["Pair", "The coin and the asset picked at launch"],
        ["Liquidity", "One full-range position, locked forever"],
        ["Hook", `The Pons meme hook, which charges the ${PARAMS.tradeFeePct} fee on every swap`],
        ["Pool fee to liquidity providers", PONS_POOL_FEE === 0 ? "None" : `${PONS_POOL_FEE / 10_000}%`],
        ["Tick spacing", String(PONS_TICK_SPACING)],
        ["Who opens the pool", "Pons' factory, once the curve completes; anyone can trigger it"],
      ]}
    />
  );
}

/** Where a trade's fees go, as shares of trading volume. */
export function FeeSplit() {
  return (
    <Facts
      rows={[
        [`${PARAMS.ponsFeePct} Pons fee`, `${NUM.ponsKeepsOfFee} kept by Pons, ${NUM.vaultGetsOfFee} to the coin's fee vault`],
        [`${PARAMS.creatorTaxPct} creator tax`, "All of it to the coin's fee vault"],
        ["The fee vault receives", `${NUM.vault} of volume, split ${PARAMS.feeSplit}`],
        ["The creator earns", `${PARAMS.creatorEarnsPct} of volume`],
        ["twain earns", `${PARAMS.twainEarnsPct} of volume`],
        ["Pons keeps", `${NUM.ponsKeeps} of volume`],
      ]}
    />
  );
}

/** Fee examples in a coin's pair asset (ETH here). */
export function FeeExamples() {
  return (
    <Table
      head={["Trading volume", `Fees (${PARAMS.tradeFeePct})`, "Creator", "twain", "Pons"]}
      rows={[WAD, 10n * WAD, 100n * WAD].map((v) => {
        const f = feeParts(v);
        return [formatEth(v), formatEth(f.total), formatEth(f.creator), formatEth(f.twain), formatEth(f.pons)];
      })}
    />
  );
}

/* ------------------------------------------------------------------ contracts */

type ContractRow = { name: string; role: string; address: string | null; note?: ReactNode };

const TWAIN_CONTRACTS: ContractRow[] = [
  {
    name: "TwainLauncher",
    role: "Launches every twain coin through Pons V2, creates its fee vault and makes the creator's optional first buy, all in one transaction. It holds no funds between transactions.",
    address: config.deployment.launcher,
  },
  {
    name: "TwainFeeVault",
    role: `One per coin, created at launch: the coin's creator fee recipient at Pons. It splits what it receives ${PARAMS.feeSplit} between the creator and twain. No owner, no upgrade path.`,
    address: null,
    note: (
      <>
        Each coin has its own. The address is on the coin&apos;s page, in the About tab.{" "}
        <Link href="/#explore-panel" className="text-accent-text underline underline-offset-4 hover:no-underline">
          Find a coin
        </Link>
      </>
    ),
  },
];

const PONS_CONTRACTS: ContractRow[] = [
  {
    name: "Launch factory",
    role: "Creates every coin and its launch curve, moves a completed curve into its Uniswap pool, and keeps the launch terms and the list of pair assets.",
    address: PONS_V2.factory,
  },
  {
    name: "Fee escrow",
    role: "Holds the fees owed to each recipient, including every twain fee vault, until they are claimed.",
    address: PONS_V2.feeEscrow,
  },
  {
    name: "Meme hook",
    role: "The hook on every graduated pool. It charges the fee on each swap and credits its parts.",
    address: PONS_V2.memeHook,
  },
  {
    name: "Launch locker",
    role: "Holds every graduated pool position and the coins kept back from it. It has no withdraw function.",
    address: PONS_LAUNCH_LOCKER,
  },
];

const UNISWAP_CONTRACTS: ContractRow[] = [
  { name: "PoolManager", role: "Holds every Uniswap v4 pool, including every graduated coin's.", address: UNISWAP_V4.poolManager },
  { name: "Universal Router", role: "Executes the site's pool swaps.", address: UNISWAP_V4.universalRouter },
  { name: "V4 Quoter", role: "Quotes pool swaps before you sign.", address: UNISWAP_V4.quoter },
  { name: "StateView", role: "Reads pool prices and liquidity.", address: UNISWAP_V4.stateView },
  { name: "Permit2", role: "Approvals for pool swaps that pay with a token (selling a coin, buying with a stock token).", address: UNISWAP_V4.permit2 },
];

const GROUPS = { twain: TWAIN_CONTRACTS, pons: PONS_CONTRACTS, uniswap: UNISWAP_CONTRACTS };

/** Contract addresses with Blockscout links. The launcher address comes from config (env); "—" until it is deployed. */
export function ContractList({ group }: { group: keyof typeof GROUPS }) {
  return (
    <ul className="my-6 divide-y divide-border rounded-card border border-border">
      {GROUPS[group].map((c) => {
        const address = c.address && c.address.toLowerCase() !== zeroAddress ? c.address : null;
        return (
          <li key={c.name} className="flex flex-col gap-2 px-4 py-4 md:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-base font-medium text-text">{c.name}</span>
              {address && (
                <a
                  href={explorerAddress(address)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-accent-text hover:underline underline-offset-4"
                >
                  Blockscout <ArrowUpRight size={14} aria-hidden />
                </a>
              )}
            </div>
            <p className="text-sm text-muted">{c.role}</p>
            {address ? (
              <div className="flex items-center gap-1">
                <code className="break-all font-mono text-13 text-text">{address}</code>
                <CopyButton value={address} label={`Copy ${c.name} address`} className="shrink-0" />
              </div>
            ) : c.note ? (
              <p className="text-sm text-muted">{c.note}</p>
            ) : (
              <p className="font-mono text-13 text-muted">—</p>
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

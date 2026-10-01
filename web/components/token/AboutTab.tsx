import { COPY, formatAsset, mcapFromPriceX18, PARAMS, shortAddress, type TokenDetail } from "@twain/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { AddressLink, CopyButton } from "@/components/common";
import { config } from "@/lib/config";
import { isZeroAddress } from "./links";

export function AboutTab({ token }: { token: TokenDetail }) {
  const { launchpad, locker } = config.deployment;
  const params: [string, ReactNode][] = [
    ["Paired with", `${token.asset.name} (${token.asset.symbol})`],
    ["Total supply", `${PARAMS.supply} · no allocations, all of it in the pool`],
    ["Start market cap", formatAsset(mcapFromPriceX18(BigInt(token.startPriceX18)), token.asset)],
    ["Pool fee", `${PARAMS.poolFeePct} of every trade · ${PARAMS.creatorFeePct} creator, ${PARAMS.protocolFeePct} protocol`],
    ["Liquidity", "Locked forever"],
  ];
  const contracts: [string, ReactNode][] = [
    ["Coin", <AddressLink key="t" address={token.address} kind="token" copy />],
    ...(token.asset.kind === "native"
      ? []
      : ([["Asset", <AddressLink key="a" address={token.asset.address} kind="token" copy />]] as [string, ReactNode][])),
    ["Creator", <AddressLink key="c" address={token.creator} href={`/profile/${token.creator}`} copy />],
    ["Launchpad", isZeroAddress(launchpad) ? "—" : <AddressLink key="l" address={launchpad} copy />],
    ["Locker", isZeroAddress(locker) ? "—" : <AddressLink key="k" address={locker} copy />],
  ];
  if (token.poolId)
    contracts.push([
      "Uniswap v4 pool ID",
      <span key="p" className="inline-flex items-center gap-1">
        <span className="font-mono text-13 text-muted" title={token.poolId}>
          {shortAddress(token.poolId, 10, 8)}
        </span>
        <CopyButton value={token.poolId} label="Copy pool ID" />
      </span>,
    ]);
  contracts.push(["Launched at block", <span key="b" className="tabular">{token.createdBlock.toLocaleString("en-US")}</span>]);

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-base font-semibold text-text">Description</h3>
        <p className="mt-2 max-w-2xl text-sm break-words whitespace-pre-line text-muted">
          {token.meta.description?.trim() || "The creator did not add a description."}
        </p>
      </section>

      <section>
        <h3 className="text-base font-semibold text-text">Parameters</h3>
        <p className="mt-1 text-13 text-muted">The same rules for every coin, fixed in the contracts. The start market cap is set per asset.</p>
        <Rows rows={params} />
      </section>

      <section>
        <h3 className="text-base font-semibold text-text">Contracts</h3>
        <Rows rows={contracts} />
        <p className="mt-4 text-13 text-muted">
          {COPY.audit}{" "}
          <Link href="/docs" className="text-accent-text hover:underline">
            How it works
          </Link>
        </p>
      </section>
    </div>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="mt-3 divide-y divide-border/60 border-y border-border/60">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-1 py-2.5 text-13 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <dt className="text-muted">{k}</dt>
          <dd className="text-text sm:text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

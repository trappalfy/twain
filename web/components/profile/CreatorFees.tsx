"use client";

import { CREATOR_FEE_SHARE, PARAMS, assetToUsd, formatAsset, formatUsd, type AccountResponse, type AssetInfo, type Hex } from "@twain/shared";
import { launchpadAbi, lockerAbi } from "@twain/shared/abi";
import { useEffect, type ReactNode } from "react";
import { zeroAddress } from "viem";
import { useAccount, useReadContracts, useSwitchChain } from "wagmi";
import { Button, Card, Skeleton, StatTile } from "@/components/ui";
import { config } from "@/lib/config";
import { useTx } from "@/lib/tx";
import { appChain } from "@/lib/wagmi";

const { launchpad, locker } = config.deployment;
/** Onchain reads/claims only with deployed contracts. */
const LIVE = launchpad !== zeroAddress && locker !== zeroAddress;

type PerAsset = Map<Hex, { asset: AssetInfo; amount: bigint }>;

function add(m: PerAsset, asset: AssetInfo, amount: bigint) {
  if (amount === 0n) return;
  const cur = m.get(asset.address);
  m.set(asset.address, { asset, amount: (cur?.amount ?? 0n) + amount });
}

/** USD total (assets with a price) as the value, the per-asset amounts as the line under it. */
function money(m: PerAsset | null): { value: ReactNode; sub?: ReactNode } {
  if (!m) return { value: <Skeleton className="h-8 w-24" />, sub: <Skeleton className="h-4 w-16" /> };
  const items = [...m.values()];
  if (items.length === 0) return { value: "$0" };
  let usd: number | null = null;
  for (const { asset, amount } of items) {
    const v = assetToUsd(amount, asset.decimals, asset.usd);
    if (v != null) usd = (usd ?? 0) + v;
  }
  const breakdown = items.map(({ asset, amount }) => formatAsset(amount, asset)).join(" + ");
  return usd == null ? { value: breakdown } : { value: formatUsd(usd), sub: breakdown };
}

/** Creator fees for the connected creator's own profile (id="creator-fees", linked from the wallet menu). */
export function CreatorFees({ address, account }: { address: Hex; account: AccountResponse | undefined }) {
  const created = account?.created ?? [];

  // Wallet menu links to /profile#creator-fees; this block mounts after the wallet reconnects, so scroll here then.
  useEffect(() => {
    if (window.location.hash === "#creator-fees") document.getElementById("creator-fees")?.scrollIntoView({ block: "start" });
  }, []);

  const infos = useReadContracts({
    contracts: created.map((t) => ({ address: launchpad, abi: launchpadAbi, functionName: "coinInfo", args: [t.address] }) as const),
    query: { enabled: LIVE && created.length > 0, refetchInterval: 15_000 },
  });
  const pools = useReadContracts({
    contracts: created.map((t) => ({ address: locker, abi: lockerAbi, functionName: "pendingFees", args: [t.address] }) as const),
    query: { enabled: LIVE && created.length > 0, refetchInterval: 30_000 },
  });

  // Available = collected and unclaimed (coinInfo.creatorFees) + the creator's share still in the pools; a claim
  // collects the pool fees first, so both are paid in the same transaction.
  let available: PerAsset | null = null;
  let waiting: PerAsset | null = null;
  const claimable: Hex[] = [];
  if (account && created.length === 0) {
    available = new Map();
    waiting = new Map();
  } else if (infos.data && pools.data) {
    available = new Map();
    waiting = new Map();
    created.forEach((t, i) => {
      const info = infos.data![i];
      const pool = pools.data![i];
      if (info?.status !== "success" || info.result.creator.toLowerCase() !== address.toLowerCase()) return;
      const pendingAsset = pool?.status === "success" ? (pool.result[0] * CREATOR_FEE_SHARE) / 100n : 0n;
      const pendingCoin = pool?.status === "success" ? pool.result[1] : 0n;
      add(available!, t.asset, info.result.creatorFees + pendingAsset);
      add(waiting!, t.asset, pendingAsset);
      if (info.result.creatorFees > 0n || pendingAsset > 0n || pendingCoin > 0n) claimable.push(t.address);
    });
  }

  let earned: PerAsset | null = null;
  let claimed: PerAsset | null = null;
  if (account) {
    earned = new Map();
    claimed = new Map();
    for (const f of account.creatorFees) {
      add(earned, f.asset, BigInt(f.accrued));
      add(claimed, f.asset, BigInt(f.claimed));
    }
  }

  const { chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const wrongChain = chainId !== undefined && chainId !== appChain.id;
  const claimTx = useTx();

  const claimAll = () =>
    claimTx.run(
      () => claimTx.writeContractAsync({ address: launchpad, abi: launchpadAbi, functionName: "claimCreatorFees", args: [claimable], chainId: appChain.id }),
      { pending: "Claiming creator fees…", success: "Creator fees claimed" },
    );

  const tiles = [
    { label: "Total earned", hint: "Your share of pool fees collected so far, since launch.", m: money(earned) },
    { label: "Claimed", m: money(claimed) },
    {
      label: "Still in pools",
      hint: `Your ${PARAMS.creatorFeePct} of trades not yet collected from the pools. A claim collects it first.`,
      m: money(waiting),
    },
  ];
  const avail = money(available);

  return (
    <Card as="section" id="creator-fees" aria-labelledby="creator-fees-title" className="scroll-mt-[calc(var(--header-h)+16px)]">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 id="creator-fees-title" className="font-heading text-28 text-text">
            Creator fees
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted">
            {PARAMS.creatorFeePct} of every trade in your coins&apos; pools, paid in each coin&apos;s paired asset. Fees paid in your coin go
            straight to this wallet when they are collected.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {wrongChain ? (
            <Button loading={switching} onClick={() => switchChain({ chainId: appChain.id })}>
              Switch to Robinhood Chain
            </Button>
          ) : (
            <Button
              loading={claimTx.busy}
              disabled={!LIVE || claimable.length === 0}
              onClick={claimAll}
              title={!LIVE ? "Claims open once the contracts are configured." : undefined}
            >
              Claim all
            </Button>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Available now" value={avail.value} sub={avail.sub} size="lg" className="bg-accent-soft ring-1 ring-accent/40 sm:col-span-2 lg:col-span-1" />
        {tiles.map((t) => (
          <StatTile key={t.label} label={t.label} hint={t.hint} value={t.m.value} sub={t.m.sub} size="lg" />
        ))}
      </div>
      {account && created.length === 0 && <p className="mt-4 text-13 text-muted">Fees start accruing once you launch a coin.</p>}
    </Card>
  );
}

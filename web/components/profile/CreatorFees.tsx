"use client";

import { CREATOR_FEE_SHARE, PARAMS, assetToUsd, curveCreatorSide, formatAsset, formatUsd, type AccountResponse, type AssetInfo, type Hex } from "@twain/shared";
import { ponsCurveAbi, twainFeeVaultAbi } from "@twain/shared/abi";
import { useEffect, type ReactNode } from "react";
import { zeroAddress } from "viem";
import { useAccount, useReadContracts, useSwitchChain } from "wagmi";
import { Button, Card, Skeleton, StatTile } from "@/components/ui";
import { isTwainToken } from "@/config/twain-token";
import { config } from "@/lib/config";
import { useTx } from "@/lib/tx";
import { appChain } from "@/lib/wagmi";

/** Onchain reads/claims only with deployed contracts. */
const LIVE = config.deployment.launcher !== zeroAddress;

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
  // The official $TWAIN has no TwainFeeVault (launched on Pons directly; its fees go straight to its creator).
  const created = (account?.created ?? []).filter((t) => !isTwainToken(t.address));

  // Wallet menu links to /profile#creator-fees; this block mounts after the wallet reconnects, so scroll here then.
  useEffect(() => {
    if (window.location.hash === "#creator-fees") document.getElementById("creator-fees")?.scrollIntoView({ block: "start" });
  }, []);

  // Per coin, from its TwainFeeVault: current creator, the creator's owed share, and what a harvest would add.
  const vaults = useReadContracts({
    contracts: created.flatMap(
      (t) =>
        [
          { address: t.vault, abi: twainFeeVaultAbi, functionName: "creator" },
          { address: t.vault, abi: twainFeeVaultAbi, functionName: "creatorOwed", args: [t.asset.address] },
          { address: t.vault, abi: twainFeeVaultAbi, functionName: "pending", args: [t.asset.address] },
          { address: t.curve, abi: ponsCurveAbi, functionName: "quoteFeeBalance" },
          { address: t.curve, abi: ponsCurveAbi, functionName: "creatorTaxBalance" },
        ] as const,
    ),
    query: { enabled: LIVE && created.length > 0, refetchInterval: 15_000 },
  });

  // Available = split and owed to the creator + the creator's 60% of what is still in Pons' escrow (a claim harvests
  // it first, so both are paid in the same transaction).
  let available: PerAsset | null = null;
  let waiting: PerAsset | null = null;
  const claimable: Hex[] = [];
  if (account && created.length === 0) {
    available = new Map();
    waiting = new Map();
  } else if (vaults.data) {
    available = new Map();
    waiting = new Map();
    created.forEach((t, i) => {
      const [creator, owed, pending, feeBal, taxBal] = vaults.data!.slice(i * 5, i * 5 + 5);
      if (creator?.status !== "success" || (creator.result as string).toLowerCase() !== address.toLowerCase()) return;
      const owedNow = owed?.status === "success" ? (owed.result as bigint) : 0n;
      const onCurve =
        t.phase === "curve" && feeBal?.status === "success" && taxBal?.status === "success"
          ? curveCreatorSide(feeBal.result as bigint, taxBal.result as bigint)
          : 0n;
      const notSplit = (pending?.status === "success" ? (pending.result as bigint) : 0n) + onCurve;
      const fromEscrow = (notSplit * CREATOR_FEE_SHARE) / 100n;
      add(available!, t.asset, owedNow + fromEscrow);
      add(waiting!, t.asset, fromEscrow);
      if (owedNow + fromEscrow > 0n) claimable.push(t.vault);
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

  // One transaction per coin vault, in turn.
  const claimAll = async () => {
    for (const [i, vault] of claimable.entries()) {
      const rc = await claimTx.run(
        () => claimTx.writeContractAsync({ address: vault, abi: twainFeeVaultAbi, functionName: "claimCreator", chainId: appChain.id }),
        {
          pending: `Claiming creator fees (${i + 1} of ${claimable.length})…`,
          success: i + 1 === claimable.length ? "Creator fees claimed" : `Claimed ${i + 1} of ${claimable.length}`,
        },
      );
      if (!rc) break;
    }
    void vaults.refetch();
  };

  const tiles = [
    { label: "Total earned", hint: "Your share of trading fees split so far, since launch.", m: money(earned) },
    { label: "Claimed", m: money(claimed) },
    {
      label: "Not yet collected",
      hint: `Your share of trades still held by Pons for your coins. A claim collects it first.`,
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
            You earn {PARAMS.creatorEarnsPct} of every trade in your coins, on the launch curve and in the Uniswap pool, paid in
            each coin&apos;s paired asset. Each coin keeps its fees in its own vault until you claim.
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
              onClick={() => void claimAll()}
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

"use client";

import { CREATOR_FEE_SHARE, formatAsset, formatTokens, PARAMS, type TokenDetail } from "@lancio/shared";
import { launchpadAbi, lockerAbi } from "@lancio/shared/abi";
import { zeroAddress } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { config } from "@/lib/config";
import { useTx } from "@/lib/tx";
import { LAUNCHPAD, LIVE, REFRESH_MS, useCoinInfo } from "./hooks";
import { NOT_CONFIGURED } from "./format";

const LOCKER = config.deployment.locker;

/**
 * Creator fees for this coin. Renders only for the coin's current creator.
 * "Ready to claim" = fees already collected from the pool (coinInfo().creatorFees, in the coin's asset).
 * "Still in the pool" = the creator's share of locker.pendingFees(). Claim collects the pool fees first, so both are
 * paid in one transaction: the asset part to the wallet, the coin part straight from the locker.
 */
export function CreatorFeesCard({ token }: { token: TokenDetail }) {
  const { address } = useAccount();
  const info = useCoinInfo(token);
  const tx = useTx();
  const asset = token.asset;
  const isCreator = !!address && address.toLowerCase() === info.creator.toLowerCase();

  const pendingRead = useReadContract({
    address: LOCKER,
    abi: lockerAbi,
    functionName: "pendingFees",
    args: [token.address],
    query: { enabled: LIVE && isCreator && LOCKER !== zeroAddress, refetchInterval: REFRESH_MS * 3 },
  });

  if (!isCreator) return null;

  const share = (v: bigint) => (v * CREATOR_FEE_SHARE) / 100n;
  const pendingAsset = pendingRead.data ? share(pendingRead.data[0]) : 0n;
  const pendingCoin = pendingRead.data ? share(pendingRead.data[1]) : 0n;
  const claimable = info.creatorFees + pendingAsset;
  const nothing = claimable <= 0n && pendingCoin <= 0n;

  const claim = () =>
    void tx
      .run(
        () =>
          tx.writeContractAsync({
            address: LAUNCHPAD,
            abi: launchpadAbi,
            functionName: "claimCreatorFees",
            args: [[token.address]],
          }),
        { pending: "Claiming…", success: `Claimed ${formatAsset(claimable, asset)}` },
      )
      .then(() => {
        void info.refetch();
        void pendingRead.refetch();
      });

  return (
    <div className="rounded-card bg-surface-2 p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-heading text-xl text-text">Creator fees</h3>
        <span className="text-13 text-muted tabular">Lifetime {formatAsset(token.creatorFeesAccrued, asset)}</span>
      </div>

      <dl className="mt-4 flex flex-col gap-3">
        <FeeLine
          label="Ready to claim"
          hint={`Your ${PARAMS.creatorFeePct} of every trade, in ${asset.symbol}: collected and waiting in the pool.`}
          value={pendingRead.data || !LIVE ? formatAsset(claimable, asset) : "…"}
        />
        <FeeLine
          label={`Fees in $${token.symbol}`}
          hint={`Sells pay the pool fee in $${token.symbol}. Your share is sent to your wallet when the fees are collected.`}
          value={pendingRead.data || !LIVE ? formatTokens(pendingCoin, token.symbol) : "…"}
        />
      </dl>

      <Button
        variant="accent"
        className="mt-5 w-full"
        onClick={claim}
        disabled={!LIVE || tx.busy || nothing}
        loading={tx.busy}
        title={!LIVE ? NOT_CONFIGURED : undefined}
      >
        Claim
      </Button>
    </div>
  );
}

function FeeLine({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-muted">
        <Tooltip content={hint}>
          <button type="button" className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
            {label}
          </button>
        </Tooltip>
      </dt>
      <dd className="text-right text-sm font-medium text-text tabular">{value}</dd>
    </div>
  );
}

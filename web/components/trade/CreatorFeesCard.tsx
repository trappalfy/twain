"use client";

import { formatAsset, PARAMS, type TokenDetail } from "@twain/shared";
import { twainFeeVaultAbi } from "@twain/shared/abi";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { useTx } from "@/lib/tx";
import { LIVE, useVault } from "./hooks";
import { NOT_CONFIGURED } from "./format";

const formatDay = (ts: number) => new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Creator fees for this coin. Renders only for the coin's current creator. Pons credits the creator side of every
 * trade (its fee share + the creator tax) to the coin's TwainFeeVault; the vault splits what arrives 60/40 between
 * the creator and twain. "Claim" harvests from Pons and pays the creator's share in one transaction.
 */
export function CreatorFeesCard({ token }: { token: TokenDetail }) {
  const { address } = useAccount();
  const vault = useVault(token);
  const tx = useTx();
  const asset = token.asset;
  const isCreator = !!address && address.toLowerCase() === vault.creator.toLowerCase();
  if (!isCreator) return null;

  const claimable = vault.creatorFees;
  const claim = () =>
    void tx
      .run(
        () => tx.writeContractAsync({ address: vault.vault, abi: twainFeeVaultAbi, functionName: "claimCreator" }),
        { pending: "Claiming…", success: `Claimed ${formatAsset(claimable, asset)}` },
      )
      .then(() => vault.refetch());

  const change = token.feeRecipientChange;
  return (
    <div className="rounded-card bg-surface-2 p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-heading text-xl text-text">Creator fees</h3>
        <span className="text-13 text-muted tabular">Lifetime {formatAsset(token.creatorFeesAccrued, asset)}</span>
      </div>

      <dl className="mt-4 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-muted">
            <Tooltip content={`You earn ${PARAMS.creatorEarnsPct} of every trade's volume, paid in ${asset.symbol}.`}>
              <button type="button" className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
                Ready to claim
              </button>
            </Tooltip>
          </dt>
          <dd className="text-right text-sm font-medium text-text tabular">
            {vault.live || !LIVE ? formatAsset(claimable, asset) : "…"}
          </dd>
        </div>
      </dl>

      {change && (
        <p className="mt-4 rounded-xl border border-sell/40 px-3 py-2.5 text-13 text-sell">
          Pons has proposed to send this coin&apos;s fees to another address from {formatDay(change.effectiveAt)}. Claim
          what is owed before then.
        </p>
      )}

      <Button
        variant="accent"
        className="mt-5 w-full"
        onClick={claim}
        disabled={!LIVE || tx.busy || claimable <= 0n}
        loading={tx.busy}
        title={!LIVE ? NOT_CONFIGURED : undefined}
      >
        Claim
      </Button>
    </div>
  );
}

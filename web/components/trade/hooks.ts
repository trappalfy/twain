"use client";

import { coinPhase, CREATOR_FEE_SHARE, curveCreatorSide, NATIVE_ASSET, PONS_V2, type AssetInfo, type CoinPhase, type TokenDetail } from "@twain/shared";
import { ponsCurveAbi, ponsFactoryAbi, tokenAbi, twainFeeVaultAbi } from "@twain/shared/abi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useBalance, useReadContract, useSwitchChain } from "wagmi";
import { config } from "@/lib/config";
import { isUserRejection, toFriendlyError } from "@/lib/errors";
import { appChain } from "@/lib/wagmi";

export type Side = "buy" | "sell";

/** Onchain reads only make sense with deployed contracts. */
export const LIVE = config.deployment.launcher !== zeroAddress;
/** Quote / state refresh — Robinhood Chain blocks are ~0.1 s, the RPC is polled every ~2 s. */
export const REFRESH_MS = 2_000;
export const PONS_FACTORY = PONS_V2.factory as Address;
export const DEADLINE_SECONDS = 300;

export const deadlineFromNow = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

export const isNative = (asset: Pick<AssetInfo, "address">) => asset.address.toLowerCase() === NATIVE_ASSET;

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Keep digits and one dot, at most `decimals` decimals. */
export function sanitizeAmount(raw: string, decimals = 18): string {
  let s = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "").slice(0, decimals);
  if (s.startsWith(".")) s = `0${s}`;
  return s;
}

/** Positive amount in the smallest unit, or null. */
export function parseAmount(s: string, decimals = 18): bigint | null {
  if (!s || s === "." || s === "0.") return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Smallest units → input string, rounded down to `places` decimals, trailing zeros trimmed. */
export function toInputString(amount: bigint, decimals = 18, places = 6): string {
  const p = Math.min(places, decimals);
  const one = 10n ** BigInt(decimals);
  const unit = 10n ** BigInt(decimals - p);
  const floored = amount - (amount % unit);
  const whole = floored / one;
  const frac = (floored % one).toString().padStart(decimals, "0").slice(0, p).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Live Pons phase of a coin (curve → graduating → pool), falling back to the indexer's until the read lands. */
export function usePhase(token: TokenDetail): { phase: CoinPhase; refetch: () => void } {
  const { data, refetch } = useReadContract({
    address: PONS_FACTORY,
    abi: ponsFactoryAbi,
    functionName: "getLaunchedToken",
    args: [token.address],
    query: { enabled: LIVE, refetchInterval: REFRESH_MS * 2 },
  });
  return { phase: data?.exists ? coinPhase(data.phase) : token.phase, refetch: () => void refetch() };
}

/**
 * Live state of the coin's TwainFeeVault: current creator and the creator's fees in the pair asset — split and owed,
 * plus what a harvest would add (escrow credits and unsplit balance × 60%). Falls back to the indexer's fields.
 */
export function useVault(token: TokenDetail) {
  const vault = token.vault;
  const asset = token.asset.address;
  const q = { enabled: LIVE, refetchInterval: REFRESH_MS * 2 };
  const creator = useReadContract({ address: vault, abi: twainFeeVaultAbi, functionName: "creator", query: q });
  const owed = useReadContract({ address: vault, abi: twainFeeVaultAbi, functionName: "creatorOwed", args: [asset], query: q });
  const pending = useReadContract({ address: vault, abi: twainFeeVaultAbi, functionName: "pending", args: [asset], query: q });
  // Before graduation the creator side also sits in the curve until its next sweep (a claim sweeps it first).
  const onCurve = { enabled: LIVE && token.phase === "curve", refetchInterval: REFRESH_MS * 2 };
  const feeBal = useReadContract({ address: token.curve, abi: ponsCurveAbi, functionName: "quoteFeeBalance", query: onCurve });
  const taxBal = useReadContract({ address: token.curve, abi: ponsCurveAbi, functionName: "creatorTaxBalance", query: onCurve });
  const inCurve = feeBal.data !== undefined && taxBal.data !== undefined ? curveCreatorSide(feeBal.data, taxBal.data) : 0n;
  const fallback = BigInt(token.creatorFeesAccrued) - BigInt(token.creatorFeesClaimed);
  const live = owed.data !== undefined && pending.data !== undefined;
  return {
    vault,
    creator: (creator.data ?? token.creator) as Address,
    /** Owed to the creator now plus their share of what a claim would bring in (escrow + curve), in the pair asset. */
    creatorFees: live ? owed.data! + ((pending.data! + inCurve) * CREATOR_FEE_SHARE) / 100n : fallback > 0n ? fallback : 0n,
    live,
    refetch: () => {
      void creator.refetch();
      void owed.refetch();
      void pending.refetch();
      void feeBal.refetch();
      void taxBal.refetch();
    },
  };
}

/** Connected wallet, chain check and balances (the coin and its asset) for the trade panel. */
export function useWallet(token: Address, asset: AssetInfo) {
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending: switching } = useSwitchChain();
  const wrongChain = isConnected && chainId !== appChain.id;
  const native = isNative(asset);

  const eth = useBalance({
    address,
    chainId: appChain.id,
    query: { enabled: !!address, refetchInterval: REFRESH_MS * 2 },
  });
  const assetBal = useReadContract({
    address: asset.address,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [address ?? zeroAddress],
    query: { enabled: LIVE && !native && !!address, refetchInterval: REFRESH_MS * 2 },
  });
  const tok = useReadContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [address ?? zeroAddress],
    query: { enabled: LIVE && !!address, refetchInterval: REFRESH_MS * 2 },
  });

  return {
    address,
    connected: isConnected && !!address,
    wrongChain,
    connect: () => openConnectModal?.(),
    switchChain: () =>
      switchChain(
        { chainId: appChain.id },
        { onError: (e) => (isUserRejection(e) ? undefined : toast.error(toFriendlyError(e))) },
      ),
    switching,
    ethBalance: eth.data?.value,
    /** Balance of the coin's asset (ETH for native pairs). */
    assetBalance: native ? eth.data?.value : assetBal.data,
    tokenBalance: tok.data,
    refetchBalances: () => {
      void eth.refetch();
      void assetBal.refetch();
      void tok.refetch();
    },
  };
}

export type Wallet = ReturnType<typeof useWallet>;

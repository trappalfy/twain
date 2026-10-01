"use client";

import { NATIVE_ASSET, type AssetInfo, type TokenDetail } from "@twain/shared";
import { launchpadAbi, tokenAbi } from "@twain/shared/abi";
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
export const LIVE = config.deployment.launchpad !== zeroAddress;
/** Quote / state refresh — Robinhood Chain blocks are ~0.1 s, the RPC is polled every ~2 s. */
export const REFRESH_MS = 2_000;
export const LAUNCHPAD = config.deployment.launchpad;
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

/**
 * Live coin state from `coinInfo(coin)` (current creator, unclaimed creator fees in the coin's asset), falling back
 * to the indexer's fields until the read lands.
 */
export function useCoinInfo(token: TokenDetail) {
  const { data, refetch } = useReadContract({
    address: LAUNCHPAD,
    abi: launchpadAbi,
    functionName: "coinInfo",
    args: [token.address],
    query: { enabled: LIVE, refetchInterval: REFRESH_MS * 2 },
  });
  const known = !!data && data.creator !== zeroAddress;
  const fallbackFees = BigInt(token.creatorFeesAccrued) - BigInt(token.creatorFeesClaimed);
  return {
    creator: (known ? data.creator : token.creator) as Address,
    /** Collected and not yet claimed, in the coin's asset. */
    creatorFees: known ? data.creatorFees : fallbackFees > 0n ? fallbackFees : 0n,
    live: known,
    refetch,
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

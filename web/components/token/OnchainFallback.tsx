"use client";

import {
  coinIsCurrency0,
  coinPhase,
  curvePriceX18,
  curveProgressBps,
  mcapFromPriceX18,
  NATIVE_ASSET,
  PONS_V2,
  priceX18FromSqrt,
  shortAddress,
  UNISWAP_V4,
  type AssetInfo,
  type Hex,
  type TokenDetail,
} from "@twain/shared";
import { ponsCurveAbi, ponsFactoryAbi, stateViewAbi, tokenAbi, twainFeeVaultAbi, twainLauncherAbi } from "@twain/shared/abi";
import { useMemo } from "react";
import { zeroAddress, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { Button, Card, EmptyState } from "@/components/ui";
import { LIVE_MS, useAssets } from "@/lib/api";
import { config } from "@/lib/config";
import { coinPoolKey, poolIdOf } from "@/lib/uniswap";
import { isZeroAddress } from "./links";
import { TokenPageSkeleton } from "./TokenPageSkeleton";
import { TokenView } from "./TokenView";
import type { Side, TokenTab } from "./types";

const ETH_INFO: AssetInfo = { address: NATIVE_ASSET, symbol: "ETH", name: "Ether", decimals: 18, logo: null, kind: "native", usd: null };
const PONS = PONS_V2.factory as Address;

/**
 * The indexer has no record of this coin (just launched) or is unreachable: read it straight from Robinhood Chain —
 * its vault from TwainLauncher (none → not a twain coin), its Pons launch record (curve, pair, phase), ERC-20
 * name/symbol and its price (curve reserves, or the v4 pool after graduation) — and render the page with a note.
 */
export function OnchainFallback({
  address,
  notIndexed,
  initialSide,
  initialTab,
}: {
  address: Hex;
  /** true: the indexer answered 404; false: the indexer failed. */
  notIndexed: boolean;
  initialSide?: Side;
  initialTab?: TokenTab;
}) {
  const launcher = config.deployment.launcher;
  const configured = !isZeroAddress(launcher);
  const assets = useAssets();
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: launcher, abi: twainLauncherAbi, functionName: "vaultOf", args: [address] },
      { address: PONS, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [address] },
      { address, abi: tokenAbi, functionName: "name" },
      { address, abi: tokenAbi, functionName: "symbol" },
    ],
    query: { enabled: configured, refetchInterval: LIVE_MS },
  });
  const [vaultRes, infoRes, nameRes, symbolRes] = reads.data ?? [];
  const vault = vaultRes?.status === "success" ? vaultRes.result : undefined;
  const info = infoRes?.status === "success" ? infoRes.result : undefined;
  const known = !!vault && !isZeroAddress(vault) && !!info?.exists;
  const assetAddr = (info?.pairToken ?? zeroAddress).toLowerCase() as Hex;
  const curve = (info?.curve ?? zeroAddress) as Address;
  const listed = assets.data?.find((a) => a.address === assetAddr);
  const poolId = useMemo(() => poolIdOf(coinPoolKey(address, assetAddr)), [address, assetAddr]);

  const second = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: curve, abi: ponsCurveAbi, functionName: "getReserves" },
      { address: curve, abi: ponsCurveAbi, functionName: "reservedTokens" },
      { address: curve, abi: ponsCurveAbi, functionName: "launchSupply" },
      { address: UNISWAP_V4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
      { address: assetAddr, abi: tokenAbi, functionName: "symbol" },
      { address: assetAddr, abi: tokenAbi, functionName: "decimals" },
      { address: (vault ?? zeroAddress) as Address, abi: twainFeeVaultAbi, functionName: "creator" },
    ],
    query: { enabled: known, refetchInterval: LIVE_MS },
  });
  const [reservesRes, reservedRes, supplyRes, slot0Res, assetSymRes, assetDecRes, creatorRes] = second.data ?? [];

  const token = useMemo<TokenDetail | null>(() => {
    if (!info || !known || !vault) return null;
    const asset: AssetInfo =
      listed ??
      (assetAddr === NATIVE_ASSET
        ? ETH_INFO
        : {
            address: assetAddr,
            symbol: assetSymRes?.status === "success" ? assetSymRes.result : "?",
            name: assetSymRes?.status === "success" ? assetSymRes.result : "Unknown asset",
            decimals: assetDecRes?.status === "success" ? Number(assetDecRes.result) : 18,
            logo: null,
            kind: "token",
            usd: null,
          });
    const phase = coinPhase(info.phase);
    const coinIs0 = coinIsCurrency0(address, assetAddr);
    const reserves = reservesRes?.status === "success" ? reservesRes.result : null;
    const reserved = reservedRes?.status === "success" ? reservedRes.result : 0n;
    const supply = supplyRes?.status === "success" ? supplyRes.result : 10n ** 27n;
    const sqrtPrice = slot0Res?.status === "success" ? slot0Res.result[0] : 0n;
    const price = phase === "curve" && reserves ? curvePriceX18(reserves[0], reserves[1]) : priceX18FromSqrt(sqrtPrice, coinIs0);
    const usdPerCoin = asset.usd == null ? null : (Number(price) / 1e18 / 10 ** asset.decimals) * asset.usd;
    const creator = (creatorRes?.status === "success" ? creatorRes.result : zeroAddress).toLowerCase() as Hex;
    return {
      address: address.toLowerCase() as Hex,
      name: nameRes?.status === "success" ? nameRes.result : shortAddress(address),
      symbol: symbolRes?.status === "success" ? symbolRes.result : "",
      creator,
      createdAt: 0,
      createdBlock: 0,
      metadataUri: "",
      meta: { description: null, image: null, x: null, telegram: null, website: null },
      asset,
      curve: curve.toLowerCase() as Hex,
      vault: vault.toLowerCase() as Hex,
      phase,
      progressBps: phase === "curve" && reserves ? curveProgressBps(reserves[1], supply, reserved) : 10_000,
      poolId,
      coinIsCurrency0: coinIs0,
      priceX18: price.toString(),
      mcapAsset: mcapFromPriceX18(price).toString(),
      priceUsd: usdPerCoin,
      mcapUsd: usdPerCoin == null ? null : usdPerCoin * 1e9,
      volumeAsset24h: "0",
      volumeAsset7d: "0",
      volumeAssetAll: "0",
      volumeUsd24h: null,
      change24hPct: null,
      tradesCount: 0,
      holdersCount: 0,
      lastBuyAt: null,
      lastTradeAt: null,
      startPriceX18: price.toString(),
      graduationThreshold: info.graduationThreshold.toString(),
      quoteReserve: reserves ? reserves[0].toString() : null,
      tokenReserve: reserves ? reserves[1].toString() : null,
      creatorFeesAccrued: "0",
      creatorFeesClaimed: "0",
      coinFeesToCreator: "0",
      feeRecipientChange: null,
    };
  }, [address, info, known, vault, listed, assetAddr, curve, nameRes, symbolRes, reservesRes, reservedRes, supplyRes, slot0Res, assetSymRes, assetDecRes, creatorRes, poolId]);

  if (configured && reads.isPending) return <TokenPageSkeleton />;

  if (configured && !vaultRes)
    return (
      <div className="container-page py-10 md:py-16">
        <Card className="text-center">
          <p className="text-base text-text">This coin could not be read from Robinhood Chain right now.</p>
          <Button variant="outline" className="mt-6" onClick={() => reads.refetch()} loading={reads.isFetching}>
            Try again
          </Button>
        </Card>
      </div>
    );

  if (!token)
    return (
      <div className="container-page py-10 md:py-16">
        <Card>
          <EmptyState
            title="This address is not a coin launched here."
            description={<span className="font-mono break-all">{address}</span>}
            action={
              <Button href="/" variant="outline">
                Back to Explore
              </Button>
            }
          />
        </Card>
      </div>
    );

  const notice = notIndexed
    ? "Indexing… This coin is live onchain. Its chart, trades and holders appear once the indexer catches up."
    : "Market data is unavailable right now. Showing the live contract state from Robinhood Chain.";

  return <TokenView token={token} indexing notice={notice} initialSide={initialSide} initialTab={initialTab} />;
}

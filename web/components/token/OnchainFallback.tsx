"use client";

import {
  coinIsCurrency0,
  mcapFromPriceX18,
  NATIVE_ASSET,
  priceX18FromSqrt,
  shortAddress,
  UNISWAP_V4,
  type AssetInfo,
  type Hex,
  type TokenDetail,
} from "@lancio/shared";
import { launchpadAbi, stateViewAbi, tokenAbi } from "@lancio/shared/abi";
import { useMemo } from "react";
import { zeroAddress } from "viem";
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

/**
 * The indexer has no record of this coin (just launched) or is unreachable: read the coin from the launchpad
 * (creator, asset), its ERC-20 name/symbol and its pool price straight from Robinhood Chain, and render the page with
 * an "Indexing…" note. coinInfo().creator == 0 → not a coin from this launchpad.
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
  const launchpad = config.deployment.launchpad;
  const configured = !isZeroAddress(launchpad);
  const assets = useAssets();
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: launchpad, abi: launchpadAbi, functionName: "coinInfo", args: [address] },
      { address, abi: tokenAbi, functionName: "name" },
      { address, abi: tokenAbi, functionName: "symbol" },
    ],
    query: { enabled: configured, refetchInterval: LIVE_MS },
  });
  const [infoRes, nameRes, symbolRes] = reads.data ?? [];
  const info = infoRes?.status === "success" ? infoRes.result : undefined;
  const assetAddr = (info?.asset ?? zeroAddress).toLowerCase() as Hex;
  const known = !!info && !isZeroAddress(info.creator);
  const listed = assets.data?.find((a) => a.address === assetAddr);
  const poolId = useMemo(() => poolIdOf(coinPoolKey(address, assetAddr)), [address, assetAddr]);

  const second = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: UNISWAP_V4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
      { address: assetAddr, abi: tokenAbi, functionName: "symbol" },
      { address: assetAddr, abi: tokenAbi, functionName: "decimals" },
    ],
    query: { enabled: known, refetchInterval: LIVE_MS },
  });
  const [slot0Res, assetSymRes, assetDecRes] = second.data ?? [];

  const token = useMemo<TokenDetail | null>(() => {
    if (!info || !known) return null;
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
    const coinIs0 = coinIsCurrency0(address, assetAddr);
    const sqrtPrice = slot0Res?.status === "success" ? slot0Res.result[0] : 0n;
    const price = priceX18FromSqrt(sqrtPrice, coinIs0);
    const usdPerCoin = asset.usd == null ? null : (Number(price) / 1e18 / 10 ** asset.decimals) * asset.usd;
    return {
      address: address.toLowerCase() as Hex,
      name: nameRes?.status === "success" ? nameRes.result : shortAddress(address),
      symbol: symbolRes?.status === "success" ? symbolRes.result : "",
      creator: info.creator.toLowerCase() as Hex,
      createdAt: 0,
      createdBlock: 0,
      metadataUri: "",
      meta: { description: null, image: null, x: null, telegram: null, website: null },
      asset,
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
      creatorFeesAccrued: info.creatorFees.toString(),
      creatorFeesClaimed: "0",
      coinFeesToCreator: "0",
    };
  }, [address, info, known, listed, assetAddr, nameRes, symbolRes, slot0Res, assetSymRes, assetDecRes, poolId]);

  if (configured && reads.isPending) return <TokenPageSkeleton />;

  if (configured && !info)
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
            image="/brand/painting-gate.png"
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

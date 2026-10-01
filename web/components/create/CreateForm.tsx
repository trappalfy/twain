"use client";

import {
  COPY,
  NATIVE_ASSET,
  PARAMS,
  TOKEN_LIMITS,
  applySlippage,
  formatEth,
  quoteFromStart,
  type ListedAsset,
} from "@twain/shared";
import { launchpadAbi, tokenAbi } from "@twain/shared/abi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery } from "@tanstack/react-query";
import { Fuel, Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatUnits, maxUint256, parseEventLogs, parseUnits, toHex, zeroAddress, type Address } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain } from "wagmi";
import { AssetIcon } from "@/components/common";
import { Accordion, Button, Field, Input, Select, Textarea, TelegramIcon, XIcon } from "@/components/ui";
import { useAssets } from "@/lib/api";
import { config } from "@/lib/config";
import { isUserRejection, toFriendlyError } from "@/lib/errors";
import { useTx } from "@/lib/tx";
import { appChain } from "@/lib/wagmi";
import { DevBuyField } from "./DevBuyField";
import { ImageField } from "./ImageField";
import { TokenPreview } from "./TokenPreview";
import { uploadMetadata } from "./upload";
import { useImageUpload } from "./useImageUpload";
import {
  cleanTicker,
  nameValid,
  normalizeTelegram,
  normalizeWebsite,
  normalizeX,
  utf8Length,
  type TokenMetadata,
} from "./validate";

const LAUNCHPAD = config.deployment.launchpad;
const LAUNCHPAD_SET = LAUNCHPAD.toLowerCase() !== zeroAddress;

/** Max button rounds down to 6 decimals. */
const MAX_DECIMALS = 6;
/** The first buy fills at the start price in the same transaction; the margin only covers preview rounding. */
const FIRST_BUY_SLIPPAGE_BPS = 50;

/** Worst-case placeholders for the gas estimate (longest name/ticker, CIDv1 URI). */
const GAS_NAME = "x".repeat(TOKEN_LIMITS.nameMax);
const GAS_SYMBOL = "X".repeat(TOKEN_LIMITS.symbolMax);
const GAS_URI = `ipfs://b${"a".repeat(58)}`;

const parseAmount = (v: string, decimals: number): bigint | null => {
  if (!v || v === ".") return 0n;
  try {
    return parseUnits(v, decimals);
  } catch {
    return null;
  }
};

/** Random salt for the coin's CREATE2 address: unpredictable until the transaction lands. */
const randomSalt = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Step = "idle" | "metadata" | "tx" | "done";
type ButtonState = { label: string; disabled?: boolean; loading?: boolean; onClick?: () => void };

/** initialCoin / initialPair: ?coin= and ?pair= from the hero's pair card (read by the page on the server). */
export function CreateForm({ initialCoin, initialPair }: { initialCoin?: string; initialPair?: string } = {}) {
  const router = useRouter();
  const { address, chainId, status: accountStatus } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending: switching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: appChain.id });
  const tx = useTx();
  const image = useImageUpload();

  // ?coin=KITE&pair=TSLA from the hero's pair card ("pair=any" opens the asset list)
  const pairParam = initialPair?.toUpperCase() ?? null;
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState(() => cleanTicker(initialCoin ?? ""));
  const [description, setDescription] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [assetAddr, setAssetAddr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [metaError, setMetaError] = useState<string | null>(null);
  const metaCache = useRef<{ key: string; uri: string } | null>(null);

  const connected = accountStatus === "connected" && !!address;
  const onChain = connected && chainId === appChain.id;
  const busy = step !== "idle";

  // ---- validation
  const nameBytes = utf8Length(name.trim());
  const nameError = name.trim() && !nameValid(name) ? "Name is too long." : undefined;
  const xUrl = normalizeX(x);
  const tgUrl = normalizeTelegram(telegram);
  const webUrl = normalizeWebsite(website);
  // ---- paired asset (owner-listed, enabled ones only)
  const assetsQ = useAssets();
  const enabled = (assetsQ.data ?? []).filter((a) => a.enabled);
  const preferred = pairParam && pairParam !== "ANY" ? enabled.find((a) => a.symbol.toUpperCase() === pairParam) : undefined;
  const asset: ListedAsset | undefined = enabled.find((a) => a.address === assetAddr) ?? preferred ?? enabled[0];
  const native = !asset || asset.address === NATIVE_ASSET;
  const decimals = asset?.decimals ?? 18;

  const devBuyAmount = parseAmount(devBuy, decimals);
  const devAmount = devBuyAmount ?? 0n;
  const expected = devAmount > 0n && asset ? quoteFromStart(asset.startTick, devAmount) : 0n;
  const hasDetails = nameValid(name) && ticker.length > 0;
  const fieldsValid = !nameError && xUrl !== undefined && tgUrl !== undefined && webUrl !== undefined && devBuyAmount !== null;

  // ---- chain reads
  const balanceQ = useBalance({ address, chainId: appChain.id, query: { enabled: connected, refetchInterval: 15_000 } });
  const ethBalance = balanceQ.data?.value;
  const assetBalanceQ = useReadContract({
    address: (asset?.address ?? zeroAddress) as Address,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [address ?? zeroAddress],
    chainId: appChain.id,
    query: { enabled: connected && !native, refetchInterval: 15_000 },
  });
  const allowanceQ = useReadContract({
    address: (asset?.address ?? zeroAddress) as Address,
    abi: tokenAbi,
    functionName: "allowance",
    args: [address ?? zeroAddress, LAUNCHPAD],
    chainId: appChain.id,
    query: { enabled: connected && !native && LAUNCHPAD_SET, refetchInterval: 15_000 },
  });
  const balance = native ? ethBalance : assetBalanceQ.data;
  const needsApproval = !native && devAmount > 0n && allowanceQ.data !== undefined && allowanceQ.data < devAmount;
  const pausedQ = useReadContract({
    address: LAUNCHPAD,
    abi: launchpadAbi,
    functionName: "creationPaused",
    chainId: appChain.id,
    query: { enabled: LAUNCHPAD_SET, refetchInterval: 30_000 },
  });
  const paused = pausedQ.data === true;

  // Gas estimate: the ERC-20 first buy is left out until the launchpad may pull it (the call would revert).
  const gasAmount = useDebounced(needsApproval ? 0n : devAmount, 400);
  const gasQ = useQuery({
    queryKey: ["twain", "create-gas", address, asset?.address, gasAmount.toString()],
    enabled: !!publicClient && onChain && LAUNCHPAD_SET && !paused && !!asset && (native || balance === undefined || gasAmount <= balance),
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const [gas, gasPrice] = await Promise.all([
        publicClient!.estimateContractGas({
          address: LAUNCHPAD,
          abi: launchpadAbi,
          functionName: "create",
          args: [
            {
              name: GAS_NAME,
              symbol: GAS_SYMBOL,
              metadataURI: GAS_URI,
              asset: asset!.address,
              salt: randomSalt(),
              assetIn: gasAmount,
              minCoinsOut: 0n,
            },
          ],
          value: native ? gasAmount : 0n,
          account: address!,
        }),
        publicClient!.getGasPrice(),
      ]);
      return gas * gasPrice;
    },
  });
  const gasCost = gasQ.data;
  const notEnoughAsset = balance !== undefined && balance < devAmount + (native ? (gasCost ?? 0n) : 0n);
  const notEnoughGas = !native && ethBalance !== undefined && gasCost !== undefined && ethBalance < gasCost;

  const setMax = () => {
    if (balance === undefined) return;
    let max = native ? balance - 2n * (gasCost ?? 0n) : balance;
    if (max < 0n) max = 0n;
    const step = 10n ** BigInt(Math.max(0, decimals - MAX_DECIMALS));
    max = (max / step) * step;
    setDevBuy(max > 0n ? formatUnits(max, decimals) : "");
  };

  const approve = async () => {
    if (!asset) return;
    const rc = await tx.run(
      () =>
        tx.writeContractAsync({
          address: asset.address,
          abi: tokenAbi,
          functionName: "approve",
          args: [LAUNCHPAD, maxUint256],
          chainId: appChain.id,
        }),
      { pending: "Approving…", success: `${asset.symbol} approved` },
    );
    if (rc) void allowanceQ.refetch();
  };

  // ---- launch
  const metadata = (): TokenMetadata => ({
    name: name.trim(),
    symbol: ticker,
    description: description.trim() || null,
    image: image.state.status === "ready" ? image.state.uri : null,
    x: xUrl ?? null,
    telegram: tgUrl ?? null,
    website: webUrl ?? null,
  });

  const launch = async () => {
    if (!onChain || !hasDetails || !fieldsValid || devBuyAmount === null || !asset) return;
    setMetaError(null);
    const meta = metadata();
    const key = JSON.stringify(meta);
    let uri = metaCache.current?.key === key ? metaCache.current.uri : null;
    if (!uri) {
      setStep("metadata");
      try {
        uri = (await uploadMetadata(meta)).uri;
        metaCache.current = { key, uri };
      } catch (err) {
        setMetaError(err instanceof Error ? err.message : "Upload failed. Try again.");
        setStep("idle");
        return;
      }
    }

    setStep("tx");
    // The first buy is the first trade in a pool opened in the same transaction, at the asset's start price.
    const minCoinsOut = devBuyAmount > 0n ? applySlippage(quoteFromStart(asset.startTick, devBuyAmount), FIRST_BUY_SLIPPAGE_BPS) : 0n;
    const rc = await tx.run(
      () =>
        tx.writeContractAsync({
          address: LAUNCHPAD,
          abi: launchpadAbi,
          functionName: "create",
          args: [
            {
              name: meta.name,
              symbol: meta.symbol,
              metadataURI: uri,
              asset: asset.address,
              salt: randomSalt(),
              assetIn: devBuyAmount,
              minCoinsOut,
            },
          ],
          value: native ? devBuyAmount : 0n,
          chainId: appChain.id,
        }),
      { pending: "Launching…", success: COPY.create.success },
    );
    if (!rc || rc.status !== "success") {
      setStep("idle");
      return;
    }
    setStep("done");
    const created = parseEventLogs({ abi: launchpadAbi, eventName: "CoinCreated", logs: rc.logs }).find(
      (l) => l.address.toLowerCase() === LAUNCHPAD.toLowerCase(),
    );
    router.push(created ? `/launchpad/${created.args.coin.toLowerCase()}` : "/profile");
  };

  const button: ButtonState = (() => {
    if (step === "metadata") return { label: "Uploading…", loading: true };
    if (step === "tx") return tx.status === "pending" ? { label: "Launching…", loading: true } : { label: "Confirm in wallet", loading: true };
    if (step === "done") return { label: "Launching…", loading: true };
    if (accountStatus === "connecting" || accountStatus === "reconnecting") return { label: "Connect wallet", loading: true };
    if (!connected) return { label: "Connect wallet", onClick: openConnectModal, disabled: !openConnectModal };
    if (!onChain)
      return {
        label: "Switch to Robinhood Chain",
        loading: switching,
        onClick: () =>
          switchChain({ chainId: appChain.id }, { onError: (e) => void (isUserRejection(e) || toast.error(toFriendlyError(e))) }),
      };
    if (!LAUNCHPAD_SET) return { label: "Launches are not open yet", disabled: true };
    if (paused) return { label: "New launches paused", disabled: true };
    if (!asset) return assetsQ.isPending ? { label: "Loading assets…", loading: true } : { label: "No asset open for launches", disabled: true };
    if (!hasDetails) return { label: COPY.create.needDetails, disabled: true };
    if (!fieldsValid) return { label: "Check the highlighted fields", disabled: true };
    if (image.state.status === "uploading") return { label: "Uploading…", loading: true };
    if (image.state.status === "error") return { label: "Image upload failed · Retry", onClick: image.retry };
    if (!native && devAmount > 0n && (allowanceQ.data === undefined || balance === undefined))
      return allowanceQ.isError || assetBalanceQ.isError
        ? {
            label: `Could not read ${asset.symbol} · Retry`,
            onClick: () => {
              void allowanceQ.refetch();
              void assetBalanceQ.refetch();
            },
          }
        : { label: `Checking ${asset.symbol}…`, loading: true };
    if (notEnoughAsset) return { label: `Not enough ${asset.symbol}`, disabled: true };
    if (notEnoughGas) return { label: "Not enough ETH for gas", disabled: true };
    if (needsApproval)
      return tx.status === "confirm" || tx.status === "pending"
        ? { label: "Approving…", loading: true }
        : { label: `Approve ${asset.symbol}`, onClick: () => void approve() };
    if (metaError) return { label: "Upload failed · Retry", onClick: () => void launch() };
    return { label: COPY.create.title, onClick: () => void launch() };
  })();

  const preview = {
    name,
    ticker,
    description,
    image: image.state.status === "empty" ? null : image.state.preview,
    x: xUrl ?? null,
    telegram: tgUrl ?? null,
    website: webUrl ?? null,
    asset: asset ?? null,
  };

  return (
    <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* ---- form */}
      <div className="p-5 sm:p-8 lg:p-10">
        <h1 className="font-heading text-28 text-text md:text-40">{COPY.create.title}</h1>

        <div className="mt-8 flex flex-col gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Name" htmlFor="token-name" error={nameError} aside={`${nameBytes} / ${TOKEN_LIMITS.nameMax}`}>
              <Input
                id="token-name"
                placeholder="Coin name"
                autoComplete="off"
                maxLength={TOKEN_LIMITS.nameMax * 2}
                value={name}
                disabled={busy}
                aria-invalid={!!nameError || undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Ticker" htmlFor="token-ticker" aside={`${ticker.length} / ${TOKEN_LIMITS.symbolMax}`}>
              <Input
                id="token-ticker"
                placeholder="TICKER"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={ticker}
                disabled={busy}
                onChange={(e) => setTicker(cleanTicker(e.target.value))}
              />
            </Field>
          </div>

          <Field label="Description" htmlFor="token-description" aside={`${description.length} / ${TOKEN_LIMITS.descriptionMax}`}>
            <Textarea
              id="token-description"
              placeholder="What is this coin about?"
              maxLength={TOKEN_LIMITS.descriptionMax}
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <ImageField upload={image} disabled={busy} />

          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="X profile" htmlFor="token-x" error={xUrl === undefined ? "Use x.com/handle or @handle." : undefined}>
              <Input
                id="token-x"
                placeholder="x.com/handle"
                autoComplete="off"
                spellCheck={false}
                leading={<XIcon size={15} />}
                value={x}
                disabled={busy}
                aria-invalid={xUrl === undefined || undefined}
                onChange={(e) => setX(e.target.value)}
              />
            </Field>
            <Field label="Telegram" htmlFor="token-telegram" error={tgUrl === undefined ? "Use t.me/community." : undefined}>
              <Input
                id="token-telegram"
                placeholder="t.me/community"
                autoComplete="off"
                spellCheck={false}
                leading={<TelegramIcon size={15} />}
                value={telegram}
                disabled={busy}
                aria-invalid={tgUrl === undefined || undefined}
                onChange={(e) => setTelegram(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Paired asset" hint={COPY.create.pairedHelper}>
            <Select
              key={enabled.length > 0 ? "ready" : "loading"}
              defaultOpen={pairParam === "ANY" && enabled.length > 0}
              aria-label="Paired asset"
              value={asset?.address}
              placeholder={assetsQ.isPending ? "Loading…" : "No asset open for launches"}
              onChange={(v) => {
                setAssetAddr(v);
                setDevBuy("");
              }}
              options={enabled.map((a) => ({
                value: a.address,
                label: (
                  <span className="flex items-center gap-2.5">
                    <AssetIcon asset={a} size={20} />
                    {a.symbol}
                    {a.kind !== "native" && <span className="text-muted">{a.name}</span>}
                  </span>
                ),
              }))}
              className="h-12 w-full rounded-2xl"
            />
          </Field>

          {asset && (
            <DevBuyField
              value={devBuy}
              onChange={setDevBuy}
              onMax={setMax}
              balance={balance ?? 0n}
              expected={expected}
              symbol={ticker}
              asset={asset}
              disabled={busy}
            />
          )}

          <Accordion
            className="border-y border-border"
            items={[
              {
                value: "advanced",
                title: "Advanced",
                content: (
                  <Field label="Website" htmlFor="token-website" error={webUrl === undefined ? "Enter a web address, like yourcoin.com." : undefined}>
                    <Input
                      id="token-website"
                      placeholder="yourcoin.com"
                      autoComplete="off"
                      spellCheck={false}
                      leading={<Globe size={15} />}
                      value={website}
                      disabled={busy}
                      aria-invalid={webUrl === undefined || undefined}
                      onChange={(e) => setWebsite(e.target.value)}
                    />
                  </Field>
                ),
              },
            ]}
          />

          <div>
            <div className="flex items-center justify-between gap-4 text-13 text-muted">
              <span>{needsApproval && asset ? COPY.create.approveHint(asset.symbol) : COPY.create.summary(PARAMS.launchFeeEth)}</span>
              <span className="flex items-center gap-1.5 tabular" title="Estimated network fee">
                <Fuel size={14} aria-hidden />
                {gasCost !== undefined ? `≈ ${formatEth(gasCost)}` : "—"}
              </span>
            </div>
            <Button
              size="lg"
              className="mt-4 h-14 w-full text-base"
              loading={button.loading}
              disabled={button.disabled || button.loading}
              onClick={button.onClick}
            >
              {button.label}
            </Button>
            {metaError && step === "idle" && (
              <p role="alert" className="mt-3 text-13 text-sell">
                {metaError}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ---- live preview (under the form on mobile) */}
      <aside className="border-t border-border bg-surface-2/40 p-5 sm:p-8 lg:border-l lg:border-t-0 lg:p-10">
        <div className="lg:sticky lg:top-[calc(var(--header-h)+24px)]">
          <p className="mb-4 text-xs font-medium uppercase tracking-display text-muted">Preview</p>
          <TokenPreview data={preview} />
        </div>
      </aside>
    </div>
  );
}

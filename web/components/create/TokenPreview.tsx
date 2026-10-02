import { COPY, PARAMS, formatAsset, formatEth, formatUsd, type ListedAsset } from "@twain/shared";
import { Globe, Image as ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AssetIcon } from "@/components/common";
import { EthIcon, TelegramIcon, XIcon } from "@/components/ui";
import { CroppedImage } from "./CroppedImage";
import type { ImagePreview } from "./useImageUpload";

export type PreviewData = {
  name: string;
  ticker: string;
  description: string;
  image: ImagePreview | null;
  x: string | null;
  telegram: string | null;
  website: string | null;
  asset: ListedAsset | null;
  launchFee: bigint | null;
};

const usdOf = (amount: string, asset: ListedAsset) => (asset.usd == null ? null : (Number(amount) / 10 ** asset.decimals) * asset.usd);

function rows(asset: ListedAsset | null, launchFee: bigint | null): { label: string; value: ReactNode; sub?: string }[] {
  const startUsd = asset ? usdOf(asset.startMcap, asset) : null;
  const gradUsd = asset ? usdOf(asset.graduationMcap, asset) : null;
  return [
    {
      label: "Launch fee",
      value: (
        <span className="inline-flex items-center gap-1.5">
          {launchFee !== null ? formatEth(launchFee) : "—"} <EthIcon size={14} />
        </span>
      ),
      sub: "paid to Pons",
    },
    {
      label: "Paired with",
      value: asset ? (
        <span className="inline-flex items-center gap-1.5">
          {asset.symbol} <AssetIcon asset={asset} size={14} />
        </span>
      ) : (
        "—"
      ),
    },
    {
      label: "Start market cap",
      value: asset ? formatAsset(asset.startMcap, asset) : "—",
      sub: startUsd !== null ? `≈ ${formatUsd(startUsd)}` : undefined,
    },
    {
      label: "Moves to Uniswap at",
      value: asset ? formatAsset(asset.graduationMcap, asset) : "—",
      sub: gradUsd !== null ? `≈ ${formatUsd(gradUsd)} market cap` : "market cap",
    },
    {
      label: "Fee per trade",
      value: PARAMS.tradeFeePct,
      sub: `${PARAMS.ponsFeePct} Pons fee · ${PARAMS.creatorTaxPct} creator tax`,
    },
    { label: "You earn", value: PARAMS.creatorEarnsPct, sub: "of every trade's volume" },
    { label: "Supply", value: PARAMS.supply, sub: "no allocations" },
  ];
}

/** Live coin card + launch parameters (right column of /launchpad/create). */
export function TokenPreview({ data }: { data: PreviewData }) {
  const name = data.name.trim();
  const links = [
    data.x && { href: data.x, label: "X profile", icon: <XIcon size={14} /> },
    data.telegram && { href: data.telegram, label: "Telegram", icon: <TelegramIcon size={14} /> },
    data.website && { href: data.website, label: "Website", icon: <Globe size={14} /> },
  ].filter(Boolean) as { href: string; label: string; icon: ReactNode }[];

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-pop md:p-7">
      {data.image ? (
        <CroppedImage preview={data.image} alt={name || "Coin image"} className="size-20 rounded-image" />
      ) : (
        <span className="grid size-20 place-items-center rounded-image bg-surface-2 text-muted">
          <ImageIcon size={24} />
        </span>
      )}

      <p className={name ? "mt-5 break-words text-28 font-semibold text-text" : "mt-5 text-28 font-semibold text-muted"}>
        {name || COPY.create.previewEmptyName}
      </p>
      <p className="mt-1 text-sm text-muted">{data.ticker || COPY.create.previewEmptyTicker}</p>

      {data.description.trim() && (
        <p className="mt-3 line-clamp-3 whitespace-pre-line break-words text-sm leading-6 text-muted">{data.description.trim()}</p>
      )}

      {links.length > 0 && (
        <div className="mt-4 flex gap-2">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              aria-label={l.label}
              title={l.label}
              className="grid size-8 place-items-center rounded-full border border-border text-muted transition-colors hover:text-text"
            >
              {l.icon}
            </a>
          ))}
        </div>
      )}

      <dl className="mt-6 border-t border-border">
        {rows(data.asset, data.launchFee).map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4 border-b border-border py-3">
            <dt className="text-13 text-muted">{r.label}</dt>
            <dd className="text-right text-sm text-text">
              {r.value}
              {r.sub && <span className="block text-xs text-muted">{r.sub}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

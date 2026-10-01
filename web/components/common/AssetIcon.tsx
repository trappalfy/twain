import type { AssetInfo } from "@twain/shared";
import { EthIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** Icon of a coin's paired asset: the ETH mark, the asset's logo, or its ticker initial. */
export function AssetIcon({ asset, size = 16, className }: { asset: Pick<AssetInfo, "kind" | "logo" | "symbol">; size?: number; className?: string }) {
  if (asset.kind === "native") return <EthIcon size={size} className={className} />;
  if (asset.logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- third-party logo CDN, tiny and fixed size
      <img
        src={asset.logo}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-full bg-surface-2 object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-medium text-muted", className)}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.5) }}
    >
      {asset.symbol.slice(0, 1)}
    </span>
  );
}

"use client";

import { formatUsd, type ListedAsset } from "@twain/shared";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AssetIcon } from "@/components/common";
import { Dialog, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ListedAsset["kind"], string> = { native: "", stock: "stock", token: "token" };

/** Start market cap in USD (the whole supply at the curve's start price), when the asset has a USD price. */
function startUsd(a: ListedAsset): number | null {
  return a.usd == null ? null : (Number(a.startMcap) / 10 ** a.decimals) * a.usd;
}

/** Paired-asset choice for a new coin: every asset Pons accepts, searchable by ticker or name. */
export function AssetPicker({
  assets,
  value,
  onChange,
  disabled,
  defaultOpen,
  loading,
}: {
  assets: ListedAsset[];
  value: ListedAsset | undefined;
  onChange: (a: ListedAsset) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return assets;
    return assets.filter((a) => a.symbol.toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || a.address === s);
  }, [assets, q]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
      title="Choose the paired asset"
      className="max-w-lg"
      trigger={
        <button
          type="button"
          disabled={disabled || assets.length === 0}
          aria-label="Paired asset"
          className="flex h-12 w-full items-center gap-2.5 rounded-2xl border border-border bg-surface px-4 text-left text-sm text-text transition-colors hover:bg-surface-2 disabled:opacity-60"
        >
          {value ? (
            <>
              <AssetIcon asset={value} size={20} />
              <span className="font-medium">{value.symbol}</span>
              {value.kind !== "native" && <span className="truncate text-muted">{value.name}</span>}
            </>
          ) : (
            <span className="text-muted">{loading ? "Loading…" : "No asset open for launches"}</span>
          )}
          <ChevronDown size={16} className="ml-auto shrink-0 text-muted" aria-hidden />
        </button>
      }
    >
      <Input
        autoFocus
        placeholder="Search ticker or name"
        aria-label="Search assets"
        leading={<Search size={15} />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <p className="mt-3 text-xs text-muted">
        {assets.length} assets · start market cap of a new coin shown on the right
      </p>
      <ul role="listbox" aria-label="Assets" className="-mx-2 mt-2 max-h-[min(60vh,420px)] overflow-y-auto">
        {shown.map((a) => {
          const selected = a.address === value?.address;
          const usd = startUsd(a);
          return (
            <li key={a.address}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(a);
                  setOpen(false);
                  setQ("");
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-surface-2",
                  selected && "bg-surface-2",
                )}
              >
                <AssetIcon asset={a} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-text">
                    {a.symbol}
                    {KIND_LABEL[a.kind] && <span className="text-xs font-normal text-muted">{KIND_LABEL[a.kind]}</span>}
                  </span>
                  <span className="block truncate text-xs text-muted">{a.name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted tabular">{usd != null ? formatUsd(usd) : ""}</span>
                {selected && <Check size={16} className="shrink-0 text-accent-text" aria-hidden />}
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted">No asset matches “{q}”.</li>}
      </ul>
    </Dialog>
  );
}

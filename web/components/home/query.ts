import type { Hex, SortKey, WindowKey } from "@twain/shared";

/** Explore list state, kept in the URL query: /?sort=&window=&asset=&page= (defaults are omitted). */
export type ExploreState = { sort: SortKey; window: WindowKey; asset: Hex | "all"; page: number };

export const PAGE_SIZE = 25;
export const EXPLORE_ANCHOR = "explore";
/** The Explore list card itself. */
export const EXPLORE_PANEL_ANCHOR = "explore-panel";

/** Card grid: 1 → xs:2 → md:3 → lg:4 → xl:5 columns. */
export const GRID = "grid grid-cols-1 gap-3 xs:grid-cols-2 md:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:grid-cols-5";

export const SORTS: readonly { value: SortKey; label: string }[] = [
  { value: "recentBuys", label: "Recent buys" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "marketCap", label: "Market cap" },
  { value: "volume", label: "Volume" },
];

export const WINDOWS: readonly { value: WindowKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

export const DEFAULT_EXPLORE: ExploreState = { sort: "recentBuys", window: "all", asset: "all", page: 1 };

type Params = { get(name: string): string | null };

function pick<T extends string>(value: string | null, allowed: readonly { value: T }[], fallback: T): T {
  return allowed.some((a) => a.value === value) ? (value as T) : fallback;
}

export function parseExplore(sp: Params | null): ExploreState {
  if (!sp) return DEFAULT_EXPLORE;
  const page = Number.parseInt(sp.get("page") ?? "", 10);
  return {
    sort: pick(sp.get("sort"), SORTS, DEFAULT_EXPLORE.sort),
    window: pick(sp.get("window"), WINDOWS, DEFAULT_EXPLORE.window),
    asset: /^0x[0-9a-fA-F]{40}$/.test(sp.get("asset") ?? "") ? (sp.get("asset")!.toLowerCase() as Hex) : "all",
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** "/?sort=newest&page=2" — default values are left out; "/" when everything is default. */
export function exploreHref(state: ExploreState, hash?: string): string {
  const u = new URLSearchParams();
  if (state.sort !== DEFAULT_EXPLORE.sort) u.set("sort", state.sort);
  if (state.window !== DEFAULT_EXPLORE.window) u.set("window", state.window);
  if (state.asset !== DEFAULT_EXPLORE.asset) u.set("asset", state.asset);
  if (state.page > 1) u.set("page", String(state.page));
  const qs = u.toString();
  return `/${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}

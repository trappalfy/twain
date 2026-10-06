import type { Hex } from "@twain/shared";

/**
 * The official $TWAIN coin. It launches through twain like any other coin; until `address` is set the site shows a
 * pinned pre-launch card on Explore and a pre-launch page at /launchpad/twain, with no market data. After the launch
 * set `address` to its contract (lowercase): the card and the page switch to the live coin, and the indexer rebuilds
 * once (COIN_FILTER_ID changes) so the coin is indexed even though its name is reserved.
 *
 * `visible: false` takes $TWAIN off the site: no pinned card, /launchpad/twain and /twain answer 404, and a set
 * address stays out of the Explore list (its own page by address still opens, to check it before showing it).
 */
export const TWAIN_TOKEN: {
  address: Hex | null;
  visible: boolean;
  name: string;
  symbol: string;
  image: string;
  description: string;
  x: string;
} = {
  address: null,
  visible: false,
  name: "twainpad",
  symbol: "TWAIN",
  image: "/brand/twain-token.png",
  description:
    "$TWAIN is the token of twain, the Robinhood Chain launchpad where every coin trades against an asset you pick: ETH, USDG or stocks like NVDA.",
  x: "https://x.com/twainpad",
};

/** Coins the site never shows: the owner's test launches and impersonations of $TWAIN. */
export const HIDDEN_COINS: ReadonlySet<string> = new Set([
  "0x6d6cc41a8a4deab6055b28960f28b0feac99c628", // "test" · ETH — owner's test launch (2026-10-02)
  "0x781f6874f99af991a385c76df5ffdd94b3790857", // "test" · INTC — owner's test launch (2026-10-02)
  "0x504924e8af4fbe22f4934dc71863ff34fbc93c8d", // "TEST" · USDG — owner's test launch (2026-10-04)
  "0xb8e70911efef577bec47109241e34cdffd03c56d", // "TWAIN" — impersonation, not the official coin (2026-10-05)
]);

/** Name or ticker reserved for the official coin (exact match, case-insensitive, a leading "$" ignored). */
const RESERVED = "twain";
const isReserved = (s: string | null | undefined) => !!s && s.trim().replace(/^\$/, "").toLowerCase() === RESERVED;

export const isTwainToken = (address: string) => !!TWAIN_TOKEN.address && address.toLowerCase() === TWAIN_TOKEN.address.toLowerCase();

/** Hidden: listed above, or named / tickered exactly "twain" without being the official coin. */
export function isHiddenCoin(address: string, name?: string | null, symbol?: string | null): boolean {
  if (isTwainToken(address)) return false;
  return HIDDEN_COINS.has(address.toLowerCase()) || isReserved(name) || isReserved(symbol);
}

/** Identity of the rules above: when it changes the indexer drops its data and rebuilds with the new rules. */
export const COIN_FILTER_ID = [TWAIN_TOKEN.address ?? "none", RESERVED, ...[...HIDDEN_COINS].sort()].join(",");

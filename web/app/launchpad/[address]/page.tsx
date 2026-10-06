import { shortAddress, type Hex } from "@twain/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { TokenPage } from "@/components/token/TokenPage";
import { TwainPrelaunch } from "@/components/token/TwainPrelaunch";
import { TOKEN_TABS, type TokenTab } from "@/components/token/types";
import { TWAIN_TOKEN } from "@/config/twain-token";
import { api } from "@/lib/api";
import { isHiddenCoinPage } from "@/lib/server/hidden-coin";

type Props = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const isAddress = (a: string): a is Hex => /^0x[0-9a-fA-F]{40}$/.test(a);

/** /launchpad/twain: the official $TWAIN — its live page once the address is set, a pre-launch page until then; 404 while it is hidden. */
const OFFICIAL_SLUG = "twain";

/** Indexer record, or null (not indexed yet / indexer down). Shared by generateMetadata and the page. */
const loadToken = cache(async (address: string) => {
  try {
    return await api.token(address, AbortSignal.timeout(3_000));
  } catch {
    return null;
  }
});

/** The test launches and impersonations of $TWAIN (config/twain-token.ts) answer 404. */
const hidden = cache(async (address: Hex) => isHiddenCoinPage(address, (await loadToken(address)) != null));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  if (address.toLowerCase() === OFFICIAL_SLUG && TWAIN_TOKEN.visible && !TWAIN_TOKEN.address) {
    return { title: `${TWAIN_TOKEN.name} ($${TWAIN_TOKEN.symbol})`, description: TWAIN_TOKEN.description };
  }
  if (!isAddress(address) || (await hidden(address))) return {};
  const t = await loadToken(address);
  if (!t) return { title: `Token ${shortAddress(address)}` };
  // Root layout template appends " · twain".
  return {
    title: `${t.name} ($${t.symbol})`,
    description: t.meta.description?.trim().slice(0, 200) || `${t.name} ($${t.symbol}) on twain, a token launchpad on Robinhood Chain.`,
  };
}

export default async function Page({ params, searchParams }: Props) {
  const [{ address }, sp] = await Promise.all([params, searchParams]);
  if (address.toLowerCase() === OFFICIAL_SLUG) {
    if (!TWAIN_TOKEN.visible) notFound();
    if (TWAIN_TOKEN.address) redirect(`/launchpad/${TWAIN_TOKEN.address}`);
    return <TwainPrelaunch />;
  }
  if (!isAddress(address) || (await hidden(address))) notFound();

  const side = sp.side === "buy" || sp.side === "sell" ? sp.side : undefined;
  const tab = TOKEN_TABS.find((t) => t === sp.tab) as TokenTab | undefined;
  const initial = await loadToken(address);

  return <TokenPage address={address} initial={initial} initialSide={side} initialTab={tab} />;
}

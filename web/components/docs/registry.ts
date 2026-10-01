import { PARAMS } from "@lancio/shared";
import type { MDXContent } from "mdx/types";

export type DocImage = { src: string; alt: string };

export type DocEntry = {
  /** "" is the docs index (/docs). */
  slug: string;
  title: string;
  /** One line under the title; also the page's meta description. */
  summary: string;
  /** Picture shown under the title. */
  image?: DocImage;
  load: () => Promise<{ default: MDXContent }>;
};

/** Docs in sidebar order. */
export const DOCS: DocEntry[] = [
  {
    slug: "",
    title: "How it works",
    summary: "Launch a coin paired with any listed asset. The whole supply goes into its own Uniswap pool, locked for good, in one transaction.",
    image: { src: "/brand/painting-arsenale-launch-full.png", alt: "A galley sliding down the slipway of the Venetian Arsenale into the lagoon" },
    load: () => import("@/content/docs/how-it-works.mdx"),
  },
  {
    slug: "paired-assets",
    title: "Paired assets",
    summary: "Every coin trades against one asset: ETH, a tokenized stock or another listed token. Its price and fees are counted in it.",
    load: () => import("@/content/docs/paired-assets.mdx"),
  },
  {
    slug: "the-price",
    title: "The price",
    summary: "The pool starts at the asset's start market cap and follows x · y = k from there. Every buy moves the price up, every sell moves it down.",
    load: () => import("@/content/docs/the-price.mdx"),
  },
  {
    slug: "liquidity-lock",
    title: "Liquidity lock",
    summary: "The pool position sits in a contract that can do one thing: collect trading fees. It has no withdraw function and cannot be upgraded.",
    image: { src: "/brand/painting-key.png", alt: "A hand dropping a key into the lagoon above a locked chest" },
    load: () => import("@/content/docs/liquidity-lock.mdx"),
  },
  {
    slug: "fees",
    title: "Fees",
    summary: `Every trade pays the pool ${PARAMS.poolFeePct}: ${PARAMS.creatorFeePct} to the creator and ${PARAMS.protocolFeePct} to the protocol, for as long as the coin trades.`,
    image: { src: "/brand/painting-colleganza.png", alt: "Two merchants signing a contract by candlelight" },
    load: () => import("@/content/docs/fees.mdx"),
  },
  {
    slug: "contracts",
    title: "Contracts",
    summary: "Addresses, verified source, and the exact powers of the owner.",
    load: () => import("@/content/docs/contracts.mdx"),
  },
  {
    slug: "risks",
    title: "Risks",
    summary: "What the rules protect, and what they do not.",
    load: () => import("@/content/docs/risks.mdx"),
  },
  {
    slug: "faq",
    title: "FAQ",
    summary: "Short answers to the questions people ask first.",
    load: () => import("@/content/docs/faq.mdx"),
  },
];

export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");

export function getDoc(slug: string) {
  const i = DOCS.findIndex((d) => d.slug === slug);
  if (i === -1) return null;
  return { doc: DOCS[i], index: i, prev: DOCS[i - 1] ?? null, next: DOCS[i + 1] ?? null };
}

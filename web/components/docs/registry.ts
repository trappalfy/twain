import { PARAMS } from "@twain/shared";
import type { MDXContent } from "mdx/types";

export type DocEntry = {
  /** "" is the docs index (/docs). */
  slug: string;
  title: string;
  /** One line under the title; also the page's meta description. */
  summary: string;
  load: () => Promise<{ default: MDXContent }>;
};

/** Docs in sidebar order. */
export const DOCS: DocEntry[] = [
  {
    slug: "",
    title: "How it works",
    summary:
      "Launch a coin paired with ETH or a tokenized stock. It trades on its own launch curve first, then moves into a Uniswap pool whose liquidity is locked forever.",
    load: () => import("@/content/docs/how-it-works.mdx"),
  },
  {
    slug: "paired-assets",
    title: "Paired assets",
    summary: "Every coin trades against one asset: ETH, a tokenized stock or another token Pons accepts. Its price and its fees are counted in that asset.",
    load: () => import("@/content/docs/paired-assets.mdx"),
  },
  {
    slug: "the-price",
    title: "The launch curve",
    summary: "A coin starts on its own curve: x · y = k from the pair's start market cap. Every buy moves the price up, every sell moves it down, until the curve sells out.",
    load: () => import("@/content/docs/the-price.mdx"),
  },
  {
    slug: "liquidity-lock",
    title: "Graduation and lock",
    summary: "When its curve sells out, a coin moves into a Uniswap v4 pool. The pool position is locked forever in a contract with no withdraw function.",
    load: () => import("@/content/docs/liquidity-lock.mdx"),
  },
  {
    slug: "fees",
    title: "Fees",
    summary: `Every trade pays ${PARAMS.tradeFeePct}, on the curve and in the pool. The creator earns ${PARAMS.creatorEarnsPct} of trading volume, paid in the pair asset, for as long as the coin trades.`,
    load: () => import("@/content/docs/fees.mdx"),
  },
  {
    slug: "contracts",
    title: "Contracts",
    summary: "Addresses, verified source, and exactly what twain, Pons and Uniswap can and cannot change.",
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

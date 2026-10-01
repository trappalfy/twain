/**
 * Copy and links of the site header (twain header brief, section 8; nav trimmed by the owner on 2026-10-01).
 * Copy is final: use it verbatim.
 */
export const siteConfig = {
  name: "twain",
  title: "twain — Pair your coin with anything",
  description: "Launch a coin paired with any asset, from memes to tokenized stocks.",
  links: {
    launch: "/launchpad/create",
    pairing: "/docs/paired-assets", // "See how pairing works"
  },
  nav: [
    { label: "Launch", href: "/launchpad/create" },
    { label: "Pairs", href: "/#explore-panel" }, // the pair filter of Explore, right under the hero
    { label: "Docs", href: "/docs" },
  ],
  x: { handle: "twainpad", href: "https://x.com/twainpad" },
  hero: {
    pill: "Built on Robinhood Chain",
    titleBefore: "Pair your coin with ",
    titleAccent: "anything",
    titleAfter: ".",
    subtitle:
      "Launch a coin against any asset, from memes to tokenized stocks. Pick the pair, name the coin, and the pool opens with exactly what you chose.",
    primary: "Launch a coin",
    secondary: "See how pairing works",
  },
} as const;

/**
 * UI copy: calm, exact, short. No emoji, no hype, no "safe"/"guaranteed".
 * Mechanics wording is current; the brand voice is rewritten with the redesign.
 */
import { PARAMS } from "./constants";

export const COPY = {
  hero: {
    ctaLaunch: "Launch a coin",
    ctaExplore: "Explore coins",
  },
  explore: {
    title: "Explore",
    subtitle: "Every coin starts on its own launch curve, then moves into a locked Uniswap pool.",
    empty: "No coins yet. Be the first to launch.",
    searchPlaceholder: "Search coins",
  },
  create: {
    title: "Launch coin",
    pairedHelper: "Your coin trades against this asset: first on its launch curve, then in a Uniswap pool. The pair cannot change later.",
    devBuyHelper: (balance: string) => `${balance} in wallet. You buy first, in the launch transaction, at the start price.`,
    summary: (fee: string) => `${fee} ETH launch fee + gas`,
    approveHint: (symbol: string) => `Approve ${symbol} once so the launch can make your first buy.`,
    needDetails: "Add a name and ticker",
    success: "Launched. Your coin is live.",
    previewEmptyName: "Your coin",
    previewEmptyTicker: "ticker",
  },
  forum: {
    title: "Forum",
    subtitle: "A room for every launch. The liveliest threads rise first.",
    sidebarTitle: "Largest by market cap",
    sidebarSearch: "Ticker, name or address",
    sidebarLink: "Open Explore",
  },
  analytics: {
    title: "Protocol analytics",
    subtitle: "Every market on Robinhood Chain launched here, read from onchain events.",
    footnote:
      "Figures come from the site's indexer of onchain events. USD values use each asset's current price. The 24h view covers the last full UTC day.",
    chartSubtitle: "Last 14 UTC days. The most recent full day is in bright blue.",
    emptyChart: "The first day of data appears after the first UTC day closes.",
    empty: "No launches yet. The figures fill in with the first coin.",
  },
  token: {
    waitingFirstTrade: "Waiting for the first trade.",
    lockedPlate: "Liquidity locked forever",
  },
  profile: {
    empty: "Nothing launched yet.",
  },
  notFound: "This page was never launched.",
  footer: {
    description: `Launch a coin paired with ETH or a tokenized stock on Robinhood Chain. Every coin follows the same rules: ${PARAMS.supply} supply, a launch curve first, then a Uniswap pool with its liquidity locked forever. You sign every transaction, and the site never holds your funds.`,
    riskTitle: "Risk notice",
    risk:
      "You sign every transaction yourself, and a confirmed transaction cannot be undone. Coins here are launched by their users, not by this site, and can lose all of their value. Nothing on this site is custody, a guarantee, or financial advice.",
  },
  errors: {
    SlippageExceeded: "Price moved. Try again or raise slippage.",
    InsufficientEth: "Not enough ETH (including gas).",
    DeadlineExpired: "The transaction waited too long. Try again.",
    CreationPaused: "New launches are paused for now.",
    AssetNotEnabled: "This asset is not open for new launches.",
    UserRejected: "Signature declined in wallet.",
  },
  og: ["Pair your coin with ETH or a stock.", "How twain works"],
  audit: "twain's contracts are open source and verified, but have not been externally audited.",
} as const;

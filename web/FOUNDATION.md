# web/ foundation — read this first

Next.js 16 (App Router, Turbopack), React 19, TypeScript strict, Tailwind v4, wagmi 2 + viem + RainbowKit 2, React Query 5.
Next 16 differs from older docs: `params`/`searchParams` are **Promises** (`const { address } = await params`); bundled docs are in `node_modules/next/dist/docs/`.

```
pnpm --filter @twain/web dev | build | typecheck | lint      # from repo root
```
Local data comes from a real chain: `scripts/dev-chain.sh` (mainnet fork + contracts) and `contracts/script/Seed.s.sol` (demo coins and trades). Without a launchpad address the site runs in prelaunch mode (empty lists, `lib/prelaunch.ts`). All deps are installed — **do not add dependencies**.

## Conventions (non-negotiable)
- **Colours only via tokens** (below). Tailwind's default palette is removed (`text-white`, `bg-black`, `text-red-500` don't exist). No hex in components. Use `/alpha` modifiers on tokens (`bg-accent/20`, `border-border/60`).
- **Copy from `COPY`** (`@twain/shared`). Missing string → write it in the same calm, exact voice; no emoji/hype/"safe"/"guaranteed"/"audited".
- **Numbers via shared formatters** (`formatAsset`, `formatPriceAsset`, `formatUsd`, `formatTokens`, `formatEth`, `formatPct`, `shortAddress`, `timeAgo`) and **protocol numbers from shared constants/`PARAMS`** — never hard-code "1%", "60/40", "1,000,000,000". Every coin has its own paired asset (`token.asset`: symbol, decimals, logo, USD price): never assume ETH.
- Sora everywhere (`font-sans`); `font-heading` (Sora 600, tight tracking) for page/section titles. Addresses/hashes in `font-mono` (JetBrains Mono).
- **Liquid glass only through `components/ui/liquid-glass.tsx`** (`LiquidButton`, `LiquidSurface`; twain header brief 6). No opacity/filter/mask/clip-path/mix-blend-mode/will-change on ancestors of glass elements; at most 7 refracting elements per screen.
- Server components by default; add `"use client"` only where hooks/state are needed.
- Don't edit foundation files (list at the bottom). Need a change? Put it in your own area file or report it.

## Design tokens (`app/globals.css`)
Theme: one light "ice" theme (twain, 2026-10-01), no toggle. Every text token is ≥ 4.5:1 on `bg`, `surface`, `surface-2` (contrast table in the `globals.css` header). twain header tokens: `ink`, `ink-2`, `brand` (#2E9BFF, accents and focus), `page`, `shadow-lift`.

| Utility colour | Use |
|---|---|
| `bg` `surface` `surface-2` | page / section cards / nested cards, inputs, pill-tab track |
| `border` | lines, frames, progress track |
| `text` `muted` | primary / secondary text |
| `accent` | navy **fill** (CTA, active page). Text on it: `text-on-accent` |
| `accent-text` | blue usable **as text** (links, fresh time) |
| `accent-soft` | 13% brand-blue tint behind `accent-text` (chips, highlights) |
| `buy` `sell` | green / red **text** (sides, +/- change) |
| `buy-bg`+`on-buy`, `sell-bg`+`on-sell` | filled Buy / Sell buttons |
| `crimson`+`on-crimson` | decorative badge fill (never crimson text) |
| `cream` | white text over dark images |
| `pill-active` | active pill in a `surface-2` track |
| `overlay` | modal backdrop |

Other theme values: text sizes `text-13 text-28 text-40 text-56` (plus Tailwind `text-xs/sm/base/xl`) → scale 12/13/14/16/20/28/40/56; radii `rounded-section` (28) `rounded-card` (20) `rounded-image` (14), pills `rounded-full`; shadows `shadow-section`, `shadow-pop`; `tracking-display`; breakpoint `xs` = 480px (grid: 1 → xs:2 → md:3 → lg:4 → xl:5).

Custom utilities: `container-page` (1200px content, 16px gutters) · `font-heading` (Sora 600, tight tracking) · `under-header` (section starts under the fixed nav capsule) · `tabular` · glass classes `.lg-*` (used by `liquid-glass.tsx` only) · `hero-in` (hero entrance, `--i` = step). Body has `tabular-nums` on by default. `--header-h` = 100px (space the fixed nav capsule takes; `<main>` is padded by it).

For canvases/charts use `cssVar("--accent")` from `lib/theme.ts`.

## lib/
- **`utils.ts`** — `cn(...classes)` (clsx + tailwind-merge aware of the custom sizes/radii).
- **`config.ts`** — `config = { chainId, rpcUrl, siteUrl, prelaunch, heroLiveStats, banner: {id,title,text}|null, walletConnectProjectId, ipfsGateway, deployment: {launchpad, locker, startBlock} }`. Every `NEXT_PUBLIC_*` is read literally here — read env **only** through `config`. `deployment.launchpad` is the zero address until contracts are deployed/env set.
- **`wagmi.ts`** — `appChain` (Robinhood Chain, id from env, RPC from env), `wagmiConfig` (RainbowKit defaults when a WalletConnect id exists, else injected wallets only; `ssr: true`). Registered with wagmi's `Register`, so hooks are fully typed.
- **`providers.tsx`** — `<Providers>`: Wagmi, React Query, RainbowKit (light twain theme), Radix Tooltip provider, sonner `<Toaster>`. Already mounted in the root layout.
- **`api.ts`** — typed client for every route in `packages/shared/src/api-types.ts`, answered by the built-in indexer: same-origin `/api/…` in the browser, in-process (`globalThis.__twainIndexer`, set by `instrumentation.ts`) on the server; `lib/prelaunch.ts` before a deployment exists.
- **`../indexer/`** — built-in indexer (sync-on-read). `schema.ts` (Postgres schema `twain_ix`, bump `SCHEMA_VERSION` on any table/handler change → rebuilt from START_BLOCK), `apply.ts` (handlers for Launchpad, LiquidityLocker, coin Transfers and pool Swaps), `sync.ts` (lease + conditional cursor; runs in `after()` of API responses, throttled to 2 s), `prices.ts` (asset details and USD prices: ETH from exchanges, stock tokens from Robinhood's API), `queries.ts` (USD computed at read time; `usdSql` sorts across assets), `api.ts` (Hono app), `server.ts` (route handler + in-process `ixGet`). Routes: `app/api/{assets,tokens,stats,accounts,search,top}`, status `app/api/indexer`. DB connection shared with the forum: `db/connection.ts`.
  - Fetchers (usable on server too, e.g. `generateMetadata`): `api.assets()`, `api.tokens(q)`, `api.token(addr)`, `api.candles(addr, interval, {from,to})`, `api.trades(addr, {limit, before})`, `api.holders(addr, limit)`, `api.stats(window)`, `api.daily(days)`, `api.account(addr)`, `api.holdings(addr)`, `api.accountTrades(addr, {limit, before})`, `api.search(q)`, `api.top(limit)`, `api.ethUsd()`.
  - Hooks (client): `useAssets()`, `useTokens(q)`, `useToken(addr)`, `useCandles(addr, interval)`, `useTrades(addr, limit=50)`, `useHolders(addr, limit=20)`, `useStats("24h"|"all")`, `useDaily(days=14)`, `useAccount(addr)`, `useHoldings(addr)`, `useAccountTrades(addr, limit=50)`, `useSearch(q)` (disabled when empty; debounce in caller), `useTop(limit=10)`, `useEthUsd()`. Live data refetches every `LIVE_MS` (4 s); list/candle hooks keep previous data while loading the next key. Address hooks are disabled until the address is a valid `0x…40`.
  - `ApiError` (`.status`; `useToken` 404 → `error.status === 404`, no retry). Query keys: `qk.*` (all start with `"twain"`).
- **`errors.ts`** — `toFriendlyError(err)` (launchpad/locker custom errors → `COPY.errors` or short text; user rejection; insufficient funds; chain mismatch), `isUserRejection(err)`, `revertErrorName(err)`.
- **`tx.ts`** — `useTx()` → `{ run, writeContractAsync, status, hash, receipt, error, reset, busy }`.
  `await tx.run(() => tx.writeContractAsync({ address: config.deployment.launchpad, abi: launchpadAbi, functionName: "buy", args, value }), { pending?, success? })`
  Toasts "Confirm in wallet" → "Pending…" (explorer link) → "Confirmed" | "Failed: {reason}"; wallet decline → neutral note, status `"rejected"`. Resolves with the receipt (null on reject/fail) and invalidates all queries (again after 2 s for indexer lag). `run` accepts any `() => Promise<Hash>` (e.g. `sendTransactionAsync` for the Universal Router).
- **`usd.ts`** — ETH-only helpers: `useFormatUsd()` → `(wei) => "$22k"` or ETH fallback; `useWeiToUsd()`. For coin values use the asset's own `usd` (API) or `AssetValue` / `CoinMcap`.
- **`uniswap.ts`** — `coinPoolKey(coin, asset)`, `poolIdOf`, `encodeExactInSingle` (Universal Router V4_SWAP), `poolImpactBps`, `routerAbi`.
- **`theme.ts`** — `cssVar(name)`.
- **`identicon.ts`** — `identiconSvg(seed, size)`, `svgDataUri(svg)`.

ABIs: `import { launchpadAbi, lockerAbi, tokenAbi, v4QuoterAbi, universalRouterAbi, permit2Abi, poolManagerAbi } from "@twain/shared/abi"` (not re-exported from the package root). Uniswap v4 addresses: `UNISWAP_V4` from `@twain/shared`.

## components/ui/ (import from `@/components/ui`)
- `Button` — `variant: accent|outline|ghost|buy|sell`, `size: sm|md|lg|icon|icon-sm`, `loading`, `href` (internal → `<Link>`, `http…` → new tab), plus button props. `buttonClass(variant, size, className)` for custom elements.
- `Card` — section card (`as`, `padded`=true → 20/32px). `SubCard` — nested `surface-2` card (`padded`). `CardHeader` — `{title, count?, subtitle?, actions?}` (heading row like "Explore · 4,228,127 launched" with controls right).
- `PillTabs<T>` — controlled `{value, onChange, items:{value,label,disabled?}[]}` or links `{items:{href,label,active}[]}`; `size: sm|md`.
- `Badge` — `variant: new | outline | neutral | crimson`; opaque, safe on images. `CountPill` — count next to a title.
- `Input` (`leading`, `trailing`, `inputClassName`), `Textarea`, `Field` (`{label, hint, error, htmlFor, aside}` — aside e.g. "0 / 280").
- `Skeleton`, `Spinner` (`size`), `ProgressBar` (`bps` 0..10000; label with `formatProgress`).
- `Tooltip` (`{content, side}` — child must be focusable), `Dialog` (`{open, onOpenChange, trigger?, title, description?, footer?}`, `DialogClose`), `Sheet` (`side: bottom|right|left`, same API, `SheetClose`), `Dropdown` (`{trigger, items: {label, icon?, href? | onSelect?, danger?} | {type:"separator"} | {type:"label", label}, align}`), `Accordion` (`{items:{value,title,content}[], type, defaultValue}`), `Select<T>` (`{value, onChange, options, placeholder}`).
- `Pagination` — `{page, totalPages, hrefFor(page)}` → ‹ 1 2 … 20 › (links, `scroll={false}`); `pageList()` helper.
- `StatTile` — `{label, value, sub?, hint?, size: md|lg|xl}` (value pre-formatted).
- `EmptyState` — `{title, description?, action?}`.
- Icons: use `lucide-react`; brand glyphs `XIcon`, `TelegramIcon`, `EthIcon` from `@/components/ui` (EthIcon is the only cool colour allowed).

## components/common/ (import from `@/components/common`)
- `TokenImage` — `{src, alt, size (px | "fill"), seed (address), sizes?, priority?}`; square rounded, identicon fallback on missing/failed image. `"fill"` needs a positioned parent (e.g. `relative aspect-square`).
- `Identicon` — `{address, size}` deterministic brand-palette avatar.
- `AddressLink` — `{address, kind: address|token|tx, copy?, href?}`; short mono address → explorer, or internal `href` + small explorer arrow.
- `CopyButton` — `{value, label?}`.
- `TimeAgo` — `{ts, freshSeconds=10}` live "8s ago"; blue while fresh.
- `EthAmount` — `{wei, unit?, digits?}`. `UsdAmount` — `{wei}` via `useEthUsd`, ETH fallback. `AssetValue` — `{amount, asset}` USD or asset units. `CoinMcap` — `{token}`. `AssetIcon` — `{asset, size}` ETH mark, logo or initial.

## Header, layout & brand
- `SiteNav` (`components/site-nav.tsx`, twain header brief 7.1) — fixed glass capsule on every page: wordmark → `/`, links from `siteConfig.nav` (Launch · Pairs · Docs), round X link (`siteConfig.x`), `WalletButton`; dense glass after 24px of scroll; burger menu at <= 860px (X moves into it at <= 520px).
- `Hero` (`components/hero.tsx`, server) + `HeroVideo` (client: poster → muted loop, none under reduced motion / Save-Data, paused off screen). Copy and links in `config/site.ts` (verbatim from the brief).
- `WalletButton` — ink glass `LiquidButton`: Connect wallet → identicon + address with a menu (Profile, Creator fees → `/profile#creator-fees`, Copy address, Disconnect); wrong chain → "Switch network". `Footer`. `StatusBanner` (env-driven, per-id dismissal).
- `components/icons.tsx` — `TwainMark`, `TwainWordmark` (inline SVG, `currentColor`), `IconMenu`, `IconClose`. Static files: `public/brand/twain-mark.svg`, `twain-wordmark.svg`; header media in `public/media/` (`twain-header.mp4`, `-720.mp4`, `-poster.jpg`, the poster is also the OG/404 background).
- Glass playground: `/dev/liquid-glass` (404 in production).

## Cross-area stubs (final signatures — owners replace bodies)
- `components/trade/TradePanel.tsx` — `TradePanel({ token: TokenDetail; initialSide?: "buy"|"sell" })`
- `components/trade/CreatorFeesCard.tsx` — `CreatorFeesCard({ token: TokenDetail })`
- `components/forum/TokenForumTab.tsx` — `TokenForumTab({ token: TokenSummary })`
- `components/forum/AccountPostsTab.tsx` — `AccountPostsTab({ address: \`0x${string}\` })`

## Ownership
**Foundation (don't edit):** `app/layout.tsx`, `app/globals.css`, `app/manifest.ts`, app icons, `next.config.ts`, `mdx-components.tsx` (docs may extend styles), `lib/*`, `components/ui/*`, `components/common/*`, `components/layout/*`, `components/site-nav.tsx`, `components/hero*.tsx`, `components/icons.tsx`, `config/site.ts`.

**Page areas (own their route files + a `components/<area>/` folder, create what you need there):**
- Home / Explore — `app/page.tsx`, `components/home/`, `components/token/` (token cards shared with other pages)
- Create — `app/launchpad/create/`, `components/create/`
- Token page + trading — `app/launchpad/[address]/`, `components/trade/` (TradePanel, CreatorFeesCard, chart, trades, holders)
- Forum — `app/forum/**`, `components/forum/` (TokenForumTab, AccountPostsTab), `app/api/forum/**`
- Analytics — `app/analytics/`, `components/analytics/`
- Profile — `app/profile/**`, `components/profile/`
- Docs / legal / 404 — `app/docs/**`, `app/legal/**`, `app/not-found.tsx`, `components/docs/`

Route params: `/forum/[token]` takes the **token address** (tickers are not unique), `/forum/post/[id]`, `/profile/[address]`, `/launchpad/[address]`. `/launchpad` 301 → `/`.

## Env
`web/.env.local` (gitignored) and repo `.env.example`: `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `NEXT_PUBLIC_HERO_LIVE_STATS`, `NEXT_PUBLIC_BANNER_ID/TITLE/TEXT`, `NEXT_PUBLIC_IPFS_GATEWAY`, `NEXT_PUBLIC_LAUNCHPAD/LOCKER/START_BLOCK`. Server-only: `PINATA_JWT`, `DATABASE_URL`, `SESSION_SECRET`, `INDEXER_RPC_URL` (optional fallback RPC for the built-in indexer), `PGLITE_DIR` (local PGlite dir). A new `NEXT_PUBLIC_*` must be added to `lib/config.ts` (foundation) — report it instead of reading `process.env` in pages.

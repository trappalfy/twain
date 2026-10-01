#!/usr/bin/env node
// Start market caps for the asset list (assets/<chainId>.json) from live USD prices: every asset starts at the
// same USD value as an ETH coin (ETH_START_MCAP wei, default 2.73 ETH). Prints a table to stderr and the
// Deploy.s.sol env to stdout:
//   eval "$(node script/asset-mcaps.mjs)" && forge script script/Deploy.s.sol …
// Prices: ETH from exchanges (packages/shared/src/prices.ts), Robinhood stock tokens from Robinhood (mid of the
// token bid/ask), other tokens from GeckoTerminal with DexScreener as fallback. Decimals are read from the chain.
// The values are fixed onchain at listing; re-run and call setAsset again to re-peg an asset for future coins.
import { readFileSync } from "node:fs";
import { ethUsdSources } from "../../packages/shared/src/prices.ts";

const CHAIN_ID = process.env.CHAIN_ID ?? "4663";
const RPC = process.env.RPC_URL_4663 || "https://rpc.mainnet.chain.robinhood.com";
const ETH_START_MCAP = BigInt(process.env.ETH_START_MCAP ?? "2730000000000000000");
const NATIVE = "0x0000000000000000000000000000000000000000";
const MAX_START_MCAP = 10n ** 42n; // Launchpad.MAX_START_MCAP

const list = JSON.parse(readFileSync(new URL(`../assets/${CHAIN_ID}.json`, import.meta.url), "utf8")).assets;
const lc = (a) => a.toLowerCase();

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "twain-asset-mcaps" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function ethUsd() {
  for (const src of ethUsdSources(process.env.COINGECKO_API_KEY)) {
    try {
      const usd = src.parse(await getJson(src.url));
      if (usd !== undefined) return usd;
    } catch {
      /* next source */
    }
  }
  throw new Error("ETH/USD unavailable");
}

async function decimals(address) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: address, data: "0x313ce567" }, "latest"] }),
  });
  const { result } = await res.json();
  if (!result || result === "0x") throw new Error(`decimals() failed for ${address}`);
  return Number(BigInt(result));
}

/** Robinhood stock tokens: address → USD (mid of the token-denominated bid/ask). */
async function stockPrices(addresses) {
  const { assets } = await getJson("https://api.robinhood.com/rhj/assets");
  const symbolOf = new Map();
  for (const a of assets) {
    const d = a.deployments?.find((x) => String(x.chainId) === CHAIN_ID && x.contractAddress);
    if (d) symbolOf.set(lc(d.contractAddress), a.tokenSymbol);
  }
  const out = new Map();
  for (const addr of addresses) {
    const symbol = symbolOf.get(addr);
    if (!symbol) continue;
    const q = (await getJson(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`)).quotes?.[0];
    const bid = Number(q?.tokenBid ?? q?.bid);
    const ask = Number(q?.tokenAsk ?? q?.ask);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
    if (mid > 0) out.set(addr, mid);
  }
  return out;
}

/** Other tokens: address → USD from GeckoTerminal, gaps filled from DexScreener's deepest pair. */
async function tokenPrices(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30).join(",");
    try {
      const gt = await getJson(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/${batch}`);
      for (const t of gt.data ?? []) {
        const usd = Number(t.attributes?.price_usd);
        if (usd > 0) out.set(lc(t.attributes.address), usd);
      }
    } catch {
      /* fallback below */
    }
  }
  const missing = addresses.filter((a) => !out.has(a));
  for (let i = 0; i < missing.length; i += 30) {
    const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/robinhood/${missing.slice(i, i + 30).join(",")}`);
    const best = new Map();
    for (const p of pairs) {
      const a = lc(p.baseToken.address);
      const liq = p.liquidity?.usd ?? 0;
      if (missing.includes(a) && Number(p.priceUsd) > 0 && liq > (best.get(a)?.liq ?? -1)) best.set(a, { liq, usd: Number(p.priceUsd) });
    }
    for (const [a, b] of best) out.set(a, b.usd);
  }
  return out;
}

/** floor(ratio × 10^decimals) for a positive float ratio, in exact integer math past its 13 significant digits. */
function toUnits(ratio, dec) {
  const [m, e] = ratio.toExponential(12).split("e");
  const digits = BigInt(m.replace(".", ""));
  const exp = Number(e) - 12 + dec;
  return exp >= 0 ? digits * 10n ** BigInt(exp) : digits / 10n ** BigInt(-exp);
}

const erc20 = list.filter((a) => lc(a.address) !== NATIVE);
const stocks = erc20.filter((a) => a.kind === "stock").map((a) => lc(a.address));
const tokens = erc20.filter((a) => a.kind !== "stock").map((a) => lc(a.address));
const [eth, stockUsd, tokenUsd, decs] = await Promise.all([
  ethUsd(),
  stockPrices(stocks),
  tokenPrices(tokens),
  Promise.all(erc20.map((a) => decimals(a.address))),
]);
const targetUsd = (Number(ETH_START_MCAP) / 1e18) * eth;

const rows = [];
const failed = [];
erc20.forEach((a, i) => {
  const usd = (a.kind === "stock" ? stockUsd : tokenUsd).get(lc(a.address));
  if (!usd) return failed.push(`${a.symbol} ${a.address}: no USD price`);
  const mcap = toUnits(targetUsd / usd, decs[i]);
  if (mcap <= 0n || mcap > MAX_START_MCAP) return failed.push(`${a.symbol}: start mcap ${mcap} out of range`);
  rows.push({ ...a, usd, decimals: decs[i], mcap });
});

const fmt = (n) => n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
console.error(`ETH/USD ${fmt(eth)} · start mcap ${Number(ETH_START_MCAP) / 1e18} ETH ≈ $${fmt(targetUsd)} for every asset\n`);
for (const r of rows) {
  const whole = Number(r.mcap) / 10 ** r.decimals;
  console.error(`${r.symbol.padEnd(10)} ${r.kind.padEnd(6)} $${fmt(r.usd).padEnd(14)} start ${fmt(whole)} ${r.symbol}`);
}
if (failed.length) {
  console.error(`\nNo start mcap for:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`export ETH_START_MCAP=${ETH_START_MCAP}`);
console.log(`export ASSET_ADDRESSES=${rows.map((r) => r.address).join(",")}`);
console.log(`export ASSET_START_MCAPS=${rows.map((r) => r.mcap).join(",")}`);

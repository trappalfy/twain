/**
 * Sync-on-read: API requests call `maybeSync()` after responding (next/server `after`). A sync pulls twain's logs
 * since the last indexed block, applies them and advances the cursor in one transaction. Nothing runs while nobody
 * is on the site; the first visitor after a pause triggers a catch-up.
 *
 * Sources per range: the TwainLauncher, every coin with its Pons curve (until graduation) and fee vault, the Pons
 * factory (graduations, fee-recipient overrides, pair-token approvals — filtered to twain coins), PoolManager Swaps in
 * the graduated pools and the Pons hook's fee for those swaps. Once per schema, the factory's pair-token history
 * before the launcher's start block is loaded too (the asset list).
 *
 * Concurrency: a lease row stops parallel instances from fetching the same range, and the cursor update is
 * conditional (`WHERE cursor = <from - 1>`), so a range is applied exactly once even if a lease expires mid-sync.
 */
import { PONS_V2 } from "@twain/shared";
import { ponsCurveAbi, ponsFactoryAbi, ponsTokenAbi } from "@twain/shared/abi";
import { and, eq, lt } from "drizzle-orm";
import { erc20Abi, hexToNumber, parseEventLogs, toEventSelector, type RpcLog } from "viem";
import { isHiddenCoin } from "@/config/twain-token";
import { config } from "@/lib/config";
import { ABIS, Batch, ponsPoolId, type AssetMeta, type DecodedLog, type EthEconomics, type Ev, type HookFee, type LaunchInfo } from "./apply";
import { ixDb, ixTx, type IxDb } from "./db";
import { getLogs, isLocal, MAX_SPAN, MAX_SPAN_SINGLE, rpc } from "./rpc";
import { asset, syncState, token } from "./schema";
import { chunk, LAUNCHER, lc, mapLimit, MEME_HOOK, PONS_FACTORY, POOL_MANAGER, type Hex } from "./shared";

/** Minimum time between two syncs. */
const THROTTLE_MS = 2_000;
/** A sync that dies keeps others out for at most this long. */
const LEASE_MS = 30_000;
/** Stop starting new ranges after this long (catch-ups continue on the next request). */
const BUDGET_MS = 20_000;
/** Stay this many blocks (~2 s) behind the head, so a lagging RPC node cannot return a partial range (anvil: none). */
const LAG_BLOCKS = isLocal ? 0 : 20;

const START_BLOCK = Math.max(0, config.deployment.startBlock);
/** The asset list is replayed from the Pons factory's deploy up to here; the regular sync takes over after it. */
const ASSETS_UNTIL = Math.max(0, START_BLOCK - 1);

const selectors = (items: readonly Parameters<typeof toEventSelector>[0][]) => items.map((i) => toEventSelector(i));
/** Events of the launcher, curves, vaults and coins (one filter for all of them). */
const OWN_TOPICS = selectors([...ABIS.launcher, ...ABIS.curve, ...ABIS.vault, ...ABIS.coin]);
const FACTORY_TOPICS = selectors(ABIS.factory);
const [SWAP_TOPIC] = selectors(ABIS.pool);
const [HOOK_FEE_TOPIC] = selectors(ABIS.hook);
const APPROVAL_TOPIC = toEventSelector(ABIS.factory.find((e) => e.name === "PairTokenApprovalUpdated")!);
const ECONOMICS_TOPIC = toEventSelector(ABIS.factory.find((e) => e.name === "PairTokenEconomicsUpdated")!);

/** Addresses per eth_getLogs call, and topic values per call. */
const ADDRESSES_PER_CALL = 500;
const TOPICS_PER_CALL = 100;

const MAIN = eq(syncState.id, "main");

export type SyncStatus = {
  startBlock: number;
  cursor: number;
  head: number;
  behindBlocks: number;
  /** Pons pair-token history loaded (the asset list). */
  assetsLoaded: boolean;
  lastSyncAt: number;
  syncedAt: number;
  lastError: string | null;
};

export async function syncStatus(): Promise<SyncStatus> {
  const db = await ixDb();
  const [s] = await db.select().from(syncState).where(MAIN);
  if (!s) throw new Error("sync_state missing");
  return {
    startBlock: s.startBlock,
    cursor: s.cursor,
    head: s.head,
    behindBlocks: Math.max(0, s.head - s.cursor),
    assetsLoaded: s.assetsCursor >= ASSETS_UNTIL,
    lastSyncAt: s.lastSyncAt,
    syncedAt: s.syncedAt,
    lastError: s.lastError,
  };
}

/** Error text for the public status: RPC URLs (which may carry an API key) are masked. */
const publicError = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/\bhttps?:\/\/\S+/g, "<rpc>").slice(0, 500);

// Per-instance throttle, so busy instances skip even the lease query between syncs.
let lastLocalAttempt = 0;

/** Runs one sync unless another is running or one ran less than THROTTLE_MS ago (`force` skips the throttle). */
export async function maybeSync({ force = false }: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (!force && now - lastLocalAttempt < THROTTLE_MS) return;
  lastLocalAttempt = now;
  const db = await ixDb();
  const lease = await db
    .update(syncState)
    .set({ leaseUntil: now + LEASE_MS, lastSyncAt: now })
    .where(and(MAIN, lt(syncState.leaseUntil, now), force ? undefined : lt(syncState.lastSyncAt, now - THROTTLE_MS)))
    .returning({ cursor: syncState.cursor, assetsCursor: syncState.assetsCursor });
  if (lease.length === 0) return;

  let error: string | null = null;
  let head: number | undefined;
  try {
    const { assetsCursor } = lease[0]!;
    let { cursor } = lease[0]!;
    head = Number(await rpc.getBlockNumber()) - LAG_BLOCKS;
    if (assetsCursor < 0 || assetsCursor < ASSETS_UNTIL) await loadAssetHistory(db, assetsCursor);
    while (cursor < head && Date.now() - now < BUDGET_MS) {
      cursor = await syncRange(db, cursor, Math.min(head, cursor + MAX_SPAN));
    }
  } catch (err) {
    error = publicError(err);
    console.error("[indexer] sync failed:", err);
  } finally {
    await db
      .update(syncState)
      .set({ leaseUntil: 0, lastError: error, ...(head !== undefined ? { head } : {}) })
      .where(MAIN);
  }
}

/* ------------------------------------------------------------------ asset history */

/**
 * Replays the Pons factory's PairTokenEconomicsUpdated / PairTokenApprovalUpdated from its deploy block up to the
 * launcher's start block (one address and one topic per call, so up to ~10M blocks each) and reads ETH's economics
 * (launch config 0). Runs once per schema; later changes arrive with the regular sync.
 */
async function loadAssetHistory(db: IxDb, assetsCursor: number) {
  const from = Math.max(PONS_V2.factoryDeployBlock, assetsCursor + 1);
  const ranges: [number, number][] = [];
  for (let a = from; a <= ASSETS_UNTIL; a += MAX_SPAN_SINGLE) ranges.push([a, Math.min(ASSETS_UNTIL, a + MAX_SPAN_SINGLE - 1)]);
  const calls = ranges.flatMap((r) => [APPROVAL_TOPIC, ECONOMICS_TOPIC].map((t) => [r, t] as const));
  const [raw, known, eth] = await Promise.all([
    mapLimit(calls, 4, ([[a, b], t]) => getLogs({ address: PONS_FACTORY, topics: [t] }, a, b)).then((x) => x.flat()),
    knownAssets(db),
    readEthEconomics(),
  ]);
  const logs = parseEventLogs({ abi: ABIS.factory, logs: raw });
  const metas = await readAssetMetas(newPairTokens(logs, known));
  const events = withContext(logs, { metas }).sort(chainOrder);

  await ixTx(async (tx) => {
    const batch = new Batch(tx);
    await batch.preload(events);
    for (const ev of events) await batch.apply(ev);
    await batch.setEthAsset(eth, from);
    await batch.flush(tx);
    const moved = await tx
      .update(syncState)
      .set({ assetsCursor: ASSETS_UNTIL })
      .where(and(MAIN, eq(syncState.assetsCursor, assetsCursor)))
      .returning({ c: syncState.assetsCursor });
    if (moved.length !== 1) throw new Error(`asset history loaded by another sync (expected ${assetsCursor})`);
  });
}

/* ------------------------------------------------------------------ ranges */

type Coin = { address: Hex; curve: Hex; vault: Hex; poolId: Hex; phase: string };

/** Applies (cursor, to] — or a shorter range if the RPC refuses — and returns the new cursor. */
async function syncRange(db: IxDb, cursor: number, to: number): Promise<number> {
  const [coins, assets] = await Promise.all([
    db.select({ address: token.address, curve: token.curve, vault: token.vault, poolId: token.poolId, phase: token.phase }).from(token),
    knownAssets(db),
  ]);

  const from = cursor + 1;
  let end = to;
  let events: Ev[];
  for (;;) {
    try {
      events = await fetchEvents(from, end, coins, assets);
      break;
    } catch (err) {
      // Too many logs or too wide a span for this RPC: halve the range. Small ranges fail for real.
      if (end - from < 1_000) throw err;
      end = from + Math.floor((end - from) / 2);
    }
  }

  await ixTx(async (tx) => {
    const batch = new Batch(tx);
    await batch.preload(events);
    for (const ev of events) await batch.apply(ev);
    await batch.flush(tx);
    const moved = await tx
      .update(syncState)
      .set({ cursor: end, syncedAt: Date.now() })
      .where(and(MAIN, eq(syncState.cursor, cursor)))
      .returning({ cursor: syncState.cursor });
    if (moved.length !== 1) throw new Error(`cursor moved by another sync (expected ${cursor})`);
  });
  return end;
}

async function knownAssets(db: IxDb): Promise<Set<Hex>> {
  return new Set((await db.select({ address: asset.address }).from(asset)).map((r) => r.address));
}

type Role = { coin: Hex; role: "curve" | "vault" | "coin" };

/** Our logs in [from, to], decoded, with block timestamps, swap senders and per-event context, in chain order. */
async function fetchEvents(from: number, to: number, coins: Coin[], assets: Set<Hex>): Promise<Ev[]> {
  const roles = new Map<Hex, Role>();
  const addRoles = (c: { address: Hex; curve: Hex; vault: Hex }) => {
    roles.set(c.address, { coin: c.address, role: "coin" });
    roles.set(c.curve, { coin: c.address, role: "curve" });
    roles.set(c.vault, { coin: c.address, role: "vault" });
  };
  // A curve stops trading once swept, so only live curves are watched.
  const watch: Hex[] = [LAUNCHER];
  for (const c of coins) {
    addRoles(c);
    watch.push(c.address, c.vault);
    if (c.phase === "curve") watch.push(c.curve);
  }
  const ownLogs = async (addresses: Hex[]) =>
    (await Promise.all(chunk(addresses, ADDRESSES_PER_CALL).map((a) => getLogs({ address: a, topics: [OWN_TOPICS] }, from, to)))).flat();

  const [own, factoryRaw] = await Promise.all([
    ownLogs(watch),
    getLogs({ address: PONS_FACTORY, topics: [FACTORY_TOPICS] }, from, to),
  ]);

  // Coins launched in this range: their own logs, constants and token info. Hidden coins (the owner's test launches,
  // impersonations of $TWAIN — config/twain-token.ts) are dropped here with everything they emit, so they never
  // reach a table: no list, page, stats or profile shows them.
  const launchedAll = parseEventLogs({ abi: ABIS.launcher, logs: own.filter((l) => lc(l.address) === LAUNCHER) });
  const infos = await readLaunchInfos(
    launchedAll.map((l) => ({ address: lc(l.args.coin), curve: lc(l.args.curve), vault: lc(l.args.vault), pairToken: lc(l.args.pairToken) })),
  );
  const launched = launchedAll.filter((l) => {
    const coin = lc(l.args.coin);
    const info = infos.get(coin);
    return !isHiddenCoin(coin, info?.name, info?.symbol);
  });
  const fresh = launched.map((l) => ({
    address: lc(l.args.coin),
    curve: lc(l.args.curve),
    vault: lc(l.args.vault),
    pairToken: lc(l.args.pairToken),
  }));
  for (const c of fresh) addRoles(c);

  // Factory events: coin-specific ones only for twain coins; pair-token and config events always.
  const ours = new Set<Hex>([...coins.map((c) => c.address), ...fresh.map((c) => c.address)]);
  const factoryLogs = parseEventLogs({ abi: ABIS.factory, logs: factoryRaw }).filter(
    (l) => !("token" in l.args) || ours.has(lc(l.args.token)),
  );
  const needEth = factoryLogs.some((l) => l.eventName === "LaunchConfigUpdated" && l.args.id === 0n);

  const [freshLogs, metas, eth] = await Promise.all([
    fresh.length ? ownLogs(fresh.flatMap((c) => [c.address, c.curve, c.vault])) : Promise.resolve([]),
    readAssetMetas(newPairTokens(factoryLogs, assets)),
    needEth ? readEthEconomics() : Promise.resolve(undefined),
  ]);

  // Graduated pools: coins already past their curve, plus coins graduating in this range.
  const poolOf = new Map<Hex, Hex>(coins.map((c) => [c.address, c.poolId]));
  for (const c of fresh) {
    const i = infos.get(c.address)!;
    poolOf.set(c.address, ponsPoolId(c.address, c.pairToken, i.poolFee, i.tickSpacing));
  }
  const pools = new Set<Hex>(coins.filter((c) => c.phase === "graduating" || c.phase === "pool").map((c) => c.poolId));
  for (const l of factoryLogs) {
    if (l.eventName === "LaunchSwept" || l.eventName === "PoolGraduated") pools.add(poolOf.get(lc(l.args.token))!);
  }
  const swapRaw = (
    await Promise.all(
      chunk([...pools], TOPICS_PER_CALL).map((ids) => getLogs({ address: POOL_MANAGER, topics: [SWAP_TOPIC, ids] }, from, to)),
    )
  ).flat();
  const swaps = parseEventLogs({ abi: ABIS.pool, logs: swapRaw });

  // The hook's fee for each swap: the HookFeeCollected that follows it in the same transaction.
  const hookRaw = swaps.length
    ? (
        await Promise.all(
          chunk([...new Set(swaps.map((s) => lc(s.args.id)))], TOPICS_PER_CALL).map((ids) =>
            getLogs(
              { address: MEME_HOOK, topics: [HOOK_FEE_TOPIC, ids] },
              Math.min(...swaps.map((s) => blockOf(s))),
              Math.max(...swaps.map((s) => blockOf(s))),
            ),
          ),
        )
      ).flat()
    : [];
  const hookFees = pairHookFees(swaps, parseEventLogs({ abi: ABIS.hook, logs: hookRaw }));

  const ownAll = [...own, ...freshLogs];
  const ofRole = (role: Role["role"]) => ownAll.filter((l) => roles.get(lc(l.address))?.role === role);
  const decoded: DecodedLog[] = [
    ...launched,
    ...parseEventLogs({ abi: ABIS.curve, logs: ofRole("curve") }),
    ...parseEventLogs({ abi: ABIS.vault, logs: ofRole("vault") }),
    ...parseEventLogs({ abi: ABIS.coin, logs: ofRole("coin") }),
    ...factoryLogs,
    ...swaps,
  ];
  if (decoded.length === 0) return [];

  // Timestamps (the public RPC's logs carry none) and the senders of pool swaps (the traders).
  const blockNums = [...new Set(decoded.map(blockOf))];
  const swapTxs = [...new Set(swaps.filter((s) => lc(s.args.sender) !== MEME_HOOK).map((s) => lc(raw(s).transactionHash!)))];
  const [blocks, txs] = await Promise.all([
    mapLimit(blockNums, 4, (n) => rpc.getBlock({ blockNumber: BigInt(n), includeTransactions: false })),
    mapLimit(swapTxs, 4, (hash) => rpc.getTransaction({ hash })),
  ]);
  const tsOf = new Map(blockNums.map((n, i) => [n, Number(blocks[i]!.timestamp)]));
  const fromOf = new Map(swapTxs.map((h, i) => [h, lc(txs[i]!.from)]));

  const events = withContext(decoded, { roles, infos, metas, eth, hookFees, tsOf, fromOf }).sort(chainOrder);
  return launchesFirst(events);
}

/* ------------------------------------------------------------------ helpers */

// parseEventLogs keeps the raw RPC fields (hex strings), whatever its return type says.
const raw = (l: object) => l as unknown as RpcLog;
const blockOf = (l: object) => hexToNumber(raw(l).blockNumber!);
const chainOrder = (a: Ev, b: Ev) => a.block - b.block || a.index - b.index;

type Context = {
  roles?: Map<Hex, Role>;
  infos?: Map<Hex, LaunchInfo>;
  metas?: Map<Hex, AssetMeta>;
  eth?: EthEconomics;
  hookFees?: Map<string, HookFee>;
  tsOf?: Map<number, number>;
  fromOf?: Map<Hex, Hex>;
};

/** Decoded logs → events with block/tx fields and the context their handlers need. */
function withContext(logs: DecodedLog[], ctx: Context): Ev[] {
  return logs.map((l) => {
    const r = raw(l);
    const block = hexToNumber(r.blockNumber!);
    const index = hexToNumber(r.logIndex!);
    const txHash = lc(r.transactionHash!);
    const ev = { ...l, block, index, ts: ctx.tsOf?.get(block) ?? 0, txHash, txFrom: ctx.fromOf?.get(txHash) ?? null } as Ev;
    const role = ctx.roles?.get(lc(r.address));
    if (role) ev.coin = role.coin;
    if (l.eventName === "CoinLaunched") ev.launch = ctx.infos?.get(lc(l.args.coin));
    if (l.eventName === "PairTokenApprovalUpdated" || l.eventName === "PairTokenEconomicsUpdated") {
      ev.assetMeta = ctx.metas?.get(lc(l.args.pairToken));
    }
    if (l.eventName === "LaunchConfigUpdated") ev.ethEconomics = ctx.eth;
    if (l.eventName === "Swap") ev.hookFee = ctx.hookFees?.get(`${txHash}-${index}`);
    return ev;
  });
}

/**
 * CoinLaunched is the launcher's last log, after the supply mint and the creator's first buy of the same
 * transaction; it is moved to the front of its transaction so the coin exists before its own events apply.
 * Logs of one transaction are contiguous in chain order.
 */
function launchesFirst(events: Ev[]): Ev[] {
  const out: Ev[] = [];
  let i = 0;
  while (i < events.length) {
    let j = i;
    while (j < events.length && events[j]!.txHash === events[i]!.txHash && events[j]!.block === events[i]!.block) j++;
    const group = events.slice(i, j);
    out.push(...group.filter((e) => e.eventName === "CoinLaunched"), ...group.filter((e) => e.eventName !== "CoinLaunched"));
    i = j;
  }
  return out;
}

/** Pairs each HookFeeCollected with the last preceding Swap of the same pool in the same transaction. */
function pairHookFees(
  swaps: { args: { id: Hex } }[],
  fees: { args: { poolId: Hex; currency: Hex; feeAmount: bigint; taxAmount: bigint } }[],
): Map<string, HookFee> {
  type Item = { tx: Hex; index: number; pool: Hex; fee?: HookFee };
  const items: Item[] = [
    ...swaps.map((s) => ({ tx: lc(raw(s).transactionHash!), index: hexToNumber(raw(s).logIndex!), pool: lc(s.args.id) })),
    ...fees.map((f) => ({
      tx: lc(raw(f).transactionHash!),
      index: hexToNumber(raw(f).logIndex!),
      pool: lc(f.args.poolId),
      fee: { currency: lc(f.args.currency), fee: f.args.feeAmount, tax: f.args.taxAmount },
    })),
  ];
  const byTx = new Map<Hex, Item[]>();
  for (const it of items) byTx.set(it.tx, [...(byTx.get(it.tx) ?? []), it]);
  const out = new Map<string, HookFee>();
  for (const [tx, list] of byTx) {
    const open = new Map<Hex, number>(); // pool → index of its last swap without a fee yet
    for (const it of list.sort((a, b) => a.index - b.index)) {
      if (!it.fee) open.set(it.pool, it.index);
      else {
        const swapIndex = open.get(it.pool);
        if (swapIndex === undefined) continue;
        out.set(`${tx}-${swapIndex}`, it.fee);
        open.delete(it.pool);
      }
    }
  }
  return out;
}

function newPairTokens(logs: DecodedLog[], known: Set<Hex>): Hex[] {
  const out = new Set<Hex>();
  for (const l of logs) {
    if (l.eventName !== "PairTokenApprovalUpdated" && l.eventName !== "PairTokenEconomicsUpdated") continue;
    const a = lc(l.args.pairToken);
    if (!known.has(a)) out.add(a);
  }
  return [...out];
}

/* ------------------------------------------------------------------ contract reads (latest block) */

/** ERC-20 details of pair tokens (non-standard tokens fall back to placeholders rather than stall the sync). */
async function readAssetMetas(addresses: Hex[]): Promise<Map<Hex, AssetMeta>> {
  if (addresses.length === 0) return new Map();
  const fns = ["symbol", "name", "decimals"] as const;
  const res = await rpc.multicall({
    contracts: addresses.flatMap((address) => fns.map((functionName) => ({ address, abi: erc20Abi, functionName }))),
    allowFailure: true,
  });
  return new Map(
    addresses.map((a, i) => {
      const [sym, name, dec] = res.slice(i * 3, i * 3 + 3).map((r) => (r.status === "success" ? r.result : undefined));
      const symbol = typeof sym === "string" && sym ? sym : "?";
      return [a, { symbol, name: typeof name === "string" && name ? name : symbol, decimals: dec === undefined ? 18 : Number(dec) }];
    }),
  );
}

async function readEthEconomics(): Promise<EthEconomics> {
  const c = await rpc.readContract({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: "getLaunchConfig", args: [0n] });
  return { phantomQuote: c.phantomQuote, graduationThreshold: c.graduationThreshold, enabled: c.enabled };
}

/** Curve constants, onchain token info and the pool terms of newly launched coins (one multicall). */
async function readLaunchInfos(coins: { address: Hex; curve: Hex }[]): Promise<Map<Hex, LaunchInfo>> {
  if (coins.length === 0) return new Map();
  const curveFns = ["phantomQuote", "graduationThreshold", "reservedTokens", "launchSupply", "feeBps", "creatorTaxBps"] as const;
  const perCoin = (c: { address: Hex; curve: Hex }) =>
    [
      ...curveFns.map((functionName) => ({ address: c.curve, abi: ponsCurveAbi, functionName }) as const),
      { address: c.address, abi: erc20Abi, functionName: "name" } as const,
      { address: c.address, abi: erc20Abi, functionName: "symbol" } as const,
      { address: c.address, abi: ponsTokenAbi, functionName: "getTokenInfo" } as const,
      { address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [c.address] } as const,
    ] as const;
  const n = perCoin(coins[0]!).length;
  const res = (await rpc.multicall({ contracts: coins.flatMap(perCoin), allowFailure: false })) as unknown[];
  return new Map(
    coins.map((c, i) => {
      const r = res.slice(i * n, (i + 1) * n);
      const [phantomQuote, graduationThreshold, reservedTokens, supply, feeBps, taxBps] = r.slice(0, 6) as bigint[];
      const [name, symbol] = r.slice(6, 8) as string[];
      const [, logo, description, socials] = r[8] as readonly [Hex, string, string, LaunchInfo["socials"]];
      const launched = r[9] as { poolFee: number; tickSpacing: number };
      const info: LaunchInfo = {
        name: name!,
        symbol: symbol!,
        logo,
        description,
        socials,
        phantomQuote: phantomQuote!,
        graduationThreshold: graduationThreshold!,
        reservedTokens: reservedTokens!,
        supply: supply!,
        feeBps: Number(feeBps),
        taxBps: Number(taxBps),
        poolFee: Number(launched.poolFee),
        tickSpacing: Number(launched.tickSpacing),
      };
      return [c.address, info];
    }),
  );
}

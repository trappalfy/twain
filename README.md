# Coin launchpad on Robinhood Chain

Launch a coin paired with any listed asset, from memes to tokenized stocks (chainId 4663). One transaction creates the coin, opens its own Uniswap v4 pool against the asset and locks the whole supply in it for good. Same rules for every coin.

- Packages: `contracts/` (Foundry: `Launchpad`, `LiquidityLocker`, `Coin`), `packages/shared/` (pool math, ABIs, API types, copy), `web/` (Next.js, with the built-in indexer in `web/indexer/`)

## Requirements
Node ≥ 22, pnpm 12, Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).

## Run locally (mainnet fork, no real funds)
```bash
pnpm install
scripts/dev-chain.sh                 # terminal 1: anvil fork of Robinhood mainnet + contracts; lists ETH and TSLA, funds test wallets with TSLA
pnpm --filter @lancio/web dev        # terminal 2: site on :3000
```
Demo data: `cd contracts && LAUNCHPAD=<from deployments/local.json> CREATOR_KEY=<anvil key> TRADER_KEY=<anvil key> STOCK=0x322F0929c4625eD5bAd873c95208D54E1c003b2d forge script script/Seed.s.sol --rpc-url http://127.0.0.1:8545 --broadcast` launches an ETH pair and a TSLA pair and trades them.
The site indexes the fork itself (built-in indexer, status at `/api/indexer`).
Wallet: add network RPC `http://127.0.0.1:8545`, chainId 4663, and import a test key printed in `/tmp/lancio-anvil.log`.
The public Robinhood RPC keeps only ~10–20 minutes of historical state, so a fork stops working after that; restart it, or set `RPC_URL_4663` to an archive RPC for longer sessions.

## Tests
```bash
cd contracts && forge test                               # unit and fuzz tests
forge test --match-contract ForkTest -vv                 # full cycle on a mainnet fork: real Uniswap v4, real TSLA, Universal Router + Permit2
pnpm --filter @lancio/shared test                        # pool math vectors (must match the contracts bit for bit)
```

## Mainnet deploy (owner only)
1. The owner wallet with ~0.001 ETH on Robinhood Chain (deploy + listing ≈ 0.0004 ETH).
2. `cd contracts && eval "$(node script/asset-mcaps.mjs)" && PROTOCOL_OWNER=0x… PROTOCOL_TREASURY=0x… forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --account <keystore>`
   (deploys `Launchpad`, which deploys its `LiquidityLocker`; when the deployer is the owner, lists ETH at 2.73 ETH start market cap plus every asset in `contracts/assets/4663.json` at the same dollar value, from live prices; writes `deployments/4663.json`). `forge test --match-test test_fork_assetList` runs every listed asset through a full launch/trade/claim cycle on a mainnet fork.
3. Verify sources (Sourcify / Blockscout).
4. `node contracts/script/export-abi.mjs`, then set `NEXT_PUBLIC_LAUNCHPAD`, `NEXT_PUBLIC_LOCKER` and `NEXT_PUBLIC_START_BLOCK` (the L2 block of the deploy transaction, from its receipt) in the web environment.

## Production
- **web/** → Vercel + Postgres (Neon). Env: see `.env.example` (contract addresses + start block, WalletConnect projectId, Pinata JWT, DATABASE_URL + SESSION_SECRET, X handle). The site is its own indexer: API requests sync the launchpad's logs, its coins' transfers and their pools' swaps from the public RPC into DATABASE_URL (only while someone is on the site); `/api/indexer` shows the indexed block. USD prices: ETH from Coinbase/Kraken, Robinhood stock tokens from Robinhood's public stock-token API.
- The contracts have no admin key over user funds. The owner can only change the treasury address, pause creation of new coins, and manage the asset list for new coins.
- The contracts are open source and verified, but have not been externally audited.

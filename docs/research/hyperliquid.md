# Hyperliquid — developer notes

Role: **main execution venue** (not a sponsor). Researched 2026-11-05.

## Why Hyperliquid

- HIP-3 builder-deployed perps. **trade.xyz** (dex id `xyz`, roughly 91–97% of HIP-3 open interest) lists TSLA, AAPL, NVDA, AMZN, gold, silver, WTI, Brent and an S&P 500 perp.
- 24/7, no KYC.
- **Same API as normal crypto perps.** One signed call opens a gold long or a BTC short.
- Docs: https://hyperliquid.gitbook.io/Hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals

## Asset IDs

```
asset = 100000 + perp_dex_index * 10000 + index_in_meta
```

- `perp_dex_index`: position of the dex in the `perpDexs` info response.
- `index_in_meta`: position of the coin in `meta` for that dex.
- Native (non-HIP-3) perps like BTC keep their normal small asset ids from the default `meta`.
- Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids

Coin names look like `xyz:GOLD`, `xyz:TSLA`. **Exact tickers are UNVERIFIED** — always read them from `meta` at runtime, never hard-code.

### Discovery calls (info endpoint)

```jsonc
{ "type": "perpDexs" }                          // list dexes, find index of "xyz"
{ "type": "meta", "dex": "xyz" }                // universe of xyz markets
{ "type": "metaAndAssetCtxs", "dex": "xyz" }    // markets + mark price, funding, OI
```

```ts
// Compute an asset id for a HIP-3 coin
const dexes = await info.perpDexs();                    // SDK method names: check @nktkas/hyperliquid
const dexIdx = dexes.findIndex((d) => d?.name === 'xyz');
const meta = await info.meta({ dex: 'xyz' });
const metaIdx = meta.universe.findIndex((u) => u.name === 'xyz:GOLD');
const asset = 100000 + dexIdx * 10000 + metaIdx;
```

## API (agent) wallet model

- The **master** account holds funds. It signs an `ApproveAgent` action once to authorise an **API wallet** (agent key).
- The server keeps only the agent key. It signs orders on behalf of the master; it cannot withdraw.
- **Query account data with the master address**, not the agent address (the agent has no balances of its own).
- Generate a **fresh agent key** each time you approve; do not reuse old agent keys (nonce tracking is per signer).
- Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets

```
master wallet (holds USDC) --ApproveAgent--> agent key (server .env)
agent key --signs order--> exchange endpoint --> fills on master's account
```

## SDKs

| Language | Package | Notes |
|---|---|---|
| TypeScript | `@nktkas/hyperliquid` | Best maintained; we use this |
| Python | `hyperliquid-python-sdk` | Reference |
| On-chain | CoreWriter (HyperEVM contract → order) | Exists; skip for the hackathon |

## Testnet

| Item | Value |
|---|---|
| App | app.hyperliquid-testnet.xyz |
| Faucet | app.hyperliquid-testnet.xyz/drip — 1,000 mock USDC |
| Faucet docs | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet |

### Testnet faucet gotcha

**The faucet only pays an address that has already deposited on Hyperliquid mainnet.** Pre-event steps:

1. From the agent's **master** address, deposit a small amount on mainnet.
2. Claim 1,000 mock USDC at the testnet `/drip` with the same address.
3. Approve a testnet API wallet from the master.
4. Run `perpDexs` and `meta(dex:"xyz")` on **testnet** to see whether stock/gold markets exist there.

Whether `xyz` stock/gold markets exist on testnet is **UNVERIFIED**. Fallbacks, in order:
- BTC perp on testnet (the "short BTC" half of the war playbook still demos).
- Mainnet, minimum size, same code path (only the base URL and keys change).

## Playbook mapping (server/src/execution/playbook.ts)

| Signal class | Action |
|---|---|
| war / geopolitical | Long `xyz:GOLD` and/or `xyz:WTI`, short BTC |
| other classes | Defined during the build; keep each to one or two orders |

All sizes are capped by user memory (risk limits on 0G Storage) and a hard server-side max notional.

## Why not tokenized stocks on Uniswap

| | Uniswap (Backed xStocks, e.g. TSLAx) | Hyperliquid HIP-3 |
|---|---|---|
| Chain | Ethereum mainnet | Hyperliquid L1 |
| Liquidity | Thin pools (~$240k) | Main venue for HIP-3 OI |
| Direction | Spot only, no shorting | Long and short perps |
| Access | Non-US only per terms | No KYC |
| Testnet | None | Yes (stock markets on testnet UNVERIFIED) |

Spot gold on Uniswap (PAXG / XAUT) is the realistic safe-haven **spot** leg; Hyperliquid carries the directional trade.

## Unverified

- Exact `xyz:` tickers (`xyz:GOLD`, `xyz:WTI`, `xyz:TSLA` are illustrative).
- Whether `xyz` stock/gold markets exist on testnet.
- `@nktkas/hyperliquid` method names used in the snippet (`perpDexs`, `meta({dex})`).
- trade.xyz share of HIP-3 OI (91–97%) is a point-in-time figure.

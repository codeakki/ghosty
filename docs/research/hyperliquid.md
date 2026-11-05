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

Coin names look like `xyz:GOLD`, `xyz:TSLA`. Tickers verified 2026-11-06 (see below); still read them from `meta` at runtime, never hard-code asset ids.

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

`xyz` stock/gold/oil markets **do exist on testnet** (verified 2026-11-06, see below). Fallbacks if a market is missing or illiquid, in order:
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

## Verified on 2026-11-06 (live info calls, no keys)

`npm run hl:check` (see `server/src/scripts/hlCheck.ts`) against both networks:

| | Testnet | Mainnet |
|---|---|---|
| `perpDexs` length | 277 (index 0 = `null`, then `test`, `unit`, …) | 11 (`xyz`, `flx`, `vntl`, `hyna`, …) |
| `xyz` dex index | **65** → asset ids `750000 + metaIdx` | **1** → asset ids `110000 + metaIdx` |
| Gold | `xyz:GOLD` (metaIdx 3, szDecimals 4) | `xyz:GOLD` (3, 4) |
| WTI crude | `xyz:CL` (29, 3). No `xyz:WTI` ticker. | `xyz:CL` (29, 3) |
| Brent | `xyz:BRENTOIL` **delisted** | `xyz:BRENTOIL` (49, 2) |
| TSLA | `xyz:TSLA` (1, 3) | `xyz:TSLA` (1, 3) |
| BTC (main dex) | asset **3** (not 0) | asset 0 |

So **xyz gold/oil/stock markets exist on testnet**. Liquidity there is thin: on 2026-11-06 `xyz:CL` had no `midPx` in `metaAndAssetCtxs` (allMids still returned 88.671), and `xyz:TSLA` mid was 439 vs mark 379. An IOC at mid ± 1% may not fill on testnet; the venue returns `status: 'rejected'` with the exchange's message instead of throwing.

Other facts confirmed:
- `meta({dex})` universe names already carry the prefix (`xyz:GOLD`). `allMids({dex:'xyz'})` keys are prefixed too.
- `@nktkas/hyperliquid` 0.33.3: `new HttpTransport({ isTestnet })`, `InfoClient.perpDexs()`, `meta({ dex })`, `allMids({ dex })`, `clearinghouseState({ user, dex })`, `userAbstraction({ user })`, `ExchangeClient({ transport, wallet }).order({ orders: [{ a, b, p, s, r, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' })`. Utils: `formatPrice(px, szDecimals, 'perp')` (5 significant figures, ≤ 6 − szDecimals decimals), `formatSize`. The SDK throws `ApiRequestError` when a status is `{ error }`.
- Asset id rules (docs): perps = index in `meta`; builder dexes = `100000 + perp_dex_index * 10000 + index_in_meta`; spot = `10000 + spotIndex`.
- Agent wallets: query with the master address (agent address returns empty); nonces are per signer; do not reuse deregistered agent keys.

## Implementation notes (server/src/execution/hyperliquid.ts)

- **Market map**: `perpDexs()` + `meta({dex})` for the main dex and `HL_DEXES` only (default `xyz`). Loading all 277 testnet dexes would hit info rate limits. Cached 5 minutes.
- **Alias resolution** (`resolveCoin`): exact coin → alias pattern on the ticker → `HL_FALLBACK_COINS`. Patterns are anchored: an unanchored `/CL/` matches `xyz:CRCL` (Circle, index 18) before `xyz:CL` (index 29). `GOLD → xyz:GOLD`, `WTI`/`xyz:WTI → xyz:CL`, `BTC → BTC`. Delisted markets are skipped. Fallback orders carry `fallback: true` and `requestedCoin`.
- **Orders**: mid from `allMids({dex})`; size = `sizeUsd / mid` rounded to szDecimals; IOC limit at mid ± `slippageBps` (default 100). Under $10 is rejected before any network call. If rounding lands just under $10 (checked at the worse of mid and limit price), the size is bumped by one lot, so a $10 leg can cost a few cents more.
- **Never throws** from `placeMarketOrder`: unknown market, missing mid, exchange error → `status: 'rejected'` with `error`, so one bad leg does not abort the others.
- **Factory** `createPerpVenue(config)`: real only when `HL_AGENT_PRIVATE_KEY` and `HL_MASTER_ADDRESS` are both valid; otherwise `FakeHyperliquid`.

### HIP-3 collateral (new pre-event item)

HIP-3 dexes keep **separate margin**. A test call on 2026-11-06 for a funded testnet address showed `main: 1451 USDC`, `xyz: 0`. Before trading `xyz:*`, either move USDC into the xyz dex (`sendAsset`, or the app's transfer) or switch the master to `unifiedAccount` (`userSetAbstraction`, or the app setting). In that mode, HIP-3 actions pull collateral automatically. `hl:check` prints the abstraction mode and flags an unfunded dex.

## Unverified

- Order placement end to end (needs a funded master + approved agent key). The `order` request shape matches the SDK types and docs, but no testnet order has been sent yet.
- Whether HL's $10 minimum is checked at the limit price or the mid (we satisfy both).
- Whether an IOC fills on thin testnet xyz books at 1% slippage; may need `slippageBps` 300+ on testnet.
- The `/explorer/address/<master>` link format on the testnet app.
- trade.xyz share of HIP-3 OI (91–97%) is a point-in-time figure.

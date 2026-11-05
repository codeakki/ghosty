# Uniswap — developer notes

Track: **Build with Uniswap** ($10,000; 4k / 3k / 2k / 1k). Researched 2026-11-05.

## Track rules

- Use **any part** of the Uniswap stack (Trading API, v2/v3/v4, hooks, CCA).
- Public repo.
- `FEEDBACK.md` in the repo root.
- Submit the feedback form: https://developers.uniswap.org/hackathon-feedback
- README points to the **exact code** that uses Uniswap (file + line range).

## Our use: one real spot leg

| Scenario | Swap | Why |
|---|---|---|
| Fund perps | Wallet tokens → USDC | USDC is the collateral for the Hyperliquid perp |
| Safe haven | USDC → PAXG (or XAUT) | Spot gold on Uniswap is the realistic safe-haven leg |

Both are triggered by the same button press as the Hyperliquid order (see [../architecture.md](../architecture.md#sequence-b-news-driven-alert--button--trade)). Code lives in `server/src/wallet/uniswap.ts`.

## Trading API

| Item | Value |
|---|---|
| Base URL | `https://trade-api.gateway.uniswap.org/v1` |
| Auth header | `x-api-key: <key>` |
| Get a key | https://developers.uniswap.org/dashboard/welcome |
| Docs | https://developers.uniswap.org/docs |

### Flow

```
POST /check_approval   → returns an approval tx if the token needs one
POST /quote            → route + amounts
POST /swap             → unsigned tx
sign + send with viem  → tx hash (evidence)
```

```ts
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const API = 'https://trade-api.gateway.uniswap.org/v1';
const headers = { 'content-type': 'application/json', 'x-api-key': process.env.UNISWAP_API_KEY! };

const account = privateKeyToAccount(process.env.AGENT_PK as `0x${string}`);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });

async function post(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return r.json();
}

// Placeholder sketch from research. Real shapes: see "Implementation notes" below.
const approval = await post('/check_approval', { /* token, amount, walletAddress, chainId */ });
if (approval.approval) await wallet.sendTransaction(approval.approval);

const quote = await post('/quote', { /* tokenIn, tokenOut, amount, type, swapper, chainId */ });
const { swap } = await post('/swap', { quote: quote.quote });
const hash = await wallet.sendTransaction(swap);
```

## Testnets

| Network | Chain ID | Notes |
|---|---|---|
| Base Sepolia | `84532` | Universal Router `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` |
| Unichain Sepolia | `1301` | |
| Ethereum Sepolia | `11155111` | |

**Testnet liquidity is thin.** Pre-test the exact pair and size the day before. If no testnet pool works, do the spot leg on Arbitrum or Base mainnet with a tiny amount.

## Why not tokenized stocks on Uniswap

Short answer: Hyperliquid HIP-3 is the execution venue for stocks, gold and oil; Uniswap is the spot leg.

| | Uniswap (Backed xStocks, e.g. TSLAx) | Hyperliquid HIP-3 (`xyz:` on trade.xyz) |
|---|---|---|
| Chain | Ethereum mainnet | Hyperliquid L1 |
| Liquidity | Thin pools (~$240k) | Main venue for HIP-3 OI |
| Direction | Spot only, **no shorting** | Long and short perps |
| Access | Non-US only per terms | No KYC |
| Hours | Onchain 24/7, but pricing thin | 24/7 |
| Testnet | None | Testnet exists; stock/gold markets on testnet UNVERIFIED |

Spot gold on Uniswap (PAXG / XAUT) is the realistic Uniswap leg for the "war" playbook.

## FEEDBACK.md: what to capture during the build

Write it as we go, not at the end:

- Time to first successful quote
- Any confusing request fields or error messages
- Testnet liquidity gaps (pairs that failed)
- Approval / Permit2 friction
- Docs gaps

## Implementation notes (2026-11-06)

Code: `server/src/wallet/uniswap.ts` (`UniswapSpotLeg`), viem account in `server/src/wallet/account.ts`. Shapes come from the OpenAPI spec (`https://trade-api.gateway.uniswap.org/v1/api.json`) and the integration guide, which replace the placeholders above.

| Step | Request | Response we read |
|---|---|---|
| `POST /check_approval` | `{ walletAddress, token, amount, chainId, tokenOut, tokenOutChainId }` | `approval` and `cancel` (each a `TransactionRequest` or `null`). Send `cancel` first if present. |
| `POST /quote` | `{ type: 'EXACT_INPUT', amount, tokenIn, tokenOut, tokenInChainId, tokenOutChainId, swapper, slippageTolerance, routingPreference: 'BEST_PRICE', protocols: ['V2','V3','V4'] }` | `routing`, `quote` (`quoteId`, `routeString`, `output.amount`), `permitData` (or `null`) |
| sign | `signTypedData({ domain, types, primaryType, message: values })` | `primaryType` is not returned; we take the type no other type references (`PermitSingle`) |
| `POST /swap` | `{ quote }`, or `{ quote, signature, permitData }` (both or neither) | `swap: { to, from, data, value, chainId, gasLimit }` |

Differences from the research notes:
- There is a **Permit2 signature step** between quote and swap whenever `permitData` is non-null.
- `/check_approval` may return a **revoke (`cancel`) tx** as well as the approval.
- `/quote` can already contain `swapTransaction` (when no permit is needed); we still call `/swap` so the flow is the same in both cases.
- `protocols` pins AMM routing. Without it, mainnet quotes can come back as UniswapX (`DUTCH_V2/V3`, `PRIORITY`), which go to `/order`, not `/swap`.
- Proxy (no-Permit2) flow via `x-permit2-disabled`: **not deployed on Base Sepolia** (only Unichain Sepolia, Sepolia, Monad testnet). We use Permit2.
- Optional headers: `x-universal-router-version` (default 2.1.2 where deployed; Base Sepolia 2.1.2 router is `0x8702463e73f74d0b6765aBceb314Ef07aCb92650`), `x-agent-info` (agent attribution).
- Error bodies: 404 has `errorCode` (`NoRouteFoundError`, `QuoteAmountTooLowError`, `UnsupportedTokenError`, …). Only `UpstreamTimeoutError` is worth retrying unchanged.

Safety checks before broadcasting every API-built tx: valid `to`, non-empty `data`, `chainId` matches the wallet. Gas limit from the API is passed through; fees are left to viem.

Demo pair (config, verify before the event): WETH `0x4200000000000000000000000000000000000006` → USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Base Sepolia, 0.0001 WETH (`UNISWAP_DEMO_AMOUNT`). The spot leg runs before the perp legs when `UNISWAP_SPOT_LEG=true` (`planSteps` + `executePlan`).

## Unverified

- A live quote/swap: needs `UNISWAP_API_KEY` and a funded Base Sepolia wallet.
- Which testnet pairs have usable liquidity on 2026-11-06 (WETH/USDC on Base Sepolia assumed).
- The Base Sepolia USDC address above (Circle testnet USDC; confirm on BaseScan).
- Whether `permitData.domain.chainId` comes back as a number or a string (viem signs either; checked locally).
- Trading API support for PAXG/XAUT routes on Arbitrum / Base.
- xStocks pool size (~$240k) is a point-in-time figure from research.

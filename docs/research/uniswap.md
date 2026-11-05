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

// Request/response field names: check the docs; shapes here are placeholders (UNVERIFIED)
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

## Unverified

- Request/response field names for `/check_approval`, `/quote`, `/swap` (snippet uses placeholders).
- Which testnet pairs have usable liquidity on 2026-11-06.
- Trading API support for PAXG/XAUT routes on Arbitrum / Base.
- xStocks pool size (~$240k) is a point-in-time figure from research.

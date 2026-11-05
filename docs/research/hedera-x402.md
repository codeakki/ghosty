# Hedera x402 — developer notes

Track: **AI Agents That Pay: x402 on Hedera** ($6,500). Researched 2026-11-05.

## What x402 is

HTTP 402 pay-per-request.

1. Client calls a paid route. Server replies **402** with payment requirements.
2. Client signs a **partial Hedera `TransferTransaction`** (HBAR or an HTS token) and retries with an **`X-Payment`** header.
3. Server hands the payload to a **facilitator**, which verifies and settles on Hedera.
4. Server returns 200 with the resource.

Docs: https://docs.hedera.com/solutions/ai/x402 and sub-pages `/how-it-works`, `/pay-with-x402`, `/merchant-integration`, `/facilitators`, `/exact-scheme`. Spec + libs: https://github.com/x402-foundation/x402

## Packages

| Package | Role |
|---|---|
| `@x402/core` | Shared types and resource server |
| `@x402/hedera` | Hedera signer + `exact` scheme (client and server) |
| `@x402/fetch` | `wrapFetchWithPayment` for the paying client |
| `@x402/express` | `paymentMiddleware` for the paid endpoint |
| `@hiero-ledger/sdk` | Hedera SDK (`PrivateKey`, transactions) |
| `@hashgraph/hedera-agent-kit` | Agent Kit v4 (extra credit) |

## Networks and assets

| Item | Value |
|---|---|
| Networks | `hedera:testnet`, `hedera:mainnet` |
| HBAR asset id | `0.0.0` (amounts in tinybars) |
| Testnet USDC | `0.0.429274` |

## Testnet facilitators (no API key)

- https://x402.org/facilitator
- https://testnet.facilitator.launa.dev
- https://api.testnet.blocky402.com

Keep all three in config; fall back in order if one is down.

## Accounts and faucet

- Create a testnet account: https://portal.hedera.com
- Faucet: https://portal.hedera.com/faucet (100 HBAR/day to an EVM address)
- We need two accounts: the **agent payer** and the **merchant `payTo`** (can be the same team, must be different accounts for a clean demo).

## Client (agent pays) — UNVERIFIED combination

```ts
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { PrivateKey } from '@hiero-ledger/sdk';

const signer = createClientHederaSigner(
  process.env.HEDERA_ACCOUNT_ID!,                         // '0.0.X'
  PrivateKey.fromString(process.env.HEDERA_PRIVATE_KEY!),
  { network: 'hedera:testnet' },
);
const client = new x402Client().register('hedera:*', new ExactHederaScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay(`${SERVER}/signal`);
```

## Server (paid `/signal`) — sketch

```ts
// UNVERIFIED shape, adapt to the library's actual exports
app.use(paymentMiddleware(
  {
    'GET /signal': {
      accepts: [{ scheme: 'exact', price, network: 'hedera:testnet', payTo: '0.0.X' }],
    },
  },
  new x402ResourceServer(
    new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' }),
  ).register('hedera:*', new ExactHederaScheme({ /* server config */ })),
));
```

Note: `@x402/express` is Express middleware. If the server uses Fastify, either mount the paid route in a small Express sub-app or wrap the middleware.

## Ghosty usage

- `GET /signal` on our own server is the paid resource (premium, credibility-weighted signal).
- The agent loop calls it through `wrapFetchWithPayment` every time it evaluates a news batch. No human approval.
- Log each settlement tx ID; the first one goes in the README with its HashScan link.

## Spend controls (extra credit, cheap)

| Control | Implementation |
|---|---|
| Per-call cap | Reject 402 requirements whose price exceeds `MAX_PRICE_PER_CALL` before signing |
| Daily budget | Counter in memory; refuse to pay once `DAILY_BUDGET` is hit |
| `payTo` allowlist | Only pay accounts in `ALLOWED_PAYTO` |
| HCS audit topic | Submit `{ts, route, price, txId}` to a Hedera Consensus Service topic per payment |
| USDC via HTS | Price in testnet USDC `0.0.429274` instead of HBAR |

Other extra-credit items listed by the track: HCS-14 / ERC-8004 identity, Scheduled Tx, Agent Kit / Hedera hosted MCP (https://docs.hedera.com/solutions/ai/agent-kit, https://docs.hedera.com/solutions/ai/hosted-mcp-server).

## Track checklist

- [ ] x402 endpoint settling on `hedera:testnet` via a listed facilitator
- [ ] ≥ 1 autonomous paid request
- [ ] README: settled tx ID, architecture, payment flow
- [ ] Video ≤ 5 min with HashScan link

## Unverified

- The full client code above: the combination of `x402Client`, `createClientHederaSigner`, `ExactHederaScheme` import paths and the `register('hedera:*', ...)` call.
- The server middleware shape and the `ExactHederaScheme` server-side config.
- Exact 402 response body fields and payment response header names (read from the library).
- Current uptime of the three testnet facilitators.

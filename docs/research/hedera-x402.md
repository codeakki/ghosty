# Hedera x402 — developer notes

Track: **AI Agents That Pay: x402 on Hedera** ($6,500). Researched 2026-11-05. Implemented 2026-11-06: see [Implementation notes](#implementation-notes-2026-11-06) at the end, which supersede the sketches below.

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

## Client (agent pays) — original sketch

Resolved in the implementation notes: `x402Client` lives in `@x402/core/client` (re-exported by `@x402/fetch`), and HBAR needs an explicit spendControls opt-in.

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

## Server (paid `/signal`) — original sketch (superseded)

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

- [x] x402 endpoint settling on `hedera:testnet` via a listed facilitator (code and tests done; live settlement waits on a funded account)
- [ ] ≥ 1 autonomous paid request (run `npm run x402:demo`; the row lands in [../evidence.md](../evidence.md))
- [ ] README: settled tx ID, architecture, payment flow
- [ ] Video ≤ 5 min with HashScan link

## Implementation notes (2026-11-06)

### Packages actually used

| Package | Version | Used for |
|---|---|---|
| `@x402/core` | 2.30.0 (`~2.30.0`) | `x402ResourceServer`, `HTTPFacilitatorClient` (`@x402/core/server`); header codecs (`@x402/core/http`) |
| `@x402/hedera` | 2.30.0 (`~2.30.0`) | `ExactHederaScheme` server (`@x402/hedera/exact/server`) and client (`@x402/hedera/exact/client`); `createClientHederaSigner` (`@x402/hedera`) |
| `@x402/fetch` | 2.30.0 (`~2.30.0`) | `wrapFetchWithPayment`, `x402Client` (re-export of `@x402/core/client`), `decodePaymentResponseHeader` |
| `@hiero-ledger/sdk` | 2.90.1 (pinned) | `PrivateKey`, HCS (`TopicCreateTransaction`, `TopicMessageSubmitTransaction`). Pinned to the exact version `@x402/hedera` depends on, so there is one SDK copy and one `PrivateKey` class. |

Not used:

- `@x402/express`: Express only.
- `@x402/fastify` 2.30.0: it exists on npm (peers `fastify >=5.12.5` and `@x402/paywall`), but we drive `x402ResourceServer` from a plain Fastify route instead. That keeps the wiring to a two-line `registerPaidRoutes(app, …)` call, keeps the signal source injectable, and makes the 402 body readable JSON.
- `@hashgraph/sdk`: the old package name. Its latest release (2.81.0) is behind `@hiero-ledger/sdk`.

### Open questions from the research, now resolved

These answers come from the installed 2.30.0 code.

| Question | Answer |
|---|---|
| Where does `x402Client` come from? | `@x402/core/client`; `@x402/fetch` re-exports it. `new x402Client().register('hedera:testnet', new ExactHederaScheme(signer))` works as sketched. |
| `$0.01`-style prices on Hedera | A Money price (`"$0.01"`) converts to the default asset. On Hedera that asset is **USDC** (`0.0.429274` on testnet, 6 decimals). The scheme won't use HBAR as a Money default. To charge HBAR, pass an `AssetAmount`: `{ asset: '0.0.0', amount: '<tinybars>' }`. |
| Will the client pay HBAR out of the box? | **No.** By default, `@x402/core` client spend controls allow only "default assets" (USDC). Opt HBAR in with `setSpendControls({ allowedAssets: [{ network: 'hedera:testnet', asset: '0.0.0', maxAmountPerPayment: '<tinybars>' }] })`. Without it, every HBAR 402 is rejected. |
| Header names | x402 **v2**: the server sends `PAYMENT-REQUIRED` (base64 JSON) with the 402, the client retries with `PAYMENT-SIGNATURE`, and the server answers with `PAYMENT-RESPONSE`. `X-PAYMENT` and `X-PAYMENT-RESPONSE` are the v1 names. Our server accepts both request headers, sends both response headers, and adds `x-payment-tx-id`. |
| Fee payer | Each facilitator lists its fee-payer account in `GET /supported` → `kinds[].extra.feePayer`. The resource server copies it into `accepts[].extra.feePayer`, and the client puts it in the transaction ID. The facilitator pays the network fee; the agent pays only the price. |
| Facilitator uptime (2026-11-06) | All three answer `GET /supported` with `x402Version: 2, scheme: exact, network: hedera:testnet`. Fee payers: x402.org `0.0.9185802`, Launa `0.0.9839454`, Blocky402 `0.0.7162784`. |
| HashScan link format | `https://hashscan.io/testnet/transaction/0.0.X-SSSS-NNNN`. The explorer's `TransactionID.parse` (hiero-mirror-node-explorer) accepts both `0.0.X@S.N` and `0.0.X-S-N`. We emit the dashed form, which the mirror node also uses. |
| Can payer and payTo be the same account? | No. The SDK nets the two transfers to zero and the facilitator rejects the transaction. Use two testnet accounts. The agent refuses to pay its own account before signing. |

### Facilitator used

`X402_FACILITATOR_URL` defaults to `https://x402.org/facilitator`, which is listed at docs.hedera.com/solutions/ai/x402/facilitators. If it is down, switch to `https://testnet.facilitator.launa.dev` or `https://api.testnet.blocky402.com`; no code change needed. The server reads `/supported` once, lazily, on the first `/signal` request. If that call fails, `/signal` returns 503 `facilitator_unavailable` and the server tries again on the next request.

Live check from this repo on 2026-11-06:

- The server built the 402 against all three facilitators.
- A real `@x402/fetch` payment, signed with the Hedera SDK by an unknown account, reached x402.org `/verify`. It was rejected with `invalid_exact_hedera_payload_signature_invalid`, which is expected because that account's on-chain key isn't ours.

So the facilitator accepts our payload format. The only missing piece is a funded account.

### Code map

| File | What |
|---|---|
| `server/src/payments/x402Server.ts` | `registerPaidRoutes(app, { config, getSignal, facilitator?, onSettled? })`: `GET /signal` → 402 → verify → run handler → settle → 200 |
| `server/src/payments/x402Client.ts` | `X402Payer` / `payForSignal(url)`: `@x402/fetch` + Hedera exact client scheme, with policy checks before signing |
| `server/src/payments/spendControls.ts` | `SpendCap` (daily tinybar budget in `server/.ghosty/spend.json`) and `isHostAllowed` |
| `server/src/payments/hcsAudit.ts` | `HcsAuditLog`: creates one HCS topic (cached in `server/.ghosty/hcs.json`), writes one message per payment or decision, exposes `topicUrl()` |
| `server/src/payments/index.ts` | `createPayments(config)`: real when `HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY` are set, otherwise the fake payer |
| `server/src/scripts/x402Demo.ts` | `npm run x402:demo`: pays once, prints the tx ID and HashScan link, appends to `docs/evidence.md` |
| `server/test/x402.test.ts` | Offline tests: local stub facilitator over HTTP, real client signing, spend cap, allowlist, HCS |

### Spend controls (extra credit, done)

These checks run in order, before anything is signed:

1. **Host allowlist:** `X402_ALLOWED_HOSTS`, default `localhost,127.0.0.1`. Entries can be `host`, `host:port` or `*.domain`.
2. **Payment shape:** the network must be `hedera:testnet` (or whatever `HEDERA_NETWORK` says), the asset must be HBAR `0.0.0`, and `payTo` must not be the payer.
3. **Per-payment cap:** `X402_MAX_PER_CALL_TINYBAR`, default 0.1 HBAR, enforced by `@x402/core` spendControls.
4. **Daily cap:** `X402_MAX_SPEND_TINYBAR`, default 1 HBAR per UTC day, persisted in `server/.ghosty/spend.json`.

A payment counts against the daily cap as soon as it is signed, because anyone holding a signed transfer can submit it. Payments run one at a time, so concurrent calls can't race past the cap.

### HCS audit topic (extra credit, done)

When Hedera keys are set, the first payment creates an HCS topic and caches its ID. The topic memo is `ghosty: x402 payments and trade decisions` and its submit key is the agent key. Every payment then writes `{ts, kind:"payment", txId, requestId, summary}`.

- The agent loop can log trade decisions with `audit.record({ kind: 'decision', … })`.
- To reuse an existing topic, set `HEDERA_HCS_TOPIC_ID`.
- `HEDERA_ACCOUNT_ID` pays the HCS fees, a fraction of a cent per message.

### Fund the testnet accounts

1. Sign in at https://portal.hedera.com, pick **Testnet** and create an account. Copy the **account ID** (`0.0.…`) and the **private key**. The key is either DER (`3030…`) or hex; hex ECDSA is the default, so keep `HEDERA_KEY_TYPE=ecdsa`. New portal accounts come funded.
2. Create a **second** account the same way for the merchant (`X402_PAY_TO`). Only its account ID goes in `.env`.
3. Top up the payer at https://portal.hedera.com/faucet (100 HBAR/day to an EVM address or account).
4. Check the balance: `curl -s "https://testnet.mirrornode.hedera.com/api/v1/balances?account.id=0.0.X"`.

### Run it

```bash
cd server
cp .env.example .env   # set HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, X402_PAY_TO
npm run dev            # terminal 1 (app.ts must call registerPaidRoutes)
curl -s -i http://localhost:3000/signal   # 402 + requirements
npm run x402:demo      # terminal 2: pays, prints tx ID + HashScan link, appends to docs/evidence.md
```

### What judges should look at

- `docs/evidence.md`: settled tx IDs with HashScan links, one row per autonomous payment.
- A HashScan transaction page: a CRYPTOTRANSFER in which the agent account sends 0.01 HBAR to the merchant and the facilitator's fee payer pays the fee.
- The HCS topic on HashScan (the demo prints the link): one message per payment, carrying the same tx ID and the 0G request ID of the signal.
- `server/src/payments/x402Client.ts` (no human in the loop, guard rails before signing) and `server/test/x402.test.ts`.

## Still unverified

- **A real settlement on `hedera:testnet` with our code.** This needs a funded account, and none is available in this environment. Everything up to the facilitator's signature check was verified live.
- **HCS topic creation and message submission on testnet**, for the same reason. These are covered only by tests with a fake transport.

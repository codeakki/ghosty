# Hedera in Ghosty: how the agent pays

Track: ETHGlobal "AI Agents That Pay: x402 on Hedera". This page is for the team: what the code does, where it lives, and how to check it on chain.

## 1. The story in five sentences

When a shock headline arrives ("missile strikes near Hormuz"), Ghosty's agent wants a second opinion before it asks 0G to decide. It buys one from the **Signal Desk**, a separate x402 merchant that sells a "headline intelligence" bundle: the source's Ethos credibility, how many other outlets carry the same story, and a shock category with a severity. The agent pays from its own small hot wallet, in USDC (an HTS token) or HBAR, with no human approval, inside daily and per-call caps. After the facilitator settles, Ghosty checks the transaction itself on the Hedera mirror node and only then calls the payment verified. The bundle goes into the 0G decision prompt, and the payment and the decision are written as JSON messages to an HCS audit topic anyone can read.

## 2. One decision, step by step

```
headline (news poller or POST /news/inject)
  │
  ├─ shock? brain online (not safe-stop, 0G reachable)?  ── no ──▶ decide without buying (or not at all)
  │ yes
  ▼
Agent (x402Client)                Signal Desk :3101            Facilitator (Blocky402)       Hedera
  │ GET /intel?headline=…  ─────────▶│
  │◀──── 402 accepts: USDC 0.01, HBAR 0.01
  │ checks: host allowlist, asset, payTo≠self, per-call cap, daily cap (per asset)
  │ signs TransferTransaction agent → desk (USDC 10000 micro-units)
  │ GET /intel + PAYMENT-SIGNATURE ─▶│ verify ─────────────────▶│
  │                                  │ builds the bundle (before settling)
  │                                  │ settle ─────────────────▶│ co-signs as fee payer, submits ─▶ consensus
  │◀──── 200 bundle + PAYMENT-RESPONSE (tx id)
  │
  ├─ background: mirror node GET /api/v1/transactions/{id}  (poll ≤ 15 s)
  │     result SUCCESS and agent −10000 / desk +10000 of 0.0.429274?  → verified: true
  │     → HCS message {v:1, kind:"payment", txId, asset, amount, payTo, verified}
  ▼
0G decide (prompt includes paidIntel)  ── waits ≤ X402_AUTOPAY_WAIT_MS for the purchase, then decides without it
  ▼
episode: decision.paidIntel {txId, provider, verified}  +  HCS {v:1, kind:"decision", requestId, signal, txId}
  ▼
(button confirm → trade → HCS {v:1, kind:"trade", requestId, signal, txId})
```

### The payment flow and its guards

There is exactly **one** autonomous payment flow: buy intel **before** the 0G decision, for a headline. (PR #44 paid for a `/signal` route on our own server after each decision; that route only returned our own previous decision, so it was replaced.)

The agent pays only when the decision will actually run:

- the headline matches the shock detector (`news/shock.ts`), otherwise nothing is bought;
- the brain is online: not in safe-stop, and the 0G health probe answers (`isBrainOnline`);
- `X402_AUTOPAY=true` and the Hedera keys are set.

It never pays for: simulation runs (`/sim/run`, paper only; the SimEngine has no buyer), Claude-answered voice turns, or voice trade turns (they are not tied to one headline). A failed or refused payment never blocks the decision. Two buys for the same headline at once share one payment; at most two payments can be in flight, a third is refused and logged.

The honest trade-off: we buy *before* deciding, so if the 0G call itself then fails (the probe said online, the call timed out), that bundle was paid for nothing. That happened once in our live run (see [evidence.md](evidence.md)). The cost is one 0.01 USDC; the gain is that 0G decides *with* the intel.

Timing knobs: `X402_AUTOPAY_WAIT_MS` (default 8000) caps how long a decision waits for the purchase; after that 0G decides without it and the late purchase is still recorded. The 0G decider has its own timeout (`OG_DECIDE_TIMEOUT_MS`, 45 s). After the decision the episode waits at most 3 s for the mirror check; if it is not done, the episode says `verified: null` and `GET /x402/status` shows the final answer.

## 3. Where is the code

| Step | File:line | Function |
|---|---|---|
| Decide whether to buy (shock, brain online) | `server/src/app.ts:211` | `buyIntel` closure in `buildApp` |
| Buy before deciding, pass `paidIntel` to 0G, write episode + HCS decision | `server/src/pipeline.ts:307` | `Pipeline.decide` |
| One purchase per headline, then verification + HCS payment message | `server/src/payments/intelBuyer.ts:83`, `:95` | `IntelBuyer.buy`, `buyOnce` |
| Pay a 402: allowlist, asset preference, caps, bounded queue | `server/src/payments/x402Client.ts:170`, `:181`, `:202` | `X402Payer.pay`, `checkPolicy`, `payOnce` |
| Daily caps per asset (bigint, persisted) | `server/src/payments/spendControls.ts:48` | `SpendCap` |
| The merchant: 402 with USDC + HBAR, verify → produce → settle | `server/src/payments/x402Server.ts:69` | `registerPaidRoute` |
| The Signal Desk app and the bundle | `server/src/payments/signalDesk.ts:174`, `:135` | `buildSignalDeskApp`, `IntelService.bundle` |
| Mirror-node verification | `server/src/payments/mirror.ts:68`, `:53` | `verifyPaymentOnMirror`, `checkTransfer` |
| HCS message format and writer | `server/src/payments/hcsAudit.ts:41`, `:156`, `:98` | `encodeAuditMessage`, `HcsAuditLog.record`, `SdkHcsTransport.submit` |
| HCS reader (`GET /hedera/audit`) | `server/src/payments/hcsAudit.ts:196`, `server/src/integrations.ts:124` | `readAuditLog` |
| Status (`GET /x402/status`) | `server/src/integrations.ts:100` | route |
| 0G prompt with `paidIntel` | `server/src/agent/decide.ts:190` | `SYSTEM_PROMPT`, `buildUserPayload` |
| Custody split, idempotent | `server/src/payments/setup.ts:49`, `server/src/scripts/hederaSetup.ts` | `runSetup` |
| Close the HCS client on shutdown | `server/src/index.ts:58` | `shutdown` |

Every file in `server/src/payments/` starts with a short comment saying what it does; `payments/index.ts` has a map of the folder.

## 4. Accounts and keys

| Role | Account / key | Env | Holds | Can do | Used by |
|---|---|---|---|---|---|
| Treasury | [0.0.10499008](https://hashscan.io/testnet/account/0.0.10499008) (ECDSA) | `HEDERA_TREASURY_ACCOUNT_ID`, `HEDERA_TREASURY_PRIVATE_KEY` | the bulk (~835 HBAR, ~18.9 USDC) | tops up the agent, HCS topic **admin** key | `npm run hedera:setup` only. The server never reads it. |
| Agent (hot wallet) | [0.0.11342726](https://hashscan.io/testnet/account/0.0.11342726) (ECDSA) | `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` | ~20 HBAR + ~5 USDC | signs x402 payments; pays HCS message fees | the Ghosty server |
| Merchant (Signal Desk) | [0.0.11342424](https://hashscan.io/testnet/account/0.0.11342424) | `X402_PAY_TO` (+ `HEDERA_MERCHANT_PRIVATE_KEY` for setup) | what it earns | receives HBAR and USDC (associated with 0.0.429274) | the Signal Desk only needs the account id; the key is used once by setup to associate USDC |
| HCS submit key | key only, no account | `HEDERA_HCS_SUBMIT_KEY` | nothing | the only key that can write to the audit topic | the Ghosty server (co-signs each message) |
| Facilitator fee payer | 0.0.9185802 (Blocky402 / x402.org) | none | theirs | co-signs and submits settlements | the facilitator; we never hold its key |

Why a separate HCS submit key instead of a third account: it is the simplest option that still separates powers. A leaked submit key can spam the topic but cannot move money; a leaked agent key can spend at most the agent's ~20 HBAR + 5 USDC and cannot write audit messages. The treasury key is the topic admin, so it can rotate the submit key. HCS fees (~0.0008 HBAR per message, three messages per paid decision) are paid by the agent and bounded by `HEDERA_HCS_MAX_MESSAGES_PER_DAY` (default 500, about 0.4 HBAR); we did not add a second money budget for them because they are two orders of magnitude below the intel spend.

Caps for a demo day (defaults): per call 0.1 HBAR / 0.1 USDC; per UTC day 5 HBAR (500 buys at 0.01) and 2 USDC (200 buys at 0.01). Raise them in `.env` (`X402_MAX_SPEND_TINYBAR`, `X402_MAX_SPEND_USDC_MICROS`); the old default (1 HBAR) stopped after ~100 calls.

### Why custom caps and not a Hedera Agent Kit policy

Agent Kit policies (`AbstractPolicy`) run only around Agent Kit tools that extend `BaseTool`. Our payments are not Agent Kit tools: they go through `@x402/fetch` and the x402 Hedera client scheme. Expressing the caps as a policy would mean wrapping the x402 client in a fake tool and adding the Agent Kit dependency, and the rules would be the same few lines (`checkPolicy` and `SpendCap`). We kept the plain code because it is shorter and easier to read. Roadmap: agent identity via HCS-14 / ERC-8004, and moving the treasury top-up to a Scheduled Transaction that needs a human co-signature.

## 5. How to run it

From `server/`, with `server/.env` filled in:

```bash
npm run hedera:setup        # testnet only. Creates/associates/funds only what is missing; second run: "nothing to do"
npm run signal-desk         # the merchant on SIGNAL_DESK_PORT (default 3101)
npm run dev                 # Ghosty on PORT; buys intel from SIGNAL_DESK_URL (default http://127.0.0.1:3101)

# one decision that buys intel (no trade, no button):
curl -X POST localhost:3000/news/inject -H 'content-type: application/json' -H "x-device-token: $DEVICE_TOKEN" \
  -d '{"title":"TEST: missile strikes reported near Strait of Hormuz","source":"reuters"}'

curl localhost:3000/x402/status          # lastPayment: txId, HashScan link, amount, verified
curl 'localhost:3000/hedera/audit?limit=20'   # decoded HCS messages, newest first

npm run x402:demo -- "some headline"     # one standalone purchase; appends a row to docs/evidence.md
X402_PREFERRED_ASSET=hbar npm run x402:demo   # same, paying in HBAR
```

The free `GET /health` on the desk shows who it pays and its prices. `curl -i 'localhost:3101/intel?headline=x'` shows the raw 402.

The Signal Desk is designed to be an independent third party: its own process, port, Hedera account and (in production) host. It shares code with Ghosty but no state and no keys. For the demo it runs next to the server. To point Ghosty at a remote desk, set `SIGNAL_DESK_URL` and add its host to `X402_ALLOWED_HOSTS`.

## 6. What judges should look at

- A payment the agent made on its own before a 0G decision, verified on chain: [0.0.9185802@1793984888.876950864](https://hashscan.io/testnet/transaction/0.0.9185802-1793984888-876950864) (0.01 USDC, agent 0.0.11342726 → desk 0.0.11342424). 0G decision `bb6d851f-34c9-41f5-8a83-b7f755059320` used it ("paid intel confirms medium-severity geopolitical shock").
- An HBAR payment from `npm run x402:demo`: [0.0.9185802@1793984930.617250384](https://hashscan.io/testnet/transaction/0.0.9185802-1793984930-617250384).
- The HCS audit topic, with payment and decision messages: [0.0.11342727](https://hashscan.io/testnet/topic/0.0.11342727).
- All rows: [evidence.md](evidence.md#hedera-x402-settled-transactions).
- Tests (offline): `server/test/x402.test.ts`, `server/test/x402-autopay.test.ts`.

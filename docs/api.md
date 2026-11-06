# HTTP API

Contract between the pod (ESP32) and the server. Base URL during development is the laptop's LAN IP, e.g. `http://192.168.1.50:3000`. The scaffold server returns stubbed data; the shapes below match `server/src/app.ts` and are what the real implementation must keep.

## Conventions

| Item | Value |
|---|---|
| Auth | `X-Device-Token: <shared secret>` on `/voice` and `/button`, checked only when `DEVICE_TOKEN` is set in `server/.env` (unset = local dev, no check). Must match the token in `firmware/libraries/GhostyBoard/src/secrets.h`. |
| Errors | JSON `{ "error": "<code>" }`, sometimes with a `"message"` |
| Audio in | `audio/wav` (also `audio/x-wav`, `audio/wave`, `application/octet-stream`): PCM WAV, 16-bit signed little-endian, mono, 16 000 Hz expected. Body limit 4 MB. |
| Audio out | `application/octet-stream`, raw s16le, 16 000 Hz, mono, no header |
| Safe-stop | When the brain (0G Compute) is unreachable, `/voice` and `/button` return `503 {"error":"brain_offline"}` and nothing is executed. A 0G call that fails mid-request (`BrainOfflineError`) gives the same 503, with `reason` and the router `requestId`. If the encrypted memory on 0G Storage cannot be loaded or decrypted (`MemoryUnavailableError`), the answer is `503 {"error":"memory_unavailable"}`. The server never falls back to a fake decision. |
| Transport | Plain `http://` on the LAN for dev. HTTPS off-LAN (device uses `WiFiClientSecure::setInsecure()` for the demo only). |

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness + safe-stop state |
| POST | `/voice` | device token | Push-to-talk: WAV in, spoken answer out |
| POST | `/button` | device token | Confirm or cancel the last suggested trade |
| GET | `/signal` | x402 payment | Premium signal, paid per call in HBAR on Hedera testnet |

Sim-only routes for the [virtual pod](simulator.md). The firmware does not call them; they do not change the device contract above.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/sim` | none | Virtual pod web UI (static HTML) |
| GET | `/state` | none | Pod state snapshot |
| GET | `/events` | none | Server-sent events: `state`, `news`, `decision`, `alert`, `order`, `episode` |
| POST | `/voice/text` | device token | Text turn: decide + TTS without STT, JSON out |
| POST | `/news/inject` | device token | Add a headline and run the decision loop; queues an alert when actionable |
| GET | `/alerts/next` | device token | Pop the oldest pending alert, or `204` (meant for a later firmware poll) |
| POST | `/alerts/:id/ack` | device token | Acknowledge an alert |
| POST | `/sim/safe-stop` | device token | Simulate 0G offline at runtime |
| POST | `/sim/pay-signal` | device token | The agent pays our own `GET /signal` through x402 (fake payer without Hedera keys) |

Integration status routes (read-only, no auth). Used by the dashboard; the firmware does not call them.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zerog/status` | none | 0G Compute/Storage mode, brain online, last request id, memory root, episode count, explorer links |
| GET | `/x402/status` | none | x402 spend today vs daily cap, allowlist, HCS topic link, last payment |
| GET | `/execution/markets` | none | Hyperliquid markets, playbook aliases resolved to real tickers, Uniswap spot-leg config |

---

## GET /health

No auth. Used by the device on boot and by the demo dashboard.

**200**

```json
{
  "ok": true,
  "version": "0.1.0",
  "safeStop": false
}
```

`safeStop: true` means the brain (0G Compute) is unreachable and trading is blocked. The scaffold sets it from `SIMULATE_BRAIN_OFFLINE` (and skips the check when `SAFE_STOP_ENABLED=false`); a real router ping is a TODO in `server/src/safety/safeStop.ts`.

```bash
curl -s http://localhost:3000/health
```

---

## POST /voice

Push-to-talk round trip. The device records while the button is held, then posts the whole clip.

**Request**

| Header | Value |
|---|---|
| `Content-Type` | `audio/wav` or `application/octet-stream` |
| `X-Device-Token` | shared secret (required only when `DEVICE_TOKEN` is set) |
| `Content-Length` | 44 + PCM bytes (5 s ≈ 160 044 bytes) |

Body: WAV, 16-bit, mono, 16 kHz expected (other rates are accepted with a server warning). Body limit 4 MB.

**Response 200**

| Header | Value |
|---|---|
| `Content-Type` | `application/octet-stream` |
| `x-sample-rate` | `16000` |
| `x-request-id` | 0G Compute request ID for this decision (evidence for judges) |
| `x-signal` | signal class of the decision, e.g. `geopolitical_shock` or `none` |

Body: raw PCM s16le, 16 kHz, mono. The device reads `http.getStreamPtr()` in 1–2 KB chunks and writes each chunk to I2S. The scaffold's fake TTS returns 0.5 s of a 440 Hz tone (16 000 bytes).

**Errors** (all JSON, no audio body)

| Status | When | Body |
|---|---|---|
| 400 | Empty body | `{"error":"expected_wav_body"}` |
| 400 | Not a RIFF/WAVE file, missing chunks, not PCM, not 16-bit, not mono | `{"error":"bad_wav","message":"expected mono, got 2 channels"}` |
| 401 | `DEVICE_TOKEN` is set and `X-Device-Token` is missing or wrong | `{"error":"unauthorized"}` |
| 503 | Safe-stop: brain (0G Compute) offline | `{"error":"brain_offline"}` |

Firmware rule (`06_CloudVoice`): play the body only on `200`. On `503` play nothing and blink the red LED (GPIO33) 3 times fast; on any other error blink 5 times slowly.

```bash
# Make a test clip on a laptop (requires sox or ffmpeg)
ffmpeg -i any.m4a -ar 16000 -ac 1 -sample_fmt s16 sample.wav

# Round trip, save raw PCM
curl -s -X POST http://localhost:3000/voice \
  -H "Content-Type: audio/wav" \
  -H "X-Device-Token: $DEVICE_TOKEN" \
  --data-binary @sample.wav \
  -D - -o reply.pcm

# Listen to the reply
ffplay -f s16le -ar 16000 -ac 1 reply.pcm      # or: play -t raw -r 16000 -e signed -b 16 -c 1 reply.pcm

# 401 check (only when DEVICE_TOKEN is set on the server)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/voice \
  -H "Content-Type: audio/wav" --data-binary @sample.wav
```

---

## POST /button

Confirms or cancels the last decision spoken by `/voice`.

**Request**

```http
POST /button
Content-Type: application/json
X-Device-Token: <secret>

{ "action": "confirm" }
```

| `action` | Meaning |
|---|---|
| `confirm` | Execute the plan: the Uniswap spot leg first (only with `UNISWAP_SPOT_LEG=true`), then the confirmed Hyperliquid perp legs |
| `cancel` | Drop them; logged to the episode log as `cancelled` |

There is no "nothing pending" error. If no decision is pending (for example a press right after boot), the server decides from the current news alone and acts on that. The fake news feed already contains a geopolitical headline, so a bare `confirm` produces a trade plan.

**Response 200**

```json
{
  "action": "confirm",
  "requestId": "fake-3f2c…",
  "signal": "geopolitical_shock",
  "executed": true,
  "actions": [{ "venue": "hyperliquid", "kind": "perp", "coin": "xyz:GOLD", "side": "long", "sizeUsd": 12.5, "reason": "..." }],
  "orders": [{ "orderId": "fake-hl-000001", "coin": "xyz:GOLD", "isBuy": true, "sizeUsd": 12.5, "status": "simulated" }],
  "swaps": []
}
```

Values above are illustrative. With the default `MAX_TRADE_USD=25` and a balanced profile the playbook gives one $12.50 gold leg, because every Hyperliquid leg must be at least $10. `executed` is true only for `confirm` with at least one order or swap. Real tickers come from `meta(dex:"xyz")` at runtime (`WTI` resolves to `xyz:CL`). A real order adds `assetId`, `filled`, `avgPx`, `url` (Hyperliquid explorer) and `fallback: true` when `HL_FALLBACK_COINS` replaced a missing market; a rejected leg has `status: "rejected"` and `error`. `swaps[]` entries are `{action, result: {quoteId, txHash, status, explorerUrl, route}}` or `{action, error}`.

**Errors**

| Status | When | Body |
|---|---|---|
| 400 | Body is not JSON or `action` is not `confirm`/`cancel` | `{"error":"bad_request","message":"..."}` |
| 401 | `DEVICE_TOKEN` is set and `X-Device-Token` is missing or wrong | `{"error":"unauthorized"}` |
| 503 | Safe-stop: brain (0G Compute) offline, no order is sent | `{"error":"brain_offline"}` |
| 503 | 0G memory blob could not be loaded or decrypted | `{"error":"memory_unavailable","message":"..."}` |

```bash
curl -s -X POST http://localhost:3000/button \
  -H "Content-Type: application/json" \
  -H "X-Device-Token: $DEVICE_TOKEN" \
  -d '{"action":"confirm"}'

curl -s -X POST http://localhost:3000/button \
  -H "Content-Type: application/json" \
  -H "X-Device-Token: $DEVICE_TOKEN" \
  -d '{"action":"cancel"}'
```

---

## Virtual pod (sim-only)

> **Sim-only, not used by firmware.** These routes back the browser simulator at `/sim` and the `npm run pod` CLI
> ([simulator.md](simulator.md)). `GET /alerts/next` is shaped so the firmware can poll it later, but no sketch calls
> it today. State is in memory and resets on restart.

"Device token" below means the same `X-Device-Token` check as `/voice`: enforced only when `DEVICE_TOKEN` is set.
The read-only routes (`/sim`, `/state`, `/events`) are open because `EventSource` cannot send headers.
Routes that run the decision loop (`/voice/text`, `/news/inject`) return `503 {"error":"brain_offline"}` during safe-stop, like `/voice`.

### GET /sim

The virtual pod page, `text/html`. Open `http://localhost:3000/sim`. The microphone only works on `localhost` or HTTPS.

### GET /state

**200**: the whole pod state. Lists are newest first.

```json
{
  "news": [{ "id": "rss:coindesk:fake-1", "source": "rss", "title": "Missile strike near ...", "url": "...", "publishedAt": "...",
             "handle": "CoinDesk", "credibility": { "handle": "CoinDesk", "score": 1850, "level": "reputable", "weight": 1 },
             "signal": "geopolitical_shock" }],
  "credibility": { "CoinDesk": { "handle": "CoinDesk", "score": 1850, "level": "reputable", "weight": 1 } },
  "lastDecision": { "requestId": "fake-…", "signal": "geopolitical_shock", "confidence": 0.95, "rationale": "...",
                    "trigger": "inject", "transcript": "", "headline": "War breaks out ...", "at": "..." },
  "plannedActions": [{ "venue": "hyperliquid", "kind": "perp", "coin": "xyz:GOLD", "side": "long", "sizeUsd": 12.5, "reason": "..." }],
  "orders": [{ "orderId": "fake-hl-000001", "coin": "xyz:GOLD", "isBuy": true, "sizeUsd": 12.5, "status": "simulated", "requestId": "fake-…", "at": "..." }],
  "swaps": [],
  "episodes": [{ "seq": 1, "at": "...", "outcome": "proposed", "requestId": "fake-…", "actions": [], "decision": {} }],
  "safeStop": false,
  "alerts": [{ "id": "alert-1", "text": "...", "signal": "geopolitical_shock", "actions": [], "requestId": "fake-…",
               "confidence": 0.95, "headline": "...", "status": "pending", "createdAt": "..." }]
}
```

`trigger` is `voice`, `text`, `button` or `inject`. News items carry `credibility` (the Ethos object for `handle`) and, from the live aggregator, `weight` (0.2–1.0). `swaps` lists Uniswap spot legs (`UNISWAP_SPOT_LEG=true`). `plannedActions` empties after a button press. Alert `status` goes `pending` → `delivered` (popped by `/alerts/next`) → `acked`.

### GET /events

`text/event-stream`. On connect: a `retry: 2000` hint and one `state` event with the full snapshot. Then, as the pipeline runs:

| Event | `data` |
|---|---|
| `state` | Full snapshot (same as `/state`), coalesced after changes |
| `news` | A newly seen news entry, with `credibility` and `signal` |
| `decision` | `lastDecision` plus `actions` |
| `alert` | A new alert |
| `order` | One order entry |
| `episode` | One episode record |

A `: ping` comment every 15 s keeps the connection open.

```bash
curl -N http://localhost:3000/events
```

### POST /voice/text

Body `{"text": "<1–2000 chars>"}`. Runs the voice loop without STT. **200**:

```json
{ "transcript": "is anything moving gold?", "requestId": "fake-…", "signal": "geopolitical_shock", "confidence": 0.95,
  "rationale": "...", "actions": [ ... ], "sampleRate": 16000, "audioBytes": 16000, "audioBase64": "<PCM s16le>" }
```

Errors: `400 bad_request`, `401`, `503 brain_offline`.

### POST /news/inject

Body `{"title": string, "source"?: string, "url"?: string}`. `source` is the outlet or X handle (e.g. `Reuters`) and is used for credibility scoring. The headline joins the news feed and the decision loop runs with it first. An actionable decision (`signal` not `none`) is queued as an alert and becomes the pending trade for `/button`. **200**:

```json
{ "item": { "id": "inject:1", "source": "inject", "title": "...", "url": "", "publishedAt": "...", "handle": "Reuters" },
  "decision": { "requestId": "fake-…", "signal": "geopolitical_shock", "confidence": 0.95, "rationale": "...", "actions": [ ... ] },
  "alert": { "id": "alert-1", "status": "pending", ... } }
```

`alert` is `null` when the decision is `none`. Errors: `400 bad_request`, `401`, `503 brain_offline`.

```bash
curl -s -X POST localhost:3000/news/inject -H 'content-type: application/json' \
  -d '{"title":"War breaks out: missile strikes hit Gulf oil terminals","source":"Reuters"}'
```

### GET /alerts/next

Pops the oldest pending alert and marks it `delivered`. **200** `{id, text, signal, actions, requestId, confidence, headline, createdAt}`, or **204** with no body when the queue is empty. `401` on a bad token.

### POST /alerts/:id/ack

**200** `{"ok": true, "alert": {...}}` with `status: "acked"`. **404** `{"error":"not_found"}`.

### POST /sim/safe-stop

Body `{"enabled": boolean}`. `true` simulates 0G being unreachable (the runtime twin of `SIMULATE_BRAIN_OFFLINE`): `/health` reports `safeStop: true` and `/voice`, `/button`, `/voice/text` and `/news/inject` answer `503 brain_offline`. **200** `{"safeStop": true, "simulateOffline": true}`. With `SAFE_STOP_ENABLED=false` the check is bypassed and `safeStop` stays `false`.

---

## Integration status

Read-only snapshots for the dashboard. No device token. Each one works with an empty `.env` and reports `fake` modes.

### GET /zerog/status

```json
{
  "computeOnline": true,
  "computeMode": "0g",
  "storageMode": "0g",
  "model": "glm-4.7",
  "routerUrl": "https://router-api.0g.ai/v1",
  "lastRequestId": "<x_0g_trace.request_id of the last 0G decision>",
  "lastDecisionRequestId": "<request id of the latest decision, 0G or fake>",
  "lastDecisionAt": "2026-11-07T09:00:05.000Z",
  "memoryRootHash": "0x…",
  "memoryTxHash": "0x…",
  "episodeCount": 3,
  "lastEpisodeRoot": "0x…",
  "lastEpisodeTxHash": "0x…",
  "pendingEpisodes": 0,
  "lastStorageError": null,
  "links": {
    "storagescan": "https://storagescan-galileo.0g.ai",
    "memoryTx": "https://chainscan-galileo.0g.ai/tx/0x…",
    "lastEpisodeTx": "https://chainscan-galileo.0g.ai/tx/0x…"
  }
}
```

`computeOnline` follows the same probe as `/health` (router `GET /models`, cached 10 s) and the `/sim/safe-stop` switch. `computeMode` is `fake` without `OG_API_KEY`; `storageMode` is `memory` without `OG_PRIVATE_KEY`. Explorer links point at Galileo unless `OG_RPC_URL` is a mainnet RPC.

### GET /x402/status

```json
{
  "mode": "real",
  "network": "hedera:testnet",
  "payer": "0.0.1001",
  "payTo": "0.0.5005",
  "priceTinybar": 1000000,
  "maxPerCallTinybar": 10000000,
  "spentToday": 1000000,
  "cap": 100000000,
  "remainingToday": 99000000,
  "allowedHosts": ["localhost", "127.0.0.1"],
  "hcsTopicUrl": "https://hashscan.io/testnet/topic/0.0.…",
  "lastPayment": { "mode": "real", "txId": "0.0.1001@…", "hashscanUrl": "https://hashscan.io/testnet/transaction/…", "amountTinybar": 1000000, "requestId": "…", "at": "…" }
}
```

`mode` is `fake` without `HEDERA_ACCOUNT_ID` + `HEDERA_PRIVATE_KEY`; the fake payer is charged against an in-memory cap so the numbers still move. The real cap is persisted in `server/.ghosty/spend.json` (UTC day). `hcsTopicUrl` is `null` until the first audit message creates the topic (or `HEDERA_HCS_TOPIC_ID` is set).

### POST /sim/pay-signal

Device token. No body. The agent pays `http://127.0.0.1:$PORT/signal` with no human approval (`payForSignal` → x402 → facilitator → Hedera), then `/x402/status.lastPayment` shows the HashScan link.

**200** `{"mode","txId","hashscanUrl","amountTinybar","requestId","at","status","body","audit"}` where `body` is the paid `/signal` payload.

| Status | When | Body |
|---|---|---|
| 409 | Refused before signing: daily or per-call cap, host not allowlisted, payTo equals the payer | `{"error":"payment_refused","message":"..."}` |
| 502 | `/signal` did not settle (402 after retry, facilitator down, verify/settle failure) | `{"error":"payment_failed","message":"...","status":402,"reason":"..."}` |

### GET /execution/markets

Query: `dex` (`""` = main dex, `xyz`), `q` (substring of the coin), `limit` (default 100).

```json
{
  "perpMode": "real",
  "spotMode": "fake",
  "testnet": true,
  "dexes": ["xyz"],
  "spotLeg": null,
  "resolved": [
    { "alias": "GOLD", "coin": "xyz:GOLD", "assetId": 750003, "dex": "xyz", "fallback": false, "error": null },
    { "alias": "WTI", "coin": "xyz:CL", "assetId": 750029, "dex": "xyz", "fallback": false, "error": null },
    { "alias": "BTC", "coin": "BTC", "assetId": 3, "dex": "", "fallback": false, "error": null }
  ],
  "count": 1,
  "markets": [{ "coin": "xyz:GOLD", "dex": "xyz", "dexIndex": 65, "metaIndex": 3, "assetId": 750003, "szDecimals": 4, "delisted": false }]
}
```

`perpMode` is `fake` without `HL_AGENT_PRIVATE_KEY` + `HL_MASTER_ADDRESS`, `spotMode` is `fake` without `UNISWAP_API_KEY` + `EVM_PRIVATE_KEY`. `spotLeg` is the configured demo pair when `UNISWAP_SPOT_LEG=true`. **502** `{"error":"venue_unavailable"}` when the Hyperliquid info API fails. Asset ids above are illustrative.

---

## GET /signal (x402 on Hedera)

A premium signal endpoint behind an x402 paywall. The agent's own Hedera account pays for it on every call with no human approval; this is the Hedera track requirement. Code: `server/src/payments/x402Server.ts` (`registerPaidRoutes`), client `server/src/payments/x402Client.ts`. Notes: [research/hedera-x402.md](research/hedera-x402.md).

Protocol: x402 **v2** as spoken by `@x402/core` / `@x402/fetch` 2.30. Scheme `exact`, network `hedera:testnet`, asset HBAR `0.0.0`, amount in tinybars.

**Flow**

```
Agent (X402Payer)                        Server GET /signal                Facilitator (x402.org, hedera:testnet)
   | GET /signal                            |  (first call: GET /supported → feePayer, cached)
   |--------------------------------------->|                                 |
   |<-- 402 + PAYMENT-REQUIRED header ------|                                 |
   |    body: { x402Version: 2, accepts:[{scheme:"exact", network:"hedera:testnet",
   |            amount:"1000000", asset:"0.0.0", payTo, extra:{feePayer}}] }
   | policy checks (host allowlist, HBAR only, per-call + daily cap)
   | sign TransferTransaction (payer −amount, payTo +amount, tx id paid by feePayer)
   | GET /signal + PAYMENT-SIGNATURE         |                                 |
   |--------------------------------------->|-- POST /verify ---------------->|
   |                                        |<-- { isValid: true } -----------|
   |                                        |   getSignal()                   |
   |                                        |-- POST /settle ---------------->|  submits to Hedera
   |                                        |<-- { success, transaction } ----|
   |<-- 200 + PAYMENT-RESPONSE, x-payment-tx-id, signal JSON                  |
```

### Request headers

| Header | When | Value |
|---|---|---|
| `PAYMENT-SIGNATURE` | paid retry (x402 v2, what `@x402/fetch` sends) | base64 JSON `PaymentPayload` |
| `X-PAYMENT` | accepted as an alias (x402 v1 header name) | same base64 JSON `PaymentPayload` |

`PaymentPayload` (decoded):

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:3000/signal", "description": "...", "mimeType": "application/json" },
  "accepted": { "scheme": "exact", "network": "hedera:testnet", "amount": "1000000", "asset": "0.0.0", "payTo": "0.0.5005", "maxTimeoutSeconds": 180, "extra": { "feePayer": "0.0.9185802" } },
  "payload": { "transaction": "<base64 partially signed Hedera TransferTransaction>" }
}
```

### 402 Payment Required

Sent when there is no payment header, or when the payment is malformed, does not match the current requirements, fails `/verify`, or fails `/settle`. The body is the `PaymentRequired` object; the same object is base64-encoded in the `PAYMENT-REQUIRED` header (that is what `@x402/fetch` reads). `error` says why.

| Header | Value |
|---|---|
| `PAYMENT-REQUIRED` | base64 JSON of the body below |
| `Cache-Control` | `no-store` |

```json
{
  "x402Version": 2,
  "error": "payment required",
  "resource": {
    "url": "http://localhost:3000/signal",
    "description": "Ghosty premium market signal (credibility-weighted, decided on 0G Compute)",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "hedera:testnet",
      "amount": "1000000",
      "asset": "0.0.0",
      "payTo": "0.0.5005",
      "maxTimeoutSeconds": 180,
      "extra": { "feePayer": "0.0.9185802" }
    }
  ]
}
```

| Field | Source |
|---|---|
| `amount` | `X402_SIGNAL_PRICE_TINYBAR` (default `1000000` = 0.01 HBAR) |
| `asset` | `0.0.0` = HBAR. (A `"$0.01"` price would mean testnet USDC `0.0.429274`, not HBAR.) |
| `payTo` | `X402_PAY_TO`, falling back to `HEDERA_ACCOUNT_ID`. Must not be the payer's account. |
| `extra.feePayer` | Facilitator's fee-payer account from its `GET /supported` (x402.org: `0.0.9185802`) |

`error` values: `payment required` (no header), `invalid_payment_header`, `no_matching_payment_requirements`, any facilitator `invalidReason` (e.g. `invalid_exact_hedera_payload_signature_invalid`, `invalid_exact_hedera_payload_preflight_failed`), or a settle `errorReason` (e.g. `transaction_failed`).

### 200 OK

| Header | Value |
|---|---|
| `PAYMENT-RESPONSE` | base64 JSON `SettleResponse` (x402 v2) |
| `X-PAYMENT-RESPONSE` | same value (v1 name) |
| `x-payment-tx-id` | settled Hedera transaction id, e.g. `0.0.9185802@1762400000.123456789` |

Decoded `SettleResponse`: `{ "success": true, "transaction": "0.0.9185802@1762400000.123456789", "network": "hedera:testnet", "payer": "0.0.1001" }`.

Body:

```json
{
  "signal": "geopolitical_shock",
  "confidence": 0.72,
  "actions": [{ "venue": "hyperliquid", "coin": "xyz:GOLD", "side": "long", "sizeUsd": 5, "reason": "..." }],
  "requestId": "og-req-…",
  "paidTxId": "0.0.9185802@1762400000.123456789",
  "hashscanUrl": "https://hashscan.io/testnet/transaction/0.0.9185802-1762400000-123456789"
}
```

`signal`, `confidence`, `actions`, `requestId` come from the latest decision in the pod state (`buildApp` passes `getSignal: () => decisionToSignal(state.latestDecision())`). Before the first decision the route returns `{"signal":"none","confidence":0,"actions":[],"requestId":"no-decision-yet"}` behind the same paywall. The handler runs after `/verify` and before `/settle`, so a broken handler never charges the payer.

### Other errors

| Status | When | Body |
|---|---|---|
| 503 | No `X402_PAY_TO` / `HEDERA_ACCOUNT_ID` configured | `{"error":"payments_not_configured"}` |
| 503 | Facilitator `/supported` unreachable (retried on the next request) | `{"error":"facilitator_unavailable","facilitator":"https://x402.org/facilitator"}` |

### Try it

```bash
# Unpaid request: 402 + requirements (body and PAYMENT-REQUIRED header)
curl -s -i http://localhost:3000/signal

# Decode the header
curl -s -D - -o /dev/null http://localhost:3000/signal | awk -F': ' 'tolower($1)=="payment-required"{print $2}' | tr -d '\r' | base64 -d | jq

# Paid request: made by the agent (@x402/fetch + Hedera signer), not curl
cd server && npm run x402:demo        # prints tx id + HashScan link, appends docs/evidence.md
```

**Spend controls (agent side, before signing):** host allowlist `X402_ALLOWED_HOSTS`; HBAR on the configured network only; never pays its own account; per-payment cap `X402_MAX_PER_CALL_TINYBAR`; daily cap `X402_MAX_SPEND_TINYBAR` persisted in `server/.ghosty/spend.json`. Each payment is also written to an HCS audit topic (`server/src/payments/hcsAudit.ts`).

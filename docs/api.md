# HTTP API

Contract between the pod (ESP32) and the server. Base URL during development is the laptop's LAN IP, e.g. `http://192.168.1.50:3000`. The scaffold server returns stubbed data; the shapes below match `server/src/app.ts` and are what the real implementation must keep.

## Conventions

| Item | Value |
|---|---|
| Auth | `X-Device-Token: <shared secret>` on `/voice` and `/button`, checked only when `DEVICE_TOKEN` is set in `server/.env` (unset = local dev, no check). Must match the token in `firmware/libraries/GhostyBoard/src/secrets.h`. |
| Errors | JSON `{ "error": "<code>" }`, sometimes with a `"message"` |
| Audio in | `audio/wav` (also `audio/x-wav`, `audio/wave`, `application/octet-stream`): PCM WAV, 16-bit signed little-endian, mono, 16 000 Hz expected. Body limit 4 MB. |
| Audio out | `application/octet-stream`, raw s16le, 16 000 Hz, mono, no header |
| Safe-stop | When the brain (0G Compute) is unreachable, `/voice` and `/button` return `503 {"error":"brain_offline"}` and nothing is executed. |
| Transport | Plain `http://` on the LAN for dev. HTTPS off-LAN (device uses `WiFiClientSecure::setInsecure()` for the demo only). |

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness + safe-stop state |
| POST | `/voice` | device token | Push-to-talk: WAV in, spoken answer out |
| POST | `/button` | device token | Confirm or cancel the last suggested trade |
| GET | `/signal` | x402 payment | Premium signal, paid per call in HBAR on Hedera testnet |

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
| `confirm` | Execute the suggested actions (Hyperliquid market orders; the Uniswap spot leg is a TODO) |
| `cancel` | Drop them; logged to the episode log as `cancelled` |

There is no "nothing pending" error. If no decision is pending (for example a press right after boot), the server decides from the current news alone and acts on that. The fake news feed already contains a geopolitical headline, so a bare `confirm` produces a trade plan.

**Response 200**

```json
{
  "action": "confirm",
  "requestId": "fake-3f2c…",
  "signal": "geopolitical_shock",
  "executed": true,
  "actions": [{ "venue": "hyperliquid", "coin": "xyz:GOLD", "side": "long", "sizeUsd": 5, "reason": "..." }],
  "orders": [{ "orderId": "fake-hl-000001", "coin": "xyz:GOLD", "isBuy": true, "sizeUsd": 5, "status": "simulated" }]
}
```

Values above are illustrative. `executed` is true only for `confirm` with at least one order. Real `xyz:` tickers come from `meta(dex:"xyz")` at runtime.

**Errors**

| Status | When | Body |
|---|---|---|
| 400 | Body is not JSON or `action` is not `confirm`/`cancel` | `{"error":"bad_request","message":"..."}` |
| 401 | `DEVICE_TOKEN` is set and `X-Device-Token` is missing or wrong | `{"error":"unauthorized"}` |
| 503 | Safe-stop: brain (0G Compute) offline, no order is sent | `{"error":"brain_offline"}` |

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

`signal`, `confidence`, `actions`, `requestId` come from the injected `getSignal()` (the latest agent decision; `decisionToSignal(decision)` maps a `Decision`). Until the agent wiring passes one, the route returns `{"signal":"none","confidence":0,"actions":[],"requestId":"no-decision-yet"}` behind the same paywall. The handler runs after `/verify` and before `/settle`, so a broken handler never charges the payer.

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

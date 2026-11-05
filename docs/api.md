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
| GET | `/signal` | x402 payment | Future: premium signal, paid per call on Hedera |

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

## Future: GET /signal (x402 on Hedera)

A premium signal endpoint behind an x402 paywall. The agent's own Hedera wallet pays for it on every call with no human approval. This is the Hedera track requirement. See [research/hedera-x402.md](research/hedera-x402.md).

**Flow**

```
Client (agent wallet)                    Server /signal                 Facilitator (hedera:testnet)
   | GET /signal                            |                                 |
   |--------------------------------------->|                                 |
   |<-- 402 Payment Required ---------------|                                 |
   |    body: accepts[{scheme:"exact",      |                                 |
   |      network:"hedera:testnet",         |                                 |
   |      price, payTo:"0.0.X", asset}]     |                                 |
   | sign partial TransferTransaction       |                                 |
   | GET /signal  + X-Payment: <payload>    |                                 |
   |--------------------------------------->|-- verify + settle ------------->|
   |                                        |<-- ok, tx ID -------------------|
   |<-- 200 { signal ... } -----------------|                                 |
```

1. First request has no payment and gets `402` with the payment requirements (scheme `exact`, network `hedera:testnet`, price, `payTo` account, asset: HBAR `0.0.0` in tinybars or testnet USDC `0.0.429274`).
2. The client signs a partial Hedera `TransferTransaction` and retries with the `X-Payment` header.
3. The server's middleware hands the payload to a listed facilitator, which verifies and settles.
4. The server returns `200` with the signal. The settlement tx ID is logged and goes in the README with its HashScan link.

The exact 402 body fields and response header names follow whatever `@x402/express` emits; read them from the library rather than hand-rolling.

**Planned 200 body**

```json
{
  "id": "sig_01",
  "class": "geopolitical",
  "headline": "...",
  "sources": [{ "name": "cointelegraph", "ethosScore": 1800 }],
  "confidence": 0.72,
  "paidTxId": "0.0.X@1730000000.000000000"
}
```

```bash
# Unpaid request: expect 402 and the payment requirements
curl -s -i http://localhost:3000/signal

# Paid request is made by the agent with @x402/fetch, not curl.
# A manual retry would look like:
curl -s -i http://localhost:3000/signal -H "X-Payment: <base64 payment payload>"
```

**Spend controls (extra credit):** per-call price cap and a daily budget in the client wrapper, an allowlist of `payTo` accounts, and an HCS topic that records every payment.

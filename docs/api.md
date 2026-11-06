# HTTP API

Contract between the pod (ESP32) and the server. Base URL during development is the laptop's LAN IP, e.g. `http://192.168.1.50:3000`. The shapes below match `server/src/app.ts`. In live mode (the default) every answer is real or a `503 not_configured`; fakes exist only under `npm test`.

## Conventions

| Item | Value |
|---|---|
| Auth | `X-Device-Token: <shared secret>` on `/voice` and `/button`, checked only when `DEVICE_TOKEN` is set in `server/.env` (unset = local dev, no check). Must match the token in `firmware/libraries/GhostyBoard/src/secrets.h`. |
| Errors | JSON `{ "error": "<code>" }`, sometimes with a `"message"`. A provider without keys in live mode answers `503 {"error":"not_configured","provider","missingEnv":[...],"message"}` (see [Run modes](#run-modes-and-not_configured)). When a `message` is present it is written for the wearer/operator and the terminal shows it as is (`HTTP 409: Nothing to confirm. …`); branch on `error`, display `message`. |
| Audio in | `audio/wav` (also `audio/x-wav`, `audio/wave`, `application/octet-stream`): PCM WAV, 16-bit signed little-endian, mono, 16 000 Hz expected. Body limit 4 MB. |
| Audio out | `application/octet-stream`, raw s16le, 16 000 Hz, mono, no header |
| Safe-stop | When the brain (0G Compute) is unreachable, `/voice` and `/button` return `503 {"error":"brain_offline"}` and nothing is executed. A 0G call that fails mid-request (`BrainOfflineError`) gives the same 503, with `reason` and the router `requestId`. If the encrypted memory on 0G Storage cannot be loaded or decrypted (`MemoryUnavailableError`), the answer is `503 {"error":"memory_unavailable"}`. The server never falls back to a fake decision. |
| Transport | Plain `http://` on the LAN for dev. HTTPS off-LAN (device uses `WiFiClientSecure::setInsecure()` for the demo only). |

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness + safe-stop state |
| POST | `/voice` | device token | Push-to-talk: WAV in, spoken answer out |
| POST | `/button` | device token | Confirm or cancel the pending alert the wearer heard (409 when there is none) |
| GET | `/hedera/audit` | none | HCS audit topic messages (payments, decisions, trades), decoded from the mirror node |

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
| POST | `/sim/pay-signal` | device token | The agent buys a Signal Desk intel bundle through x402 (fake payer in test mode without Hedera keys). The paid `GET /intel` itself is on the Signal Desk process, see [below](#signal-desk-get-intel-x402-on-hedera) |

Simulation runs (historical scenario replay, paper trades only, see [simulation.md](simulation.md) and [below](#simulation-runs)):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/sim/scenarios` | none | Replay scenarios (real past events, sourced headlines) |
| POST | `/sim/run` | device token | Start a scenario replay → `{runId}` |
| POST | `/sim/control` | device token | `pause` / `resume` / `stop` the run |
| GET | `/sim/run` | none | Run status: sim time, progress, paper P&L vs hold, positions |
| GET | `/episodes` | none | Episode list (sim runs from the local log, plus the live 0G index) |
| GET | `/episodes/replay` | none | Walk an episode chain back from a root hash through `prevRoot` |

Integration status routes (read-only, no auth). Used by the dashboard; the firmware does not call them.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zerog/status` | none | 0G Compute/Storage mode, brain online, last request id, memory root, episode count, explorer links |
| GET | `/x402/status` | none | x402 spend today vs daily cap, allowlist, HCS topic link, last payment |
| GET | `/execution/markets` | none | Hyperliquid markets, playbook aliases resolved to real tickers, Uniswap spot-leg config |

Terminal routes (read-only, no auth). Used by the trading terminal; the firmware does not call them.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/providers/status` | none | Health of every provider (live / degraded / offline / not_configured), cached 30 s |
| GET | `/market/snapshot` | none | Watchlist prices, 24 h change, funding, open interest, volume (Hyperliquid, no keys) |
| GET | `/market/history` | none | Candles for one coin (main chart) |
| GET | `/` | none | The built terminal (`terminal/dist`) when it exists, with an SPA fallback |

## Run modes and not_configured

`GHOSTY_MODE` picks how missing keys behave:

| Mode | Set by | Missing keys |
|---|---|---|
| `live` (default) | `npm run dev`, `npm start`, `npm run start:live` | The slot is a NotConfigured stand-in: any call answers `503 not_configured`. No fake data, ever. |
| `test` | `npm test` (sets `GHOSTY_MODE=test`) | Deterministic offline fakes (tone TTS, keyword decider, fake venue, canned headlines). |

```json
{ "error": "not_configured", "provider": "groq", "missingEnv": ["GROQ_API_KEY"], "message": "groq is not configured: set GROQ_API_KEY" }
```

| Route (live, no keys) | Answer |
|---|---|
| `POST /voice` | `503 not_configured` (`groq`, then `elevenlabs`) before anything else; the terminal shows it |
| `POST /voice/text`, `/button`, `/news/inject` | `503 brain_offline` (safe-stop: no `OG_API_KEY` means no brain). With `SAFE_STOP_ENABLED=false` the decider itself refuses: `503 {"error":"brain_offline","reason":"not_configured","provider":"0g-router","missingEnv":["OG_API_KEY"]}`; without `OG_PRIVATE_KEY` the 0G Storage memory answers `503 not_configured` (`0g-storage`) |
| `POST /button` `confirm` | `503 not_configured` (`hyperliquid`) before the pending decision is consumed |
| `POST /sim/pay-signal` | `503 not_configured` (`hedera-payer`) |
| `GET /execution/markets` | Real tickers from the keyless Hyperliquid info API; `perpMode: "not_configured"` |
| `/voice/text` with a brain but no TTS key | `200` with the decision, `audioBytes: 0` and `tts: {"error":"not_configured","provider":"elevenlabs","missingEnv":[...]}` |

News in live mode: RSS and Polymarket are on (`NEWS_LIVE` defaults to `true`), Ethos weights are on (`ETHOS_ENABLED` defaults to `true`), CryptoPanic and Grok join when their keys are set. Headlines from `POST /news/inject` are labelled `source: "manual"`. In test mode both flags default to `false`.

CORS: in live mode the server answers CORS for `CORS_ORIGINS` (default `http://localhost:5173,http://127.0.0.1:5173`, the Vite dev server), including preflight `OPTIONS`.

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

`safeStop: true` means the brain (0G Compute) is unreachable and trading is blocked. It comes from `server/src/safety/safeStop.ts`: `SIMULATE_BRAIN_OFFLINE` (or `POST /sim/safe-stop`) forces it, `SAFE_STOP_ENABLED=false` skips the check, and otherwise the 0G router is pinged (`GET /models`, cached 10 s). In live mode without `OG_API_KEY` it is always `true`: there is no brain, so nothing trades.

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
| `x-request-id` | 0G Compute request ID for this decision (evidence for judges); the Claude message id (`msg_…`) for a Claude answer |
| `x-signal` | signal class of the decision, e.g. `geopolitical_shock` or `none` (always `none` for a Claude answer) |
| `x-answered-by` | `claude` (question or chit-chat, answered by Claude) or `0g` (trade request, 0G decision path) |

**Intent routing** (when `ANTHROPIC_API_KEY` is set and `CLAUDE_VOICE_ENABLED` is not `false`). After STT the transcript is routed by keywords (`server/src/claude/intent.ts`):

| Intent | Examples | Answered by | What happens |
|---|---|---|---|
| `question` | "what's moving gold?", "how is BTC doing?", "are you online?", "what did you just do?" | `claude` | Claude answers in at most ~45 spoken words from live context: watchlist mids + 24 h %, last ~10 headlines with credibility, last decision, pending alert and trade, recent orders, mode. No decision, no trade, the pending trade is untouched. Works during safe-stop. |
| `trade` | "should I buy gold?", "go long oil", "hedge my bitcoin" | `0g` | The existing 0G decision loop. `503 brain_offline` during safe-stop. |
| `confirm` | "yes", "confirm", "cancel" | `0g` | No decision and no execution: Ghosty says the button confirms or cancels the pending trade. |

Claude has a 20 s timeout. On any Claude error the pod says "I couldn't reach my research assistant. Please try again in a moment." (`answeredBy: "claude"`), never a made-up answer. Claude never decides trades and is never a fallback for 0G. Without the key every turn is a 0G decision (`answeredBy: "0g"`), as before.

Body: raw PCM s16le, 16 kHz, mono. The device reads `http.getStreamPtr()` in 1–2 KB chunks and writes each chunk to I2S. The scaffold's fake TTS returns 0.5 s of a 440 Hz tone (16 000 bytes).

**Errors** (all JSON, no audio body)

| Status | When | Body |
|---|---|---|
| 400 | Empty body | `{"error":"expected_wav_body"}` |
| 400 | Not a RIFF/WAVE file, missing chunks, not PCM, not 16-bit, not mono | `{"error":"bad_wav","message":"expected mono, got 2 channels"}` |
| 401 | `DEVICE_TOKEN` is set and `X-Device-Token` is missing or wrong | `{"error":"unauthorized"}` |
| 503 | Safe-stop: brain (0G Compute) offline | `{"error":"brain_offline"}` |

Firmware rule (`06_CloudVoice`): play the body only on `200`. On `503` play nothing and call `blinkRed(3)` (fast); on any other error `blinkRed(5)` (slow). On the ESP32-S3 there is no red LED, so these calls do nothing.

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

Confirms or cancels the **pending** decision: the last actionable decision the wearer was told about, either spoken by `/voice` (or `/voice/text`) or queued as an alert by the news poller or `/news/inject`. Only a decision with `signal` other than `none` and at least one leg becomes pending; its reply ends with "Press to confirm." A decision with nothing to act on never says that and never becomes pending (it also replaces an older pending one: the last thing the wearer heard was not a trade).

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

**Simulation:** when a simulation run has a pending decision (`GET /sim/run` → `pending` not null), the press goes to that run and fills on its PaperVenue at the historical price; no real venue is ever called, whatever keys are set. The answer then carries `"sim": true, "paper": true, "runId"`, order ids are `paper-<n>` with `status: "simulated"`, and `swaps` is always `[]`. Safe-stop still applies (503 `brain_offline`).

**Ghosty only trades on an alert you've heard.** A press never asks 0G for a new decision. With nothing pending (a press right after boot, a second press, a press after a `none` answer) both `confirm` and `cancel` answer `409 nothing_pending` and nothing is decided, ordered or swapped. A pending decision expires `PENDING_DECISION_TTL_SEC` (default 120) seconds after it was presented; a later press answers `409 alert_expired` and drops it. The pending decision is consumed by the first press, so two quick presses execute it at most once. The same rule holds for a simulation press: once the sim decision is confirmed or cancelled, the next press is a `409`, not a live decision.

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
| 409 | No pending decision (nothing presented, already confirmed/cancelled, or replaced by a `none` decision). Nothing is decided or executed | `{"error":"nothing_pending","message":"Nothing to confirm. Ghosty only trades on an alert you've heard."}` |
| 409 | The pending decision is older than `PENDING_DECISION_TTL_SEC` (default 120 s). It is dropped; nothing is executed | `{"error":"alert_expired","message":"Alert expired. Nothing was traded; wait for the next alert.","requestId":"<expired decision>"}` |
| 503 | Safe-stop: brain (0G Compute) offline, no order is sent | `{"error":"brain_offline"}` |
| 503 | 0G memory blob could not be loaded or decrypted | `{"error":"memory_unavailable","message":"..."}` |
| 503 | `confirm` in live mode without Hyperliquid keys, checked before the pending decision is consumed | `{"error":"not_configured","provider":"hyperliquid",...}` |

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
Routes that run the decision loop (`/voice/text`, `/news/inject`) return `503 {"error":"brain_offline"}` during safe-stop, like `/voice`. With Claude on, questions on `/voice` and `/voice/text` are still answered (only trade requests get the 503).

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
| `providers` | Full `/providers/status` body, sent when any provider changes state (polled every 30 s by the running server) |
| `market` | `{"ts", "mids": {"BTC": 75680.5, "xyz:GOLD": 4068.65, ...}}` for the watchlist, at most once per second |
| `sim` | Simulation run status, same shape as `GET /sim/run`, on change, at most 2/s (an auto-pause is sent at once) |
| `voice` | One conversation turn from `/voice` or `/voice/text`: `{"transcript", "reply", "answeredBy": "claude"\|"0g", "intent": "question"\|"trade"\|"confirm", "requestId"?, "trigger": "voice"\|"text", "at"}`. Not part of the `state` snapshot |

Every event a simulation run produces (`sim`, and its `market`, `news`, `decision`, `alert`, `order`, `episode`) carries `"sim": true, "runId", "scenarioId"`. Sim `market` events carry historical mids with `ts` = sim time; never mix them into the live ticker. Sim events never change the `state` snapshot.

A `: ping` comment every 15 s keeps the connection open. `providers` and `market` come from the running server (`npm run dev` / `npm start`), not from `buildApp`, so tests never see them.

```bash
curl -N http://localhost:3000/events
```

### POST /voice/text

Body `{"text": "<1–2000 chars>"}`. Runs the voice loop without STT, with the same intent routing as `/voice` (header `x-answered-by` too). **200**:

```json
{ "transcript": "Should I go long oil?", "answeredBy": "0g", "intent": "trade", "reply": "...",
  "requestId": "f337b8c5-…", "signal": "none", "confidence": 0.1, "rationale": "...", "actions": [ ... ],
  "assistantError": null, "sampleRate": 16000, "audioBytes": 301674, "audioBase64": "<PCM s16le>", "tts": null }
```

A Claude answer has `answeredBy: "claude"`, `intent: "question"`, `requestId: "msg_…"`, `signal: "none"`, `confidence: 0`, `actions: []`; `rationale` repeats `reply`. When Claude failed, `reply` is the fallback line and `assistantError` names the error class.

Errors: `400 bad_request`, `401`, `503 brain_offline` (trade path only when Claude is on), `503 not_configured`. `tts` is `null` normally, `{"error":"not_configured", ...}` with empty audio when no TTS key is set in live mode, or `{"error":"tts_failed","message"}` with empty audio when TTS failed or timed out (the reply text is still real).

### POST /news/inject

Body `{"title": string, "source"?: string, "url"?: string}`. `source` is the outlet or X handle (e.g. `Reuters`) and is used for credibility scoring. The headline joins the news feed and the decision loop runs with it first. An actionable decision (`signal` not `none` and at least one leg) is queued as an alert and becomes the pending trade for `/button` for `PENDING_DECISION_TTL_SEC` seconds; anything else returns `"alert": null`. **200**:

```json
{ "item": { "id": "manual:1", "source": "manual", "title": "...", "url": "", "publishedAt": "...", "handle": "Reuters" },
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

Read-only snapshots for the dashboard. No device token. Each one works with an empty `.env`: modes read `not_configured` in live mode and `fake` in test mode.

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

`computeOnline` follows the same probe as `/health` (router `GET /models`, cached 10 s) and the `/sim/safe-stop` switch. Without `OG_API_KEY`, `computeMode` is `not_configured` in live mode (`fake` in test mode); without `OG_PRIVATE_KEY`, `storageMode` is `not_configured` (`memory` in test mode). Explorer links point at Galileo unless `OG_RPC_URL` is a mainnet RPC.

### GET /x402/status

```json
{
  "mode": "real",
  "network": "hedera:testnet",
  "payer": "0.0.11342726",
  "payTo": "0.0.11342424",
  "signalDesk": "http://127.0.0.1:3101",
  "preferredAsset": "usdc",
  "budgets": {
    "HBAR": { "asset": "0.0.0", "price": "1000000", "maxPerCall": "10000000", "spentToday": "0", "cap": "500000000", "remainingToday": "500000000" },
    "USDC": { "asset": "0.0.429274", "price": "10000", "maxPerCall": "100000", "spentToday": "10000", "cap": "2000000", "remainingToday": "1990000" }
  },
  "priceTinybar": 1000000, "maxPerCallTinybar": 10000000, "spentToday": 0, "cap": 500000000, "remainingToday": 500000000,
  "allowedHosts": ["localhost", "127.0.0.1"],
  "hcsTopicUrl": "https://hashscan.io/testnet/topic/0.0.11342727",
  "autopay": true,
  "lastPayment": {
    "mode": "real", "txId": "0.0.9185802@1793984888.876950864", "hashscanUrl": "https://hashscan.io/testnet/transaction/…",
    "asset": "0.0.429274", "amount": "10000", "amountLabel": "0.01 USDC", "payTo": "0.0.11342424", "provider": "ghosty-signal-desk",
    "headline": "…", "verified": true, "trigger": "decision", "at": "…", "requestId": "desk-…",
    "audit": { "topicId": "0.0.11342727", "sequenceNumber": "2", "txId": "0.0.11342726@…" }
  }
}
```

Amounts are atomic-unit strings (tinybars, USDC micro-units). The top-level `priceTinybar` … `remainingToday` numbers are the HBAR budget, kept for the terminal. `mode` is `not_configured` in live mode without `HEDERA_ACCOUNT_ID` + `HEDERA_PRIVATE_KEY` (`fake` in test mode: in-memory cap, payments never `verified`). Real caps persist in `server/.ghosty/spend.json` (UTC day). `hcsTopicUrl` is `null` without `HEDERA_HCS_TOPIC_ID` + `HEDERA_HCS_SUBMIT_KEY`.

`lastPayment.verified` is `null` while the mirror-node check runs, then `true` (result SUCCESS and the exact transfer agent → payTo of that asset and amount) or `false` with `verifyReason`. A payment is never shown as verified on the facilitator's word alone.

`autopay` is `X402_AUTOPAY` (default `true`): before the 0G decision on a shock headline (live news or `/news/inject`), the agent buys the Signal Desk bundle itself, with no human approval, and the bundle goes into the prompt; the episode cites it as `decision.paidIntel {txId, provider, verified}` and its tx id is in `receipts`. The decision waits at most `X402_AUTOPAY_WAIT_MS` (default 8000) for the purchase. Nothing is paid while safe-stop is engaged or 0G is unreachable, for non-shock headlines, for voice turns (Claude answers or 0G trade turns), for simulation runs (`/sim/run`, paper only) or without Hedera keys. A failed or refused payment never blocks the decision. Full flow: [hedera.md](hedera.md#2-one-decision-step-by-step).

### GET /hedera/audit

`?limit=20` (1–100). Reads the HCS audit topic back from the mirror node, newest first, and decodes each message. **200** `{"topicId","topicUrl","count","messages":[{"sequenceNumber","consensusTimestamp","message":{"v":1,"kind":"payment"|"decision"|"trade","ts","txId"?,"asset"?,"amount"?,"payTo"?,"requestId"?,"signal"?,"verified"?}}]}`; a message that is not v1 JSON comes back as `{"raw": "…"}`. `503 not_configured` without the topic; `502 mirror_unavailable`.

### POST /sim/pay-signal

Device token. Body `{"headline"?: string}`, default the newest headline the pod has seen. The agent buys the Signal Desk bundle for it (x402, no human approval). **200** = `lastPayment` (with `trigger: "sim"`) plus `bundle`.

| Status | When | Body |
|---|---|---|
| 409 | Refused before signing: daily or per-call cap, host not allowlisted, payTo equals the payer, 2 payments already in flight; or no headline yet | `{"error":"payment_refused" \| "no_headline","message":"..."}` |
| 502 | Did not settle (402 after retry, facilitator down, verify/settle failure) | `{"error":"payment_failed","message":"...","status":402,"reason":"..."}` |
| 503 | Live mode without the Hedera agent keys | `{"error":"not_configured","provider":"hedera-payer","missingEnv":[...]}` |

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

Without `HL_AGENT_PRIVATE_KEY` + `HL_MASTER_ADDRESS`, `perpMode` is `not_configured` in live mode (markets still come from the keyless info API) and `fake` in test mode; `spotMode` likewise without `UNISWAP_API_KEY` + `EVM_PRIVATE_KEY`. `spotLeg` is the configured demo pair when `UNISWAP_SPOT_LEG=true`. **502** `{"error":"venue_unavailable"}` when the Hyperliquid info API fails. Asset ids above are illustrative.

---

## Terminal: providers and market data

### GET /providers/status

Real probes, run in parallel with a 5 s budget each and cached 30 s. Details never contain keys. Same data as `npm run doctor`.

```json
{
  "checkedAt": "2026-11-06T08:23:40.030Z",
  "mode": "live",
  "providers": [
    { "id": "x402-facilitator", "label": "x402 facilitator", "track": "hedera", "state": "live",
      "detail": "hedera:testnet supported (11 kinds)", "missingEnv": [], "lastOkAt": "2026-11-06T08:23:40.030Z", "latencyMs": 1812 },
    { "id": "hyperliquid", "label": "Hyperliquid perps (execution)", "track": "hyperliquid", "state": "not_configured",
      "detail": "testnet info API reachable; orders answer 503 not_configured", "missingEnv": ["HL_MASTER_ADDRESS", "HL_AGENT_PRIVATE_KEY"],
      "latencyMs": 2397, "nextAction": "Approve an API wallet at https://app.hyperliquid-testnet.xyz/API, then set HL_MASTER_ADDRESS + HL_AGENT_PRIVATE_KEY" }
  ]
}
```

`state`: `live` (works), `degraded` (works with a problem, e.g. the `xyz` dex margin is 0 or the wallet has no gas), `offline` (key rejected or endpoint unreachable), `not_configured` (keys missing; `missingEnv` lists them). `track`: `0g`, `hedera`, `uniswap`, `hyperliquid`, `data`, `audio`.

| id | track | Probe |
|---|---|---|
| `0g-router` | 0g | `GET <OG_ROUTER_URL>/models` (no auth) + whether `OG_API_KEY` is set and `OG_MODEL` is listed |
| `0g-storage` | 0g | 0G balance of the `OG_PRIVATE_KEY` address via `OG_RPC_URL` (`eth_getBalance`) |
| `hedera-payer` | hedera | Mirror node `GET /api/v1/accounts/{HEDERA_ACCOUNT_ID}` balance |
| `hedera-merchant` | hedera | Mirror node account for `X402_PAY_TO` (must differ from the payer) |
| `x402-facilitator` | hedera | `GET <X402_FACILITATOR_URL>/supported` lists `hedera:<network>` |
| `hcs-audit` | hedera | Topic from `HEDERA_HCS_TOPIC_ID` or `.ghosty/hcs.json`, checked on the mirror node |
| `hyperliquid` | hyperliquid | `userAbstraction` for `HL_MASTER_ADDRESS`. Unified account (`"unifiedAccount"`): `spotClearinghouseState` USDC is the collateral shared by the main dex and every `HL_DEXES` dex (`detail` like `unified account: 9.70 USDC shared across main + xyz`), degraded below $2 (margin for a $10 leg at 5x). Otherwise `clearinghouseState` on the main dex and each `HL_DEXES` dex (USDC margin per dex, degraded when `xyz` is 0). Both + `extraAgents` contains the agent address |
| `uniswap` | uniswap | `UNISWAP_API_KEY` present + native balance of the EVM wallet on `EVM_CHAIN_ID` |
| `rss` | data | Each feed fetched; `n/m feeds reachable` |
| `polymarket` | data | Gamma `/events` reachable (offline on many Indian ISPs; the hint says so) |
| `cryptopanic`, `ethos`, `xai` | data | One authenticated read each |
| `groq`, `elevenlabs`, `openai-tts` | audio | `GET models` / `GET /v1/user` (falls back to `/v1/voices` for restricted keys) |

### GET /market/snapshot

Hyperliquid info API, no keys. Prices come from `MARKET_DATA_NETWORK` (default `mainnet`, read-only); orders follow `HL_TESTNET`. Both are labelled. Watchlist: `MARKET_WATCHLIST` (default `BTC,ETH,SOL,xyz:GOLD,xyz:CL,xyz:TSLA,xyz:NVDA,xyz:SP500`; the S&P 500 perp on trade.xyz is `xyz:SP500`). Coins that do not exist (or are delisted) on the network are listed in `missing`, never invented; e.g. `xyz:SPX` would show up there.

```json
{
  "network": "mainnet",
  "executionNetwork": "testnet",
  "ts": "2026-11-06T08:23:47.895Z",
  "source": "ws",
  "assets": [
    { "coin": "BTC", "dex": "", "label": "Bitcoin", "mid": 75680.5, "prevDayPx": 80567, "change24hPct": -6.07,
      "funding": 0.0000125, "openInterest": 41538.6, "openInterestUsd": 3143700000, "volume24h": 4958598322 },
    { "coin": "xyz:GOLD", "dex": "xyz", "label": "Gold", "mid": 4068.65, "prevDayPx": 4123.6, "change24hPct": -1.33,
      "funding": 0.00000625, "openInterest": 74861.43, "openInterestUsd": 304586000, "volume24h": 117141360 }
  ],
  "missing": ["xyz:SPX"]
}
```

`mid` comes from the `allMids` websocket (one subscription per dex, reconnect with backoff; `allMids` polled every 2 s while the socket is down). `prevDayPx`, `funding` (hourly rate), `openInterest` (coin units) and `volume24h` (`dayNtlVlm`, USD) come from `metaAndAssetCtxs`, refreshed every 30 s. `change24hPct = (mid − prevDayPx) / prevDayPx × 100`. `source` is `ws`, `poll`, or `rest` (fetched on demand before the stream starts). **502** `{"error":"market_unavailable"}` when the info API fails.

### GET /market/history

Query: `coin` (required, e.g. `BTC`, `xyz:GOLD`), `interval` (`1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M`, default `1h`), `hours` (default 24, max 2160). From `candleSnapshot`.

```json
{ "network": "mainnet", "coin": "BTC", "interval": "1h",
  "candles": [{ "t": 1793865600000, "o": 80359, "h": 80636, "l": 80346, "c": 80492, "v": 671.36, "n": 7444 }] }
```

`t` is the open time in ms, `v` base-asset volume, `n` trade count. **400** bad query, **404** `{"error":"unknown_coin"}`, **502** `market_unavailable`.

### GET / (terminal)

When `terminal/dist/index.html` exists (or `TERMINAL_DIST` points at a built dist), the server serves it at `/`. API routes keep their paths and win over static files. Other `GET`s that accept `text/html` get `index.html` (client-side routing); anything else keeps the JSON 404. `/sim` still serves the virtual pod.

---

## Signal Desk: GET /intel (x402 on Hedera)

The paid resource lives on the **Signal Desk**, a separate process (`npm run signal-desk`, port `SIGNAL_DESK_PORT`, default 3101) with its own Hedera account (`X402_PAY_TO`). The Ghosty server no longer has a paid route: the old `GET /signal` returned the agent's own last decision, so paying for it was circular. Walkthrough with the full flow, code locations, accounts and live links: [hedera.md](hedera.md). Code: `server/src/payments/signalDesk.ts`, `x402Server.ts` (`registerPaidRoute`), client `x402Client.ts`.

Protocol: x402 **v2** (`@x402/core` / `@x402/fetch` 2.30), scheme `exact`, network `hedera:testnet`. `GET /intel?headline=…&handle=…&domain=…` (`headline` required, else `400` before any 402).

**402** (no or bad payment): `PAYMENT-REQUIRED` header + the same JSON body. The desk offers two options, USDC first:

```json
{
  "x402Version": 2,
  "error": "payment required",
  "resource": { "url": "http://127.0.0.1:3101/intel?headline=…", "description": "Headline intelligence: …", "mimeType": "application/json" },
  "accepts": [
    { "scheme": "exact", "network": "hedera:testnet", "amount": "10000",   "asset": "0.0.429274", "payTo": "0.0.11342424", "maxTimeoutSeconds": 180, "extra": { "feePayer": "0.0.9185802" } },
    { "scheme": "exact", "network": "hedera:testnet", "amount": "1000000", "asset": "0.0.0",      "payTo": "0.0.11342424", "maxTimeoutSeconds": 180, "extra": { "feePayer": "0.0.9185802" } }
  ]
}
```

Prices: `X402_INTEL_PRICE_USDC_MICROS` (default `10000` = 0.01 USDC, 6 decimals) and `X402_INTEL_PRICE_TINYBAR` (default `1000000` = 0.01 HBAR). The merchant must be associated with the USDC token (`npm run hedera:setup` does it).

**200** after facilitator verify → bundle built → facilitator settle: headers `PAYMENT-RESPONSE`, `X-PAYMENT-RESPONSE`, `x-payment-tx-id`; body:

```json
{
  "provider": "ghosty-signal-desk", "requestId": "desk-…", "generatedAt": "…",
  "headline": "Missile strikes reported near Strait of Hormuz",
  "source": { "handle": "reuters", "domain": null, "ethos": { "score": 1427, "level": "neutral" } },
  "corroboration": { "count": 2, "sources": ["bloomberg.com", "ft.com"], "windowMinutes": 120, "examples": [ … ] },
  "shock": { "category": "geopolitical_shock", "keywords": ["missile", "strikes"], "severity": "medium" },
  "paidTxId": "0.0.9185802@…", "hashscanUrl": "https://hashscan.io/testnet/transaction/…"
}
```

Other errors: `503 payments_not_configured` (no `X402_PAY_TO`), `503 facilitator_unavailable`. `GET /health` on the desk is free and lists `payTo`, facilitator and prices.

---

## Simulation runs

Replay a real past event on a compressed clock: real headlines, real historical prices, a **real** decider call
per shock headline (0G Compute in live mode; safe-stop applies), paper execution only. Background, scenario format
and sources: [simulation.md](simulation.md).

### GET /sim/scenarios

`{"scenarios": [{id, title, description, category, start, end, interval, markets: [{coin, source, symbol, proxy?}], headlines: [{ts, title, source, url, handle?, tsNote?}], sources: []}]}`

### POST /sim/run

Body `{"scenarioId": string, "speed"?: number, "autoPauseOnAlert"?: boolean}`. `speed` = market seconds per real
second (default 360: one market hour per 10 s). `autoPauseOnAlert` (default true) stops the clock while an alert
waits for a press. Loads the candles (cached in `server/.ghosty/candles/`), starts the clock, replaces any earlier
run. **200** `{"runId": "sim-1a2b3c4d"}`. **400** bad body, **401** device token, **404** `unknown_scenario`,
**502** `candles_failed` (price source unreachable).

### POST /sim/control

Body `{"action": "pause" | "resume" | "stop"}`. **200** `{"ok": true, ...status}` (the `GET /sim/run` shape, so
`status` is the run status). `stop` ends the run and clears any pending sim decision. **409** `no_run` before the
first run.

### GET /sim/run

```json
{
  "sim": true,
  "runId": "sim-b908cfd6",
  "scenarioId": "sec-sues-binance-2023",
  "status": "paused",
  "pauseReason": "awaiting_press",
  "simTime": "2023-06-05T15:00:00.000Z",
  "start": "2023-06-05T12:00:00Z",
  "end": "2023-06-06T20:00:00Z",
  "progress": 0.094,
  "speed": 1800,
  "autoPauseOnAlert": true,
  "notionalUsd": 25,
  "pnlUsd": -0.5897,
  "pnlPct": -2.3588,
  "realizedPnlUsd": 0,
  "unrealizedPnlUsd": -0.5897,
  "baselinePnlUsd": 0.2924,
  "baselinePct": 1.1696,
  "baseline": "hold: $25 equal-weight long across the scenario markets from the run start",
  "positions": [{ "coin": "BTC", "size": -0.00085265, "entryPx": 26388.45, "markPx": 27080.12, "unrealizedPnlUsd": -0.5897, "realizedPnlUsd": 0 }],
  "fills": [{ "orderId": "paper-1", "coin": "BTC", "isBuy": false, "sizeUsd": 12.5, "size": 0.00046661, "px": 26788.81, "mid": 26802.21, "simTime": "2023-06-05T15:00:00.000Z" }],
  "mids": { "BTC": 26802.21, "ETH": 1846.1 },
  "decisions": 1,
  "decisionList": [{ "sim": true, "runId": "sim-b908cfd6", "simTime": "...", "headline": "SEC Files 13 Charges ...", "requestId": "8ed99de9-…", "signal": "regulatory_crackdown", "confidence": 0.72, "rationale": "...", "actions": [], "zeroG": {} }],
  "episodes": 1,
  "episodeList": [{ "seq": 1, "ts": "...", "runId": "sim-b908cfd6", "requestId": "8ed99de9-…", "outcome": "proposed", "storage": "local", "rootHash": "local:945a…", "prevRoot": null }],
  "lastRootHash": "local:945a…",
  "pending": { "requestId": "8ed99de9-…", "signal": "regulatory_crackdown", "actions": [], "headline": "SEC Files 13 Charges ..." },
  "headlines": { "total": 2, "delivered": 1 },
  "memory": "default snapshot: 0G memory not configured (OG_PRIVATE_KEY unset); watchlist = scenario markets",
  "storage": "local",
  "error": null
}
```

`status` is `idle` (no run yet; ids null, numbers 0) | `running` | `paused` | `done`. `notionalUsd` is
`MAX_TRADE_USD`, the base for `pnlPct` and `baselinePct`. `decisions` / `episodes` are counts; the lists hold the
details. A decision entry with `skipped` (`no_shock`, `brain_offline`, `error`) had no trade; `brain_offline` is the
safe-stop and never becomes a fake decision. `lastRootHash` is this run's newest episode root (replay start).

### GET /episodes

Query `runId?`, `limit?` (1–500, default 50). `{"runId", "storage": "local" | "0g", "episodes": [...]}`, oldest
first. Sim entries: `{seq, ts, runId, scenarioId, requestId, outcome, storage, rootHash, prevRoot, txHash?,
storageError?, sim: true, simTime, headline, signal, storagescan}`. Without `runId` the live 0G episode index
(`episodes.jsonl`) is merged in (`sim: false`).

### GET /episodes/replay

Query `from=<rootHash>` (a `local:<sha256>` root or a 0G merkle root), `limit?` (1–200, default 20). Reads each
body (local log, or download from 0G Storage when `OG_PRIVATE_KEY` is set), follows `prevRoot`, and returns
`{"from", "episodes": [...], "stoppedAt", "problems": []}` with episodes **oldest → newest**:
`{rootHash, storage, requestId, seq, ts, outcome, sim, runId, prevRoot, storagescan, decision: {signal, confidence,
rationale}, orders: [], episode}`. `stoppedAt` is null when the walk reached the chain start, else the next root
(limit hit, or the root that could not be read; see `problems`). Live batch blobs expand to one entry per episode.

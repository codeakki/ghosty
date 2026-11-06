# Architecture

Ghosty is a wearable ESP32 voice pod that hosts a private, user-owned trading copilot. The pod is a thin client: it records audio, plays audio and reads one button. Everything else (speech, news, reasoning, memory, payments, execution) runs on a Node + TypeScript server that talks to 0G, Hedera, Hyperliquid and Uniswap.

## System diagram

```
[ESP32-CAM pod] --WAV over HTTP POST--> [server: Fastify/Express TS]
   button GPIO2                         ├─ STT (Groq whisper; 0G Whisper if router exposes audio)
   INMP441 mic  GPIO14/15/13             ├─ news ingest: RSS (CoinDesk/Cointelegraph/TheBlock/Decrypt),
   MAX98357A amp GPIO14/15/12            │    CryptoPanic, Polymarket Gamma, Grok x_search (optional)
   speaker, LiPo→TP4056→5V boost         ├─ credibility: Ethos score per handle/address (optional)
                                         ├─ decision loop: 0G Compute chat completion (request ID logged)
<--raw PCM s16le 16k over HTTP--         ├─ memory: encrypted (AES-256) blobs on 0G Storage; episode log per decision
                                         ├─ payments: x402 client on Hedera testnet pays /signal per call
                                         ├─ execution: Hyperliquid API wallet (@nktkas/hyperliquid) opens perp
                                         │    (xyz:GOLD / xyz:WTI long, BTC short) — main venue
                                         ├─ spot leg: viem + Uniswap Trading API (Arbitrum/Base) swap → USDC
                                         │    before funding, or USDC → PAXG safe-haven (Uniswap track)
                                         └─ safe-stop: if 0G unreachable → speak "brain offline", block trade
```

## Components

| Component | Where | Tech | Job | Server module |
|---|---|---|---|---|
| Device | ESP32-CAM (AI Thinker) | Arduino core 3.3.x, `ESP_I2S` full duplex, `HTTPClient` | Push-to-talk record (16 kHz, 16-bit mono), play PCM, read button | `firmware/sketches/06_CloudVoice` |
| Server | Laptop / small VM | Node 22, TypeScript, Fastify/Express | HTTP API (`/health`, `/voice`, `/button`, later `/signal`), orchestration | `server/src/index.ts` |
| STT | Cloud | Groq `whisper-large-v3-turbo`; 0G Whisper Large v3 if the Router exposes audio (UNVERIFIED) | WAV → text | `server/src/audio/stt.ts` |
| TTS | Cloud | ElevenLabs `eleven_flash_v2_5`, `output_format=pcm_16000` | Text → raw s16le 16 kHz PCM, no resampling | `server/src/audio/tts.ts` |
| News ingest | Server | RSS, CryptoPanic, Polymarket Gamma, Grok `x_search` (optional) | Pull headlines and market odds, normalise into events | `server/src/news/*` |
| Credibility | Server | Ethos API v2 (optional) | Weight a source by Ethos score of its X handle or wallet | `server/src/credibility/ethos.ts` |
| Decision loop | 0G Compute | 0G Router (OpenAI-compatible) or direct broker SDK | Event + memory → decision (`alert`, `trade`, `ignore`) with a request ID | `server/src/agent/decide.ts` |
| Memory + episode log | 0G Storage | `@0gfoundation/0g-storage-ts-sdk`, AES-256 built-in encryption | User prefs and history (encrypted); one episode record per decision with request ID and root hash | `server/src/agent/{memory,episode}.ts` |
| Payments | Hedera testnet | x402 (`@x402/fetch`, `@x402/hedera`, `@x402/express`) | Agent wallet pays per `/signal` call, no human approval | `server/src/payments/x402.ts` |
| Execution | Hyperliquid | `@nktkas/hyperliquid`, API (agent) wallet | Open perps: HIP-3 `xyz:` markets (gold, oil, stocks) and BTC | `server/src/execution/hyperliquid.ts` |
| Playbook | Server | Plain TS map | Signal type → action (e.g. war/geopolitical → long GOLD/WTI + short BTC) | `server/src/execution/playbook.ts` |
| Spot leg | Arbitrum / Base | viem + Uniswap Trading API | Wallet tokens → USDC before funding perps, or USDC → PAXG safe haven | `server/src/wallet/uniswap.ts` |
| Safe-stop | Server | Guard around the decision loop | If 0G is unreachable: speak "brain offline", block every trade | `server/src/safety/safeStop.ts` |

## 0G decides, Claude researches and talks

Trading decisions stay on 0G Compute: every proposed trade comes from the 0G decider, and if 0G is unreachable the pod safe-stops instead of asking anyone else. Claude (Anthropic API, `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`) does two supporting jobs. It answers questions and chit-chat on `/voice` and `/voice/text` ("what's moving gold?", "are you online?") from the live market snapshot, recent headlines with credibility, the last 0G decision and the pending alert, and the reply is marked `answeredBy: "claude"`; utterances that ask for a trade or react to an alert go to the 0G path (`answeredBy: "0g"`), and "yes"/"confirm" by voice only points at the button. It also runs a news scout (`server/src/claude/scout.ts`): every `CLAUDE_SCOUT_MINUTES` one Messages API call with the server-side `web_search` tool returns up to 6 headlines from the last 2 hours as JSON, validated with zod and fed into the aggregator, where dedupe, the rolling window and the shock detector treat them like any other source and 0G decides on them. Claude is never a fallback decider: when it fails the pod says it couldn't reach its research assistant, and when 0G fails there is no decision.

## Sequence A: voice query

```
User        Pod (ESP32)            Server                 STT     0G Compute   0G Storage   TTS
 |  hold btn   |                      |                    |          |            |         |
 |------------>| record 16k PCM       |                    |          |            |         |
 |  release    | into PSRAM           |                    |          |            |         |
 |------------>| POST /voice (WAV) -->|                    |          |            |         |
 |             |                      |-- audio ---------->|          |            |         |
 |             |                      |<-- text -----------|          |            |         |
 |             |                      |-- load memory ---------------------------->|         |
 |             |                      |<-- decrypted prefs/history ----------------|         |
 |             |                      |-- chat completion ----------->|            |         |
 |             |                      |<-- answer + request ID -------|            |         |
 |             |                      |-- episode {query, reqId, answer} --------->| (root)  |
 |             |                      |-- answer text ---------------------------------------->|
 |             |                      |<-- PCM s16le 16k ------------------------------------|
 |             |<-- 200 octet-stream -|                    |          |            |         |
 |<-- speaker -| play in 1–2 KB chunks|                    |          |            |         |
```

1. User holds the button (GPIO2), speaks, releases.
2. Pod prepends a 44-byte WAV header and POSTs to `/voice` with `X-Device-Token`.
3. Server transcribes, loads encrypted memory from 0G Storage, calls 0G Compute with transcript + memory + latest events.
4. Server writes an episode record (input, request ID, output) to 0G Storage and keeps the root hash.
5. Server synthesises the answer to raw PCM and streams it back. Pod plays it through the MAX98357A.

If 0G is unreachable, the server answers `503 {"error":"brain_offline"}` with no audio and the pod blinks the red LED 3 times (see safe-stop below).

## Sequence B: news-driven alert → button → trade

```
News sources      Server                  Hedera x402     0G Compute    0G Storage    Pod          Hyperliquid   Uniswap
    |  poll         |                         |               |             |           |               |           |
    |-- headline -->| normalise + Ethos score |               |             |           |               |           |
    |               |-- GET /signal (pays) -->|               |             |           |               |           |
    |               |<-- 402 → pay → 200 -----|               |             |           |               |           |
    |               |-- decide(event, memory) --------------->|             |           |               |           |
    |               |<-- {action: alert, plan, reqId} --------|             |           |               |           |
    |               |-- episode log ------------------------------------->  |           |               |           |
    |               |== pending alert (PCM) ===================================>  speak |               |           |
    |               |                                                       |  "War headline, gold long?"|           |
    |               |<========================= POST /button {action:"confirm"} =======|               |           |
    |               |-- (optional) spot leg: swap → USDC or USDC → PAXG ---------------------------------------->   |
    |               |-- order (API wallet) ------------------------------------------------------>|               |
    |               |<-- fill / order id -------------------------------------------------------- |               |
    |               |-- episode log {fill, tx hashes} ----------------------->|           |               |           |
    |               |== confirmation PCM ======================================> "Done." |               |           |
```

1. Ingest pulls RSS, CryptoPanic, Polymarket and (optionally) Grok `x_search`. Each item gets an Ethos weight where a handle or address is known.
2. The server buys a premium signal from its own x402-paywalled `/signal` endpoint using the agent's Hedera wallet. This is the autonomous payment for the Hedera track.
3. 0G Compute decides. The playbook maps the signal class to a concrete plan (for "war": long `xyz:GOLD` / `xyz:WTI`, short BTC).
4. The episode (event, request ID, plan) is written to 0G Storage before anything is spoken.
5. The pod plays the alert. The pod polls or long-polls for pending alerts; delivery mechanism is a build-time decision.
6. User presses the button. The pod sends `POST /button {"action":"confirm"}` (or `"cancel"`).
7. The server runs the optional Uniswap spot leg, then places the Hyperliquid order from the API wallet.
8. Fill details and tx hashes are appended to the episode log. The pod speaks a confirmation.

No button press, no trade. The agent never trades on its own in the demo build.

## Data flow: private vs public

| Data | Who sees it | Where it lives | Notes |
|---|---|---|---|
| Raw audio | Our server, STT provider | Server memory only (not persisted by default) | The pod streams audio in clear over HTTP on the LAN; use HTTPS for anything off-LAN. |
| Transcripts, answers | Our server, 0G Compute provider, TTS provider | Episode log on 0G Storage (encrypted) | 0G direct SDK path runs in TEE with signed responses; Router path is a normal API. |
| User memory (prefs, risk limits, history) | Our server | 0G Storage, AES-256 encrypted with a server-held key | Wrong key silently returns ciphertext; test decrypt on boot. |
| Episode log | Our server; anyone with the root hash sees ciphertext | 0G Storage | Root hashes and request IDs are shown to judges as evidence. |
| Trades and fills | Our server, Hyperliquid (public order book), Uniswap (public chain) | Hyperliquid, Arbitrum/Base | Trades are public by nature. |
| x402 payments | Public | Hedera testnet (HashScan) | Tx IDs go in the README. |
| Market-event index (stretch) | Public | Arkiv entities | Arkiv has no encryption. Never put trade history or encrypted Swarm refs (refs contain keys) in entities. |
| Keys (agent EVM key, Hedera key, HL API wallet key, AES key) | Server only | `.env` (gitignored) | Never on the device. Device holds only WiFi creds and the device token in `secrets.h`. |

Honest privacy statement: the server sees audio and trades. Ghosty is "user-owned" (own server, own wallet, encrypted memory), not "zero-knowledge". This is why the EF CROPS privacy track is set aside.

## What breaks without 0G

| Without | Effect |
|---|---|
| 0G Compute | No decisions. The agent cannot classify events or answer questions. Safe-stop engages: every trade is blocked, `/voice` and `/button` return `503 brain_offline`, and the pod blinks "brain offline" (3 red blinks). |
| 0G Storage | No memory and no episode log. The agent forgets user limits and history, and there is no auditable record tying each decision to a request ID. Trades are blocked too, because a decision that cannot be logged is not executed. |

## Safe-stop rule

```
if (!zeroG.computeReachable() || !zeroG.storageWritable()) {
  blockAllTrades();     // /voice and /button return 503 {"error":"brain_offline"}, no order is sent
  return;               // never fall back to a local model or a canned decision
}
```

- Checked before every decision and again before every order.
- Slow networks: the reachability probe waits up to `OG_HEALTH_TIMEOUT_MS` (15 s) and flips offline only after 2 consecutive failures (back online after 1 success); a 0G call gets `OG_DECIDE_TIMEOUT_MS` (45 s) and one retry on a timeout or `ECONNRESET` only. A call that still fails throws `brain_offline`.
- Never fake a decision. No local LLM fallback, no cached plan replay.
- `/health` reports `safeStop: true` so the demo can show the state.
- `/voice` and `/button` return `503` with JSON `{"error":"brain_offline"}` and no audio body. The pod plays nothing and blinks the red LED (GPIO33) 3 times fast. See [api.md](api.md).
- Recovery is automatic on the next successful 0G call.

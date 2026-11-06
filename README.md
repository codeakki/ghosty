# Ghosty

Ghosty is a wearable ESP32 voice pod that hosts a private, user-owned trading copilot. It reads the news for you, scores how credible each signal is, speaks an alert through its own speaker, and executes the trade from its own wallet when you press one button. The decision loop runs on 0G Compute, every decision is logged to 0G Storage, the agent pays for its premium signal feed per call with x402 on Hedera, and trades go to Hyperliquid perps (with a Uniswap spot leg). If the 0G brain is unreachable, the pod says so and refuses to trade.

Built at ETHGlobal Mumbai, Nov 6–8 2026.

## Demo

> Demo video and GIF go here before submission.

<!-- TODO: add hardware/photos/demo.gif and uncomment
![Ghosty demo](hardware/photos/demo.gif)
-->

- Video (≤ 3 min): _TODO link_
- HashScan x402 payment: _TODO tx link_
- 0G Storage episode log: _TODO root hash / storagescan link_

## How it works

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

1. The server ingests news and prediction-market moves, then weights each item by source credibility.
2. A 0G Compute call decides whether the signal is actionable and which playbook applies (for example, a geopolitical shock maps to long gold / oil perps and short BTC).
3. The server synthesizes a short spoken alert and streams it to the pod as raw PCM.
4. The user presses the button. The server places the order on **Hyperliquid** (main venue; HIP-3 markets on trade.xyz cover gold, oil, and stock perps 24/7) and runs the spot leg through the **Uniswap** Trading API.
5. The decision, its 0G request ID, and the result are written as an episode to **0G Storage**.

Full detail: [docs/architecture.md](docs/architecture.md).

## Hardware

### Bill of materials

| Part | Qty | Purpose | Status |
|---|---|---|---|
| ESP32-CAM (AI Thinker) | 1 | Main MCU, WiFi, 4 MB PSRAM | Bought |
| ESP32-CAM-MB base board | 1 | USB flashing and serial | Bought |
| INMP441 I2S MEMS mic | 1 | Voice input | Bought |
| MAX98357A I2S amp | 1 | Speaker driver | Bought |
| Mini speaker | 1 | Voice output | Bought |
| 3.7 V 500 mAh LiPo | 1 | Battery | Bought |
| TP4056 charger | 1 | LiPo charging and protection | Bought |
| Push button | 1 | Push-to-talk and trade confirm | Bought |
| 5 V boost converter | 1 | Lift LiPo to 5 V for the board and amp | To buy |
| 470–1000 µF capacitor | 1 | Absorb WiFi and audio current spikes | To buy |
| Vibration motor + 2N2222 + 1 kΩ + 1N4148 | 1 set | Haptic alert (optional) | To buy |
| Slide switch | 1 | Power switch (optional) | To buy |

Full list with notes: [hardware/BOM.md](hardware/BOM.md).

### Wiring

| Module | Module pin | ESP32-CAM pin |
|---|---|---|
| INMP441 | VDD / GND / L/R | 3V3 / GND / GND |
| INMP441 | SCK / WS / SD | GPIO14 / GPIO15 / GPIO13 |
| MAX98357A | VIN / GND | 5V / GND |
| MAX98357A | BCLK / LRC / DIN | GPIO14 / GPIO15 / GPIO12 |
| Speaker | + / − | Amp + / − |
| Button | one leg / other leg | GPIO2 / GND (`INPUT_PULLUP`) |
| LiPo | + / − | TP4056 B+ / B− |
| TP4056 | OUT+ / OUT− | 5 V boost in → boost out to 5V / GND |

Mic and amp share one I2S port in full duplex: BCLK and WS are common, data runs on separate pins, 16 kHz with 32-bit slots.

> **Warning: boot strapping pins**
> - **GPIO12** sets the flash voltage at reset. If it is HIGH at reset the board boot-loops with `flash read err`. Only the amp's DIN (an input) goes here. Never put the mic's SD output on GPIO12.
> - **GPIO2** must be LOW or floating to enter download mode. Wire the button GPIO2 → GND with `INPUT_PULLUP`. Never tie GPIO2 to 3V3.
> - GPIO2, 4, 12, 13, 14, 15 are the SD card pins. **Never call `SD_MMC.begin()`.**

> **Power note:** a LiPo (3.0–4.2 V) on the 5V pin browns out under WiFi plus audio, because the onboard AMS1117 needs about 1.1 V of headroom. Use LiPo → TP4056 → 5 V boost → 5V pin, feed the amp VIN from the boost, and add a 470–1000 µF capacitor across 5V/GND.

Full guide with power and test order: [hardware/wiring.md](hardware/wiring.md).

## Firmware quick start

1. Install **Arduino IDE 2.x**.
2. In *Preferences → Additional boards manager URLs* add:
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
3. *Boards Manager* → install **esp32 by Espressif** (CI uses core 3.3.12).
4. Select board **AI Thinker ESP32-CAM**. On Windows you may need the CH340 USB driver for the MB base board.
5. Link the shared library into your sketchbook:
   ```bash
   ./firmware/scripts/link-lib.sh
   ```
6. Create your secrets file (gitignored):
   ```bash
   cp firmware/libraries/GhostyBoard/src/secrets.h.example firmware/libraries/GhostyBoard/src/secrets.h
   # edit WiFi SSID/password and server URL
   ```
7. Open `firmware/sketches/01_Blink/01_Blink.ino` and upload. Work through the sketches in order.

Flashing: use the ESP32-CAM-MB base board, or pull GPIO0 to GND while resetting.

## Server quick start

Requires Node 22+ and npm.

```bash
cd server
cp .env.example .env   # fill in keys as you need each provider
npm ci
npm run dev
curl localhost:3000/health
```

Every provider ships as a deterministic stub, so the server runs with an empty `.env`. Each real provider switches on when its keys are in `server/.env` (template: [`server/.env.example`](server/.env.example)); the rest stay fake.

| Provider | Keys that enable it | Where to get them | Without them |
|---|---|---|---|
| Speech-to-text (Groq Whisper) | `GROQ_API_KEY` | https://console.groq.com/keys | Fixed fake transcript |
| Text-to-speech (ElevenLabs) | `ELEVENLABS_API_KEY` (optional `ELEVENLABS_VOICE_ID`) | https://elevenlabs.io/app/settings/api-keys | OpenAI TTS if `OPENAI_API_KEY` is set, else a tone |
| Text-to-speech fallback (OpenAI) | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | Tone |
| Live news (RSS + Polymarket) | `NEWS_LIVE=true` (no key) | n/a | Fake headlines with fixed timestamps |
| CryptoPanic | `CRYPTOPANIC_TOKEN` | https://cryptopanic.com/developers/api/ | Fake (or left out when `NEWS_LIVE=true`) |
| Grok x_search (X posts) | `XAI_API_KEY` | https://console.x.ai | Fake (or left out when `NEWS_LIVE=true`) |
| Ethos credibility | `ETHOS_ENABLED=true` (no key) | n/a | Fixed fake scores |
| 0G Compute decider | `OG_API_KEY` (+ `OG_ROUTER_URL`, `OG_MODEL`) | https://pc.0g.ai (mainnet) or https://pc.testnet.0g.ai | Keyword `FakeDecider`; safe-stop probe skipped |
| 0G Storage memory + episode log | `OG_PRIVATE_KEY` (optional `OG_MEMORY_KEY`) | Any EVM key, funded at https://faucet.0g.ai | In-memory store |
| Hedera x402 payer + HCS audit | `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` | https://portal.hedera.com (testnet faucet) | Fake payer, fake tx id |
| Paid `GET /signal` (merchant) | `X402_PAY_TO` (a **second** testnet account) | https://portal.hedera.com | `503 payments_not_configured` |
| Hyperliquid perps | `HL_MASTER_ADDRESS`, `HL_AGENT_PRIVATE_KEY` (+ `HL_TESTNET`, `HL_DEXES`, `HL_FALLBACK_COINS`) | API wallet approved at https://app.hyperliquid-testnet.xyz/API | Fake venue, simulated orders |
| Uniswap spot leg | `UNISWAP_API_KEY`, `EVM_PRIVATE_KEY`, `UNISWAP_SPOT_LEG=true` (+ `EVM_RPC_URL`, `EVM_CHAIN_ID`) | https://developers.uniswap.org/dashboard | Fake swap hash (no spot step unless `UNISWAP_SPOT_LEG=true`) |

Status endpoints show which mode each integration is in: `GET /zerog/status`, `GET /x402/status`, `GET /execution/markets` (see [docs/api.md](docs/api.md#integration-status)). Pre-flight checks: `npm run hl:check` (Hyperliquid markets and margin, read-only) and `npm run x402:demo` (one real paid `/signal`, appended to [docs/evidence.md](docs/evidence.md)).

No pod yet? Open http://localhost:3000/sim for the virtual pod (hold-to-talk, inject headlines, confirm trades, live state), or use `npm run pod -- help`. See [docs/simulator.md](docs/simulator.md).

## Sketch roadmap

| # | Sketch | What it proves | Status |
|---|---|---|---|
| 01 | `01_Blink` | Toolchain and upload work (red LED on GPIO33) | Scaffolded |
| 02 | `02_WiFiTest` | WiFi joins with `secrets.h` | Scaffolded |
| 03 | `03_MicTest` | INMP441 over full-duplex I2S, RMS level meter | Scaffolded |
| 04 | `04_SpeakerTest` | MAX98357A plays a sine tone | Scaffolded |
| 05 | `05_RecordPlayback` | 5 s recorded into PSRAM and played back | Scaffolded |
| 06 | `06_CloudVoice` | Hold button → POST WAV → stream PCM reply | Skeleton |

"Scaffolded" means it compiles in CI but has not yet been verified on the team's hardware.

## API contract

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/health` | — | `{"ok":true,"version":"0.1.0","safeStop":false}`; `safeStop: true` = 0G unreachable, trading blocked |
| `POST` | `/voice` | WAV body (16 kHz, 16-bit, mono) as `audio/wav` or `application/octet-stream`; `X-Device-Token` when `DEVICE_TOKEN` is set | `200 application/octet-stream`: raw PCM s16le, 16 kHz, mono, with headers `x-sample-rate`, `x-request-id`, `x-signal`. `400` bad WAV, `401` bad token, `503 {"error":"brain_offline"}` (no audio) |
| `POST` | `/button` | JSON `{"action":"confirm"\|"cancel"}`, same token header | `200 {action, requestId, signal, executed, actions, orders}`; with nothing pending it decides from current news. `400`, `401`, `503 brain_offline` |

The device streams the PCM reply straight to I2S in 1–2 KB chunks. No MP3 decoding on the device. On `503` (safe-stop) the pod plays nothing and blinks the red LED 3 times. Details: [docs/api.md](docs/api.md).

## Hackathon tracks

| # | Track | How Ghosty qualifies |
|---|---|---|
| 1 | **0G — Physical AI: Agents with a Body** | Real wearable. Every decision is a 0G Compute call with its request ID logged; each decision is written as an episode to 0G Storage; encrypted memory on 0G Storage; safe-stop when 0G is unreachable. |
| 2 | **Hedera — AI Agents That Pay: x402** | The agent's wallet pays our x402-paywalled `/signal` endpoint per call on `hedera:testnet`, with no human approval. Settled tx ID: see the HashScan link under [Demo](#demo). |
| 3 | **Uniswap — Build with Uniswap** | The spot leg of each trade runs through the Uniswap Trading API. Code: [`server/src/wallet/uniswap.ts`](server/src/wallet/uniswap.ts). Feedback: [FEEDBACK.md](FEEDBACK.md). |
| stretch | Arkiv + Swarm bonus, EF Anon-RPC | Public market-event index on Arkiv; chain reads via Anon-RPC. Only if time allows. |

Execution venue: **Hyperliquid** (not a sponsor). HIP-3 perps for gold, oil, and stocks, opened from an approved API wallet.

**What breaks without 0G:** the decision loop and episode log — the device safe-stops and refuses to trade.

Per-track checklists and doc links: [docs/tracks.md](docs/tracks.md).

## Repo layout

```
ghosty/
├─ README.md           this file
├─ PLAN.md             hackathon plan: milestones, task board, demo script, risks
├─ CONTRIBUTING.md     commit, branch, and PR rules
├─ FEEDBACK.md         Uniswap track feedback
├─ hardware/           BOM, wiring guide, photos
├─ firmware/
│  ├─ libraries/GhostyBoard/   shared pins + secrets (local Arduino library)
│  ├─ sketches/01_…06_…        bring-up sketches, in test order
│  └─ scripts/link-lib.sh      symlink the library into ~/Documents/Arduino/libraries
├─ server/             Node + TypeScript service (voice, news, agent, payments, execution)
├─ docs/               architecture, API, setup, troubleshooting, demo script, tracks, research
└─ .github/            CI workflows, issue and PR templates
```

Plan and task board: [PLAN.md](PLAN.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md).

## Team

| Name | Role | Contact |
|---|---|---|
| _TODO_ | Firmware + hardware | _TODO_ |
| _TODO_ | Server + agent | _TODO_ |
| _TODO_ | Onchain integrations | _TODO_ |

## License

[MIT](LICENSE)

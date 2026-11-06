# Ghosty hackathon plan

ETHGlobal Mumbai, Nov 6–8 2026. Repo: `codeakki/ghosty`.

## Goal

Ship a working wearable that hears a market-moving headline, decides with an agent running on 0G, tells the wearer what it wants to do, and executes a real trade on one button press, with every decision logged on 0G Storage and every paid signal settled through x402 on Hedera.

**Product in one line:** Ghosty is a wearable ESP32 voice pod that hosts a private, user-owned trading copilot. It aggregates news, scores signal credibility, speaks an alert through its speaker, and executes a trade with one button press from its own wallet.

## Demo success criteria

The demo counts as done when all of these happen live, on the real pod, in one run:

- [ ] Pod runs on battery (LiPo → TP4056 → 5 V boost), no USB cable.
- [ ] A headline enters the pipeline and the agent scores its credibility.
- [ ] The decision comes from a 0G Compute call, and its request ID is shown.
- [ ] The pod speaks the alert (and vibrates, if the motor is fitted).
- [ ] One button press places a Hyperliquid order and the Uniswap spot leg.
- [ ] The episode (signal, decision, request ID, order result) is written to 0G Storage and its root hash is shown.
- [ ] At least one x402 payment settled on `hedera:testnet` with no human approval, visible on HashScan.
- [ ] Pulling the server's 0G access makes the pod say "brain offline" and refuse to trade.

## Tracks

Full table and doc links: [docs/tracks.md](docs/tracks.md).

### 1. 0G — Physical AI: Agents with a Body ($5,000 + $1k best real hardware)

- [ ] 0G Compute call inside the decision loop, request ID captured per decision
- [ ] Episode log per decision on 0G Storage (signal, prompt hash, decision, request ID, order result)
- [ ] Encrypted (AES-256) memory blobs on 0G Storage
- [ ] Live hardware demo (not a sim)
- [ ] Safe-stop: if 0G is unreachable the pod says "brain offline" and blocks the trade; never fake a decision
- [ ] Not "a chatbot with a body" and not "0G only for logs": the 0G call drives the action
- [ ] README line: "What breaks without 0G"
- [ ] Submission: public repo, README, video < 3 min, live link, contract addresses, team Telegram/X

### 2. Hedera — AI Agents That Pay: x402 ($6,500)

- [ ] x402-paywalled `GET /signal` endpoint settling on `hedera:testnet` via a listed facilitator
- [ ] Agent wallet pays at least once with no human approval
- [ ] README shows the settled tx ID, architecture, and payment flow
- [ ] Video ≤ 5 min with HashScan link
- [ ] Extra credit: spend cap / allowlist, HCS audit topic

### 3. Uniswap — Build with Uniswap ($10,000 across 4 winners)

- [ ] One real spot leg through the Uniswap Trading API (`/check_approval` → `/quote` → `/swap`, signed with viem)
- [ ] Public repo
- [ ] `FEEDBACK.md` filled in
- [ ] Feedback form submitted: https://developers.uniswap.org/hackathon-feedback
- [ ] README points at the exact code (`server/src/wallet/uniswap.ts`)

### Execution venue: Hyperliquid (not a sponsor)

- [ ] Pre-event checklist done (see below)
- [ ] API (agent) wallet approved by the master address
- [ ] Market order on a HIP-3 `xyz` market (gold / oil) plus BTC short, in one signed call

### Stretch

- Arkiv "Build from scratch" + Swarm bonus ($4,000 + $500): public, expiring market-event index on Arkiv; encrypted archive blobs on Swarm. Never put plaintext trade history or Swarm encryption refs in Arkiv entities (they are public). Note the possible three-partner-pick limit.
- EF Best Use of Anon-RPC ($5,000): route the agent's chain reads through Anon-RPC; add the CROPS README section.

## Milestones

| ID | Milestone | Date | Exit condition |
|---|---|---|---|
| M0 | Repo & plan | Thu Nov 5 | Repo public, README/PLAN/CONTRIBUTING in, CI green, issues filed |
| M1 | Hardware bring-up | Fri Nov 6 | Sketches 01–05 pass on the real board; battery power works |
| M2 | Voice loop end-to-end | Fri Nov 6 | Hold button → server STT → TTS reply plays on the pod |
| M3 | Agent + 0G memory | Sat Nov 7 | 0G Compute decision with request ID; episode log and memory on 0G Storage; safe-stop works |
| M4 | Payments + trade | Sat Nov 7 | x402 payment settled on Hedera; Hyperliquid order and Uniswap leg from one button press |
| M5 | Demo, video, submission | Sun Nov 8 | Demo script rehearsed, video uploaded, all track forms submitted |

## Task board

Mirrors the GitHub issues. Labels in brackets.

### M0 — Repo & plan (Nov 5)

- [ ] Repo scaffold, README, PLAN, CONTRIBUTING, templates [docs, ci]
- [ ] Firmware compile workflow green [ci, fw]
- [ ] Server lint/typecheck workflow green [ci, server]
- [ ] Hyperliquid pre-event checklist: mainnet deposit, testnet faucet, verify `xyz` markets [venue:hyperliquid, P0]

### M1 — Hardware bring-up (Nov 6)

- [ ] `01_Blink`: red LED on GPIO33 blinks [fw, hw, P0]
- [ ] `02_WiFiTest`: joins WiFi from `secrets.h`, prints IP and RSSI [fw, P0]
- [ ] `03_MicTest`: RMS meter responds to voice [fw, hw, P0]
- [ ] `04_SpeakerTest`: clean sine tone from MAX98357A [fw, hw, P0]
- [ ] `05_RecordPlayback`: 5 s recorded into PSRAM and played back [fw, P0]
- [ ] 5 V boost power test: runs on LiPo through WiFi + audio without brownout [hw, P0]

### M2 — Voice loop end-to-end (Nov 6)

- [ ] `06_CloudVoice`: hold button → POST WAV → stream PCM reply [fw, server, P0]
- [x] Server STT via Groq whisper [server, P0]
- [x] TTS → raw PCM s16le 16 kHz stream [server, P0]
- [x] RSS + CryptoPanic ingest [server, P1]
- [x] Polymarket Gamma signal [server, P1]
- [x] Ethos credibility weight per handle / address [server, P1]
- [x] Grok x_search provider (optional) [server, P1]
- [x] Virtual pod simulator (UI + CLI): `/sim` page, `npm run pod`, pod state + SSE, headline inject, alert queue [server, P1]

### M3 — Agent + 0G memory (Nov 7)

- [x] 0G Compute decision call, request ID captured [server, track:0g, P0]
- [x] 0G Storage encrypted memory [server, track:0g, P0]
- [x] Episode log per decision on 0G Storage [server, track:0g, P0]
- [ ] Safe-stop: 0G unreachable → "brain offline", trade blocked [server, fw, track:0g, P0] (server done: probe + `BrainOfflineError` → 503; firmware still has to speak it)
- [x] Signal → action playbook (war/geopolitical → long GOLD/WTI + short BTC, etc.) [server, P0]

### M4 — Payments + trade (Nov 7)

- [x] x402 server endpoint `/signal` on Hedera testnet [server, track:hedera, P0]
- [ ] x402 client autonomous payment, tx ID in README [server, track:hedera, P0] (client done; needs a settled tx, see Live verification)
- [x] HCS audit topic (extra credit) [server, track:hedera, P1]
- [ ] Hyperliquid API-wallet approval + market order [server, venue:hyperliquid, P0] (venue code done; approval + live order pending)
- [x] viem wallet + Uniswap Trading API spot leg [server, track:uniswap, P0]
- [ ] One-button trade from the device [fw, server, P0]

### Integration (Nov 7)

Ticked items above are merged and tested offline with fakes; real keys are checked in the next list.

- [x] Merge the track branches (#34 virtual pod, #38 audio/news, #36 0G, #35 Hedera x402, #37 execution) into one integration PR [server]
- [x] Wire integrations: `createAgent` (0G decider/memory/episodes), STT/TTS factories, news aggregator + poller (`NEWS_LIVE=true`), `registerPaidRoutes` with the latest decision, `createPerpVenue` + `executePlan(planSteps…)`, `BrainOfflineError`/`MemoryUnavailableError` → 503, `agent.flush()` on shutdown [server, P0]
- [x] Status endpoints for the dashboard: `GET /zerog/status`, `GET /x402/status`, `GET /execution/markets`, `POST /sim/pay-signal` [server, P1]

### Real-mode server (Nov 7)

- [x] `GHOSTY_MODE=live` by default: no fakes outside `npm test`; missing keys answer `503 not_configured {provider, missingEnv}`; no `OG_API_KEY` = safe-stop [server, P0]
- [x] Live news on by default (RSS + Polymarket + Ethos weights); injected headlines labelled `manual` [server, P0]
- [x] `GET /providers/status` with real probes per track (cached 30 s, 5 s timeouts) + SSE `providers` [server, P0]
- [x] Live market data from the keyless Hyperliquid info API: `GET /market/snapshot`, `GET /market/history`, SSE `market` (websocket `allMids`, poll fallback) [server, P0]
- [x] 0G decider legs fitted to the Hyperliquid $10 minimum like the playbook, never above `MAX_TRADE_USD` [server, venue:hyperliquid, P0]
- [x] Serve the terminal build at `/` (SPA fallback), CORS for the Vite dev server [server, P1]
- [x] `npm run doctor` and `npm run start:live` [server, P1]
- [ ] Keys in `server/.env` until `npm run doctor` shows every P0 provider `live` [server, P0]

### Live verification with keys

Each item needs real keys in `server/.env`; run `npm run doctor` first and record the proof in [docs/evidence.md](docs/evidence.md).

- [ ] Groq STT and ElevenLabs TTS on a real `/voice` round trip (check whether `pcm_16000` needs a paid ElevenLabs tier) [server, P0]
- [ ] Live news (default in live mode): poller pulls RSS/Polymarket (Polymarket needs a VPN on Indian ISPs), a shock headline queues an alert [server, P1] (RSS + Polymarket + Ethos verified without keys on 2026-11-06; the alert needs `OG_API_KEY`)
- [ ] 0G Compute decision with a real request id (try the testnet router; fall back to `https://router-api.0g.ai/v1` if TLS fails) [server, track:0g, P0]
- [ ] 0G Storage upload of memory and an episode, root hash opened on storagescan-galileo [server, track:0g, P0]
- [ ] Safe-stop live: kill 0G access, `/voice` answers 503 `brain_offline` [server, track:0g, P0]
- [ ] `npm run x402:demo` settles one payment on hedera:testnet with two funded accounts (payer ≠ `X402_PAY_TO`), HCS topic created [server, track:hedera, P0]
- [ ] `npm run hl:check`, move USDC into the `xyz` dex margin, one confirmed order on `xyz:GOLD` (oil is `xyz:CL`) [server, venue:hyperliquid, P0]
- [ ] Uniswap spot leg on Base Sepolia (`UNISWAP_SPOT_LEG=true`), tx on the explorer [server, track:uniswap, P0]

### M5 — Demo, video, submission (Nov 8)

- [ ] `FEEDBACK.md` filled in and Uniswap form submitted [docs, track:uniswap, P0]
- [ ] Demo video (< 3 min for 0G, ≤ 5 min for Hedera) with HashScan link [docs, P0]
- [ ] Submission checklist: repo public, README links, tx IDs, root hashes, team contacts [docs, P0]
- [ ] Shell / enclosure and photos in `hardware/photos/` [hw, P1]

## Demo script (90 seconds)

| Time | What happens | What the judge sees |
|---|---|---|
| 0:00 | Presenter shows the pod on battery, no cable. | The device, the server log on screen. |
| 0:10 | A war headline arrives (live feed or injected test item). | Headline appears in the log. |
| 0:20 | The agent scores credibility (source weight, Ethos score, Polymarket move) and calls 0G Compute. | Credibility score and 0G request ID in the log. |
| 0:35 | The pod vibrates and speaks: "Geopolitical shock detected, suggest long gold perp and short BTC, press to confirm." | Audio from the pod. |
| 0:45 | Presenter presses the button. | Click. |
| 0:50 | Server opens the Hyperliquid order (long `xyz:GOLD`, short BTC) and runs the Uniswap spot leg. | Order IDs and the Uniswap tx hash. |
| 1:05 | The episode is written to 0G Storage. | Root hash, opened on storagescan. |
| 1:15 | The x402 payment for the `/signal` call is shown. | HashScan transaction page. |
| 1:25 | Optional: kill 0G access, press again, the pod says "brain offline" and does nothing. | Safe-stop in action. |

Longer version with fallbacks: [docs/demo-script.md](docs/demo-script.md).

## Risk register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Brownout when WiFi + amp draw current on LiPo | Pod resets mid-demo | High | TP4056 → 5 V boost → 5V pin; amp VIN from boost; 470–1000 µF cap across 5V/GND |
| GPIO12 HIGH at reset → `flash read err` boot loop | Board will not boot | Medium | Only amp DIN on GPIO12; never mic SD; button on GPIO2 → GND only; last resort `espefuse set-flash-voltage 3.3V` (irreversible) |
| 0G faucet gives 0.1 0G/day but direct Compute needs a 3 0G ledger deposit | No 0G inference | High | Use the 0G Router (OpenAI-compatible) with an API key; ask the 0G booth / Discord for test tokens on day 1 |
| Hyperliquid testnet faucet requires a prior mainnet deposit | No testnet funds | High | Deposit a small amount on mainnet from the master address before the event |
| Stock / gold HIP-3 perps may be mainnet-only | Cannot show gold trade on testnet | Medium | Check `perpDexs` + `meta(dex:"xyz")` on testnet; fall back to mainnet with minimum size |
| Uniswap testnet liquidity is thin | Swap reverts or quotes fail | Medium | Pre-test the exact pair on Base Sepolia; keep a mainnet small-size fallback |
| Swarm gateway uploads need a postage stamp | Stretch track blocked | Medium | Stretch only; ask booth for a stamp or encrypt client-side and skip Swarm |
| Venue WiFi blocks or is flaky | Pod cannot reach server | Medium | Phone hotspot; server on the same laptop; LAN IP in `secrets.h` |

## Why Hyperliquid, not tokenized stocks on Uniswap

Tokenized stocks (Backed xStocks such as TSLAx) do exist on Ethereum mainnet, but their Uniswap pools are thin (around $240k), they are spot only so you cannot short, their terms exclude US persons, and there is no testnet. A "war" signal needs a short on BTC and a long on gold or oil right now, which is a perp trade. Hyperliquid's HIP-3 markets on trade.xyz (`dex:"xyz"`) list gold, silver, oil, and stock perps 24/7 through the same API as crypto perps, so one signed call from an approved API wallet covers the whole playbook. Uniswap keeps a real job: the spot leg (wallet tokens → USDC before funding the perp account, or USDC → PAXG as a safe-haven).

## Pre-event checklist

### Funds and faucets

- [ ] Hyperliquid: deposit a small amount on **mainnet** from the master address
- [ ] Hyperliquid: claim 1,000 mock USDC at https://app.hyperliquid-testnet.xyz/drip
- [ ] Hyperliquid: run `perpDexs` and `meta(dex:"xyz")` on testnet to confirm gold / stock markets
- [ ] 0G: claim from https://faucet.0g.ai (0.1 0G/day per wallet; ask booth for more)
- [ ] Hedera: create testnet account at https://portal.hedera.com and fund from https://portal.hedera.com/faucet
- [ ] Uniswap: fund the agent wallet on Base Sepolia (or chosen chain) and pre-test the pair

### API keys (into `server/.env`, never committed)

- [ ] 0G Router API key (https://pc.0g.ai or the testnet portal)
- [ ] 0G Storage signer private key
- [ ] Hedera testnet account ID + private key
- [ ] Hyperliquid master address + API (agent) wallet key
- [ ] Uniswap Trading API key (https://developers.uniswap.org/dashboard/welcome)
- [ ] Agent EVM private key for viem
- [ ] Groq API key (STT)
- [ ] ElevenLabs API key (TTS)
- [ ] CryptoPanic token
- [ ] Ethos client name (no key needed)
- [ ] xAI API key (optional, Grok x_search)

### Hardware

- [ ] Buy 5 V boost converter and 470–1000 µF capacitor
- [ ] Optional: vibration motor + 2N2222 + 1 kΩ + 1N4148, slide switch, multimeter, hot glue
- [ ] Charge the LiPo
- [ ] Pack the soldering iron, solder, flux, breadboard, micro-USB cable

# ghosty-server

The brain behind the Ghosty pod. The device posts a push-to-talk WAV, the server transcribes it, reads the news,
weighs source credibility, decides on 0G Compute, and answers with raw PCM the pod plays through its speaker.
A button press confirms or cancels the suggested trade.

Every provider is a deterministic fake today, so `npm run dev` works on day one with no keys.
Real integrations are tracked as GitHub issues and marked `TODO(<area>)` in the code.

## Run

Needs Node 22 or newer and npm (not pnpm: a stray `~/package.json` breaks Corepack on the dev Mac).

```sh
cd server
cp .env.example .env      # optional, every key has a default or a fake
npm install
npm run dev               # tsx watch, http://localhost:3000
```

| Script | What it does |
|---|---|
| `npm run dev` | Start with reload (`tsx watch src/index.ts`) |
| `npm run build` / `npm start` | Compile to `dist/` and run it with plain Node |
| `npm run lint` | ESLint flat config with typescript-eslint recommended |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | `node --test` with tsx: playbook, HIP-3 asset id, WAV parser, HTTP routes, virtual pod |
| `npm run pod -- <cmd>` | Virtual pod CLI against a running server (see below) |

Smoke test:

```sh
python3 -c "import wave; w=wave.open('/tmp/x.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\0\0'*16000); w.close()"
curl -s localhost:3000/health
curl -s -X POST -H 'Content-Type: audio/wav' --data-binary @/tmp/x.wav localhost:3000/voice -o /tmp/out.pcm && wc -c /tmp/out.pcm   # 16000
curl -s -X POST -H 'Content-Type: application/json' -d '{"action":"confirm"}' localhost:3000/button
```

Play the reply on a laptop: `ffplay -f s16le -ar 16000 -ac 1 /tmp/out.pcm` (or `sox -t raw -r 16000 -e signed -b 16 -c 1 /tmp/out.pcm -d`).

## Virtual pod (no hardware)

Open **http://localhost:3000/sim** while `npm run dev` runs. The page is the pod: hold to talk (browser mic → 16 kHz
WAV → `/voice` → PCM played back), Confirm / Cancel (`/button`), inject a headline, watch news with credibility,
the decision, planned actions, orders, the episode log and alerts update live over `GET /events`, and flip
safe-stop. The mic needs `localhost` or HTTPS; elsewhere use the **Say** box. If `DEVICE_TOKEN` is set, paste it
into the token field.

The same from a terminal (reads `SERVER_URL`, default `http://localhost:3000`, and `DEVICE_TOKEN` from the env or `.env`):

```sh
npm run pod -- inject "War breaks out: missile strikes hit Gulf oil terminals" --source Reuters
npm run pod -- next                  # pop the queued alert (204 when empty)
npm run pod -- press confirm         # executes the injected decision
npm run pod -- say "is anything moving gold?"   # text turn via /voice/text, PCM saved to /tmp
npm run pod -- wav /tmp/x.wav        # post a WAV like the pod, print x-* headers, save PCM
npm run pod -- safe-stop on          # /voice and /button now answer 503 brain_offline
npm run -s pod -- state | jq .lastDecision
npm run pod -- watch                 # tail the event stream
```

Walkthrough and limits: [docs/simulator.md](../docs/simulator.md). Sim routes: [docs/api.md](../docs/api.md#virtual-pod-sim-only).

## Environment

See [`.env.example`](.env.example) for every variable with a comment. All keys are optional; the config parser
([`src/config.ts`](src/config.ts)) never throws, and malformed numbers fall back to defaults.

| Variable | Default | Used by |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | HTTP server |
| `DEVICE_TOKEN` | unset (check skipped) | `X-Device-Token` on `/voice` and `/button` |
| `GROQ_API_KEY`, `ELEVENLABS_API_KEY` | unset | `audio/` |
| `OG_ROUTER_URL`, `OG_API_KEY`, `OG_PRIVATE_KEY`, `OG_INDEXER_URL` | testnet URLs | `agent/`, `safety/` |
| `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, `X402_FACILITATOR_URL` | x402.org facilitator | `payments/` |
| `HL_MASTER_ADDRESS`, `HL_AGENT_PRIVATE_KEY`, `HL_TESTNET` | `HL_TESTNET=true` | `execution/` |
| `UNISWAP_API_KEY`, `EVM_PRIVATE_KEY`, `EVM_ADDRESS`, `EVM_RPC_URL` | unset | `wallet/` |
| `CRYPTOPANIC_TOKEN`, `ETHOS_CLIENT`, `XAI_API_KEY` | `ETHOS_CLIENT=ghosty@0.1.0` | `news/`, `credibility/` |
| `SAFE_STOP_ENABLED`, `SIMULATE_BRAIN_OFFLINE` | `true`, `false` | `safety/` |
| `MAX_TRADE_USD` | `25` | `execution/playbook.ts` (total notional cap per decision) |

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/health` | none | `{"ok":true,"version":"0.1.0","safeStop":false}`. `safeStop: true` means 0G is unreachable and trading is blocked. |
| `POST` | `/voice` | Body: WAV, 16-bit mono (16 kHz expected). `Content-Type: audio/wav` or `application/octet-stream`. Header `X-Device-Token` when `DEVICE_TOKEN` is set. | `200 application/octet-stream`: raw PCM s16le, mono, 16 kHz, no header. Headers `x-sample-rate`, `x-request-id` (0G inference id), `x-signal`. `400 bad_wav` for stereo or non-16-bit input, `401 unauthorized`, `503 {"error":"brain_offline"}`. |
| `POST` | `/button` | JSON `{"action":"confirm"}` or `{"action":"cancel"}`, same token header | `200 {action, requestId, signal, executed, actions[], orders[]}`. Acts on the last spoken decision; with none pending it decides from the news alone. `400` on a bad body, `503 brain_offline`. |

Sim-only (not used by the firmware): `GET /sim`, `GET /state`, `GET /events`, `POST /voice/text`, `POST /news/inject`,
`GET /alerts/next`, `POST /alerts/:id/ack`, `POST /sim/safe-stop`. Shapes in [docs/api.md](../docs/api.md#virtual-pod-sim-only).

The fake TTS answers every `/voice` call with 0.5 s of a 440 Hz tone (16000 bytes), so the speaker audibly works before
ElevenLabs is wired. The fake news feed contains a missile-strike headline, so the fake decider returns
`geopolitical_shock` and the playbook suggests long `xyz:GOLD`, long `xyz:WTI`, short `BTC`.

## Folder map

```
server/
├─ src/
│  ├─ index.ts              entrypoint: loads .env, listens on HOST:PORT
│  ├─ app.ts                Fastify routes, content-type parsers, device token, safe-stop gate
│  ├─ pipeline.ts           voice loop (STT → news → decide → TTS) and button handling, episode logging, observer hook
│  ├─ sim/                  virtual pod: state.ts (PodState store), routes.ts (/state, /events, inject, alerts), injected.ts
│  ├─ cli/pod.ts            `npm run pod` CLI
│  ├─ config.ts             zod-parsed env, never throws
│  ├─ audio/                wav.ts (parse/encode), stt.ts (FakeStt, Groq TODO), tts.ts (ToneTts, ElevenLabs TODO)
│  ├─ news/                 types.ts + rss, cryptopanic, polymarket, grok providers (fakes + TODO real endpoints)
│  ├─ credibility/ethos.ts  CredibilityScorer, FakeEthosScorer, Ethos API v2 TODO
│  ├─ agent/                decide.ts (Decision, FakeDecider), memory.ts (UserMemory), episode.ts (EpisodeLog)
│  ├─ payments/x402.ts      payForSignal / protectRoute stubs for Hedera x402
│  ├─ wallet/               account.ts (agent address), uniswap.ts (quoteAndSwap stub)
│  ├─ execution/            hyperliquid.ts (hip3AssetId, FakeHyperliquid), playbook.ts (planActions)
│  └─ safety/safeStop.ts    isBrainOnline(), BrainSwitch (runtime sim override)
├─ public/sim.html          virtual pod web UI, served at /sim
└─ test/                    node:test suites, run with tsx
```

## Where each hackathon track plugs in

| Track | Folder / file | What to replace |
|---|---|---|
| 0G: Physical AI, Agents with a Body | [`src/agent/`](src/agent), [`src/safety/safeStop.ts`](src/safety/safeStop.ts) | `FakeDecider` → 0G Compute Router (OpenAI-compatible, request id per decision). `InMemoryMemoryStore` and `InMemoryEpisodeLog` → encrypted blobs on 0G Storage (`@0gfoundation/0g-storage-ts-sdk`). `isBrainOnline` → real router ping. |
| Hedera: AI Agents That Pay (x402) | [`src/payments/`](src/payments) | `payForSignal` → `@x402/fetch` + `@x402/hedera` client; `protectRoute` → paywall on a `/signal` route settling on `hedera:testnet`. |
| Uniswap: Build with Uniswap | [`src/wallet/uniswap.ts`](src/wallet/uniswap.ts) | `quoteAndSwap` → Trading API `check_approval` → `quote` → `swap`, signed with viem. FEEDBACK.md points at this file. |
| Hyperliquid (execution venue, not a sponsor) | [`src/execution/`](src/execution) | `FakeHyperliquid` → `@nktkas/hyperliquid` with an approved API wallet. `hip3AssetId` and `planActions` are already real and tested. |
| Signal credibility (optional) | [`src/news/`](src/news), [`src/credibility/`](src/credibility) | Fake providers → RSS, CryptoPanic, Polymarket Gamma, Grok `x_search`; `FakeEthosScorer` → Ethos API v2. |
| Speech | [`src/audio/`](src/audio) | `FakeStt` → Groq `whisper-large-v3-turbo`; `ToneTts` → ElevenLabs `eleven_flash_v2_5` with `pcm_16000`. |

To swap a provider, change one line in `defaultDeps()` in [`src/app.ts`](src/app.ts). Tests pass their own deps through `buildApp({ deps })`.

## Notes

- Hyperliquid rejects orders under $10 notional. With the defaults (`MAX_TRADE_USD=25`, balanced profile) the
  geopolitical legs are $5 / $3.75 / $3.75, fine for the fake venue but too small for the real one. Raise
  `MAX_TRADE_USD` or set the risk profile to `aggressive` before going live, and enforce venue minimums in the executor.
- Memory and episodes live in process memory until the 0G Storage issue lands; a restart clears them.
  So do the virtual pod state, alerts and injected headlines.

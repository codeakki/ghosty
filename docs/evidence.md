# Evidence

Proof for the track judges: settled transactions, root hashes and order ids from live runs. Where each item comes from:

- **Hedera x402**: `npm run x402:demo` appends a row below. The running server shows the last payment (HashScan link, `verified` from the mirror node) at `GET /x402/status` and the decoded HCS audit log at `GET /hedera/audit`; `POST /sim/pay-signal` buys from the dashboard. Walkthrough: [hedera.md](hedera.md).
- **0G**: `GET /zerog/status` gives the last 0G request id, the memory root hash and the last episode root/tx with storagescan/chainscan links. The local index is `server/.ghosty/episodes.jsonl`. Track map: [tracks.md](tracks.md).
- **Hyperliquid / Uniswap**: `POST /button` returns order ids with explorer `url`s and the Uniswap `txHash`/`explorerUrl`; `GET /state` keeps the last orders and swaps. `npm run hl:check` prints the market map and margin.

- **Configuration**: `npm run doctor` (or `GET /providers/status` on the running server) shows, per track, which providers are `live`, `degraded`, `offline` or `not_configured`. Each `live` row is backed by a real call made at that moment: the Groq and ElevenLabs keys are accepted, the 0G router lists `OG_MODEL` and `OG_API_KEY` is set, the 0G Storage wallet has a balance on Galileo, the Hedera payer and merchant accounts exist on the mirror node with their balances, the facilitator's `/supported` lists `hedera:testnet`, the HCS topic exists, the Hyperliquid master has USDC margin on the main and `xyz` dexes and the agent appears in `extraAgents`, and the Uniswap wallet holds gas on `EVM_CHAIN_ID`. The output contains no secrets, so paste it below (with its timestamp) before recording a demo: it proves the run used real providers, because live mode has no fakes to fall back on.

Copy the live values into the tables below after each verified run. Keep the Hedera table last: `x402:demo` appends its rows to the end of this file.

## Provider configuration (npm run doctor)

Paste the doctor output of the run you are proving. No-key baseline from 2026-11-06 (only the keyless providers are live):

```
== Hedera x402 ==   x402-facilitator  LIVE  hedera:testnet supported (11 kinds)
== Data ==          rss  LIVE  4/4 feeds reachable · ethos  LIVE  reachable (@Reuters score 1427)
everything else:    NOT CONFIGURED with its missing env keys (0g-router, 0g-storage, hedera-*, hyperliquid, uniswap, groq, elevenlabs, ...)
```

## 0G Compute and Storage

| Time (UTC) | 0G request id | Episode root hash | Storage tx (chainscan) | Memory root hash |
|---|---|---|---|---|
| 2026-11-07T03:51:01Z | `7ae68660-4acb-4ee8-8499-1ebdf2343897` (glm-4.7 via 0G Compute Router, `geopolitical_shock`, conf 0.68) | `0x6ca544de85a5df2311527465636918d68e82a0b3108bebd222c70f352cadccdb` (episode seq 8, outcome `proposed`) | [`0xd3cab7c2…d219f7`](https://chainscan-galileo.0g.ai/tx/0xd3cab7c2ba0509b37f82ee714c4c97a3ae6b703c2ee50a0723b364f340d219f7) (receipt status 0x1, block 0x3d4d816) | `0x408c2198396df734e3913ad597d3d2484bf06294826ec90f575ccfe08a3c8fe7` ([memory tx](https://chainscan-galileo.0g.ai/tx/0x1d47904adb76a4cfab1ab83f83deccece49cc25b5aec5ad35e0d61ef41737b28)) |

## Hyperliquid orders and Uniswap spot leg

| Time (UTC) | Network | Order id / coin / side / size | Explorer | Uniswap tx |
|---|---|---|---|---|

## End-to-end run, 2026-11-07 (live server, no real-money trade)

One pass through the whole loop on the live server (`GHOSTY_MODE=live`, every provider `live` in `GET /providers/status` except the optional CryptoPanic, xAI and OpenAI TTS). No live alert was confirmed, so no Hyperliquid order or Uniswap swap was sent; a read of the Hyperliquid `userFills` after the run shows no fill newer than 2026-11-06T23:58Z.

| Step | Result | Proof |
|---|---|---|
| Voice Q&A (`POST /voice/text` "What's moving gold right now?") | `answeredBy: claude`, intent `question`, signal `none`, 508 238 bytes of ElevenLabs PCM | request `msg_011CgntLGJyWkqe6p5t8aWEj` |
| Shock headline (`POST /news/inject` "Missile strikes hit oil tankers in the Strait of Hormuz, Brent jumps", source reuters) | paid intel, then 0G decision `geopolitical_shock`, confidence 0.68, one leg: long `xyz:WTI` $10 | below |
| Paid intel (x402, autopay) | 0.01 USDC (`0.0.429274`), agent `0.0.11342726` → Signal Desk `0.0.11342424`, `verified: true` on the mirror node | [`0.0.9185802@1794023421.450304113`](https://hashscan.io/testnet/transaction/0.0.9185802-1794023421-450304113) |
| HCS audit | payment message #28, decision message #29 (`7ae68660-…`, `geopolitical_shock`) | [topic 0.0.11342727](https://hashscan.io/testnet/topic/0.0.11342727) |
| 0G Compute | request `7ae68660-4acb-4ee8-8499-1ebdf2343897`, model glm-4.7 | `GET /zerog/status` `lastRequestId` |
| 0G Storage episode | root `0x6ca544de85a5df2311527465636918d68e82a0b3108bebd222c70f352cadccdb`, outcome `proposed` | [chainscan tx](https://chainscan-galileo.0g.ai/tx/0xd3cab7c2ba0509b37f82ee714c4c97a3ae6b703c2ee50a0723b364f340d219f7) |
| Live alert | `alert-1`, left pending, expired unconfirmed after `PENDING_DECISION_TTL_SEC` (120 s) | `GET /state` |
| Paper simulation | see below | run `sim-4e700ce9` |

Testnet spend for the run: 0.01 USDC (one intel purchase), about 0.009 HBAR in HCS fees, about 0.008 0G in Storage gas (one live episode, the memory blob and four sim episodes).

### Paper simulation `sec-sues-binance-2023`

`POST /sim/run {"scenarioId":"sec-sues-binance-2023","speed":1800}` → run `sim-4e700ce9`, `liveOrders: false` (the server has `SIM_LIVE_ORDERS` off). The real 0G brain decided on the historical headlines; each pause was checked as a sim decision (`GET /sim/run` → `sim: true`, `pauseReason: awaiting_press`) before `POST /button confirm`, which filled on the PaperVenue only.

| Sim time | Headline | 0G request id | Signal | Paper fill |
|---|---|---|---|---|
| 2023-06-05T15:00Z | SEC Files 13 Charges Against Binance Entities and Founder Changpeng Zhao | `af202376-d8c4-4545-a356-a719cbc58d04` (completion `20261107115354ae71f4235a0f402d`) | `regulatory_crackdown` 0.75 | `paper-1` short BTC $10 @ 26 788.81 |
| 2023-06-06T14:30Z | SEC Charges Coinbase for Operating as an Unregistered Securities Exchange, Broker, and Clearing Agency | `86b27753-39b9-4113-840d-0297da5aaba3` (completion `2026110711552319902214b58f428f`) | `regulatory_crackdown` 0.72 | `paper-2` short BTC $10 @ 25 904.53 |

Result at the end of the scenario (2023-06-06T20:00Z): P&L −$0.56 (−5.6 % on the $10 notional, BTC short marked at 27 080.12) against +$0.12 (+1.2 %) for the hold baseline (equal-weight long). The Coinbase-day rebound went against the short.

Sim episodes on 0G Storage (chained by `prevRoot`):

| Seq | Request | Outcome | Root hash | Storage tx |
|---|---|---|---|---|
| 11 | `af202376-…` | proposed | `0x8966a8c33e95315fb7f8661713ac91d2b216a052184f929274fec7e31aab2844` | [`0x266babea…3924b9`](https://chainscan-galileo.0g.ai/tx/0x266babeafaaa1ea51777bb66f5df04fe13d320f5c97a4f66d81f5756353924b9) |
| 12 | `af202376-…` | executed (paper) | `0xa5d5bb8aea29f1f54d429d87b06cbd82a4e0d0846e11c30244733f9a9789fef7` | [`0xa63dade2…d2ae45`](https://chainscan-galileo.0g.ai/tx/0xa63dade210d3b8097c209a1f161f4df81a033e63673cb0ccfbd27d2b81d2ae45) |
| 13 | `86b27753-…` | proposed | `0xa6ddd2c47ce90e547e679d96659d3143c50b8faf674691714e07bdaf39d9c262` | [`0xfb514339…2b6c62`](https://chainscan-galileo.0g.ai/tx/0xfb514339172aa2cb1859f8adfa45d1ae74d1a2655d0add8f86bf1fca472b6c62) |
| 14 | `86b27753-…` | executed (paper) | `0x56ca40687111562ca2d1249129b732ff791565a2c2c78a93024a6117965ad360` | [`0xcd511966…f3dbf9`](https://chainscan-galileo.0g.ai/tx/0xcd511966acd6b6709532d8e846967fc5587f241c26c0bfeb3f397dac22f3dbf9) |

No real order or payment during the sim: `GET /x402/status` `lastPayment` stayed `0.0.9185802@1794023421.450304113` (USDC spent today unchanged at 0.01), the agent wallet has no Hedera transaction after HCS message #29, the sim's `execution.orders` is empty, and the Hyperliquid account value read 39.50 USDC before and after.

## Hedera x402 settled transactions

Each row is one autonomous purchase of a Signal Desk intel bundle (`GET /intel`) by the AGENT wallet `0.0.11342726`, paid to the Signal Desk merchant `0.0.11342424`, settled on `hedera:testnet` through an x402 facilitator (fee payer `0.0.9185802`), then checked independently on the mirror node. Rows are appended by `npm run x402:demo` (server/src/scripts/x402Demo.ts); the first two were recorded by hand from a live decision run (`POST /news/inject` on a test server, 2026-11-06, see [hedera.md](hedera.md#what-judges-should-look-at)).

- Accounts: [treasury 0.0.10499008](https://hashscan.io/testnet/account/0.0.10499008) · [agent 0.0.11342726](https://hashscan.io/testnet/account/0.0.11342726) · [merchant 0.0.11342424](https://hashscan.io/testnet/account/0.0.11342424)
- HCS audit topic: [0.0.11342727](https://hashscan.io/testnet/topic/0.0.11342727) (messages #1 to #4 below are these payments and the decision)
- First row: the bundle was bought (the brain probe said online), then the 0G call timed out at 20 s on a slow network, so that decision answered `503 brain_offline` and proposed nothing. It is the one case where buying before deciding spends 0.01 USDC for nothing; see [hedera.md](hedera.md#the-payment-flow-and-its-guards). The retry 40 s later (second row) decided with the bundle.

| Time (UTC) | Transaction (HashScan) | Amount | Payer → payTo | Mirror verified | HCS audit |
|---|---|---|---|---|---|
| 2026-11-06T17:07:40Z | [`0.0.9185802@1793984843.895067134`](https://hashscan.io/testnet/transaction/0.0.9185802-1793984843-895067134) | 0.01 USDC | 0.0.11342726 → 0.0.11342424 | yes (0G then timed out: no decision, see note) | [0.0.11342727 #1](https://hashscan.io/testnet/topic/0.0.11342727) |
| 2026-11-06T17:08:19Z | [`0.0.9185802@1793984888.876950864`](https://hashscan.io/testnet/transaction/0.0.9185802-1793984888-876950864) | 0.01 USDC | 0.0.11342726 → 0.0.11342424 | yes | payment [#2](https://hashscan.io/testnet/topic/0.0.11342727), decision `bb6d851f-34c9-41f5-8a83-b7f755059320` (geopolitical_shock, used paidIntel) [#3](https://hashscan.io/testnet/topic/0.0.11342727) |
| 2026-11-06T17:09:08.654Z | [`0.0.9185802@1793984930.617250384`](https://hashscan.io/testnet/transaction/0.0.9185802-1793984930-617250384) | 0.01 HBAR | 0.0.11342726 → 0.0.11342424 | yes | [0.0.11342727 #4](https://hashscan.io/testnet/topic/0.0.11342727) |
| 2026-11-06T23:12:59.700Z | [`0.0.9185802@1794006766.681511663`](https://hashscan.io/testnet/transaction/0.0.9185802-1794006766-681511663) | 0.01 USDC | 0.0.11342726 → 0.0.11342424 | yes | [0.0.11342727 #18](https://hashscan.io/testnet/topic/0.0.11342727) |
| 2026-11-07T03:50:37.687Z | [`0.0.9185802@1794023421.450304113`](https://hashscan.io/testnet/transaction/0.0.9185802-1794023421-450304113) | 0.01 USDC | 0.0.11342726 → 0.0.11342424 | yes | payment [#28](https://hashscan.io/testnet/topic/0.0.11342727), decision `7ae68660-4acb-4ee8-8499-1ebdf2343897` (geopolitical_shock) [#29](https://hashscan.io/testnet/topic/0.0.11342727) |

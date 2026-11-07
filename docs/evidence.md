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

## Hyperliquid orders and Uniswap spot leg

| Time (UTC) | Network | Order id / coin / side / size | Explorer | Uniswap tx |
|---|---|---|---|---|

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

# Evidence

Proof for the track judges: settled transactions, root hashes and order ids from live runs. Where each item comes from:

- **Hedera x402**: `npm run x402:demo` appends a row below. The running server also shows the last payment (HashScan link) and the HCS topic at `GET /x402/status`, and `POST /sim/pay-signal` pays from the dashboard.
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

Each row is one autonomous `GET /signal` payment by the agent wallet, settled on `hedera:testnet` through an x402 facilitator. Appended by `npm run x402:demo` (server/src/scripts/x402Demo.ts).

| Time (UTC) | Transaction (HashScan) | Amount | Payer → payTo | Signal requestId | HCS audit |
|---|---|---|---|---|---|
| 2026-11-06T17:09:08.654Z | [`0.0.9185802@1793984930.617250384`](https://hashscan.io/testnet/transaction/0.0.9185802-1793984930-617250384) | 0.01 HBAR | 0.0.11342726 → 0.0.11342424 | yes | [0.0.11342727 #4](https://hashscan.io/testnet/topic/0.0.11342727) |

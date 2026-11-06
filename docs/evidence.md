# Evidence

Proof for the track judges: settled transactions, root hashes and order ids from live runs. Where each item comes from:

- **Hedera x402**: `npm run x402:demo` appends a row below. The running server also shows the last payment (HashScan link) and the HCS topic at `GET /x402/status`, and `POST /sim/pay-signal` pays from the dashboard.
- **0G**: `GET /zerog/status` gives the last 0G request id, the memory root hash and the last episode root/tx with storagescan/chainscan links. The local index is `server/.ghosty/episodes.jsonl`. Track map: [tracks.md](tracks.md).
- **Hyperliquid / Uniswap**: `POST /button` returns order ids with explorer `url`s and the Uniswap `txHash`/`explorerUrl`; `GET /state` keeps the last orders and swaps. `npm run hl:check` prints the market map and margin.

Copy the live values into the tables below after each verified run. Keep the Hedera table last: `x402:demo` appends its rows to the end of this file.

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

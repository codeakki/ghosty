# Try the Ghosty server

The Ghosty server runs on AWS (ECS, Mumbai). Anyone can read its state. Actions need the device token, and trades
also need the owner's pod: every order is signed on the Dabao chip in the pod, so the server alone cannot trade.

**Base URL:** `https://gh-f8c6b0f6fdd845a0b61dd39fde641ecb.ecs.ap-south-1.on.aws`

If your DNS does not resolve the name, resolve it with a public resolver:

```bash
H=gh-f8c6b0f6fdd845a0b61dd39fde641ecb.ecs.ap-south-1.on.aws
curl --resolve "$H:443:$(dig +short @1.1.1.1 $H | tail -1)" "https://$H/health"
```

## 1. Open the terminal UI

Open the base URL in a browser. It shows live prices, news, decisions, signals, and orders.

## 2. Read-only API (no token)

| Endpoint | What it returns |
|---|---|
| `GET /health` | `{"ok":true,"safeStop":false}`. `safeStop: true` means the 0G brain is offline and trading is blocked. |
| `GET /state` | News, alerts, decisions, planned actions, and recent orders |
| `GET /events` | Server-sent events: news, voice turns, decisions, orders, as they happen |
| `GET /market/snapshot` | Watchlist prices and 24 h change (Hyperliquid mainnet) |
| `GET /market/history?coin=xyz:GOLD` | Price history for one coin |
| `GET /execution/markets?query=GOLD` | Hyperliquid markets the venue can trade |
| `GET /zerog/status` | 0G Compute and 0G Storage status, last root hash |
| `GET /episodes` | Decision episodes stored on 0G Storage |
| `GET /providers/status` | Which providers are live (0G, Groq, ElevenLabs, Claude, Hyperliquid, …) |
| `GET /x402/status`, `GET /hedera/audit` | Hedera x402 payments and the HCS audit trail |

Examples:

```bash
B=https://gh-f8c6b0f6fdd845a0b61dd39fde641ecb.ecs.ap-south-1.on.aws
curl -s $B/health
curl -s $B/market/snapshot | jq '.assets[] | {coin, mid, change24hPct}'
curl -s $B/state | jq '.news[0:3] | map(.title)'
curl -sN $B/events            # live stream, Ctrl-C to stop
```

## 3. Talk to Ghosty (device token required)

The owner gives you the token privately. Never commit it or paste it in a public place.

```bash
TOKEN=...   # from the owner
curl -s -X POST $B/voice/text \
  -H "x-device-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Ghosty, what is gold trading at?"}' | jq '{reply, answeredBy}'
```

Things to try:

| You send | Ghosty does |
|---|---|
| "What is gold trading at?" | Answers from live market data |
| "What did I buy today?" | Answers from the owner's memory on 0G |
| "What is my PnL?" | Reads the Hyperliquid positions and answers |
| "Buy 10 dollars of gold" | Tries the order, but the server needs the pod's Dabao to sign it. From `/voice/text` there is no pod, so the order fails and the reply says so. Nothing is traded. |

## How a real trade works (for reference)

```
pod mic ──/voice──> server: speech to text (Groq), Claude Sonnet 5.5 picks the order
server ──202 + order fields──> pod ──UART──> Dabao: checks limits, signs
Dabao ──> pod ──/sign──> server: checks the signature ──> Hyperliquid
server ──> pod speaker: "Done. I bought 10.16 dollars of gold…"
```

The Dabao limits orders to gold, oil, BTC, ETH, and SOL, at most 15 USD per order and 50 USD per day. Close orders
(reduce-only) are exempt.

# Simulation environment

Replay a real past market shock against the real Ghosty brain, with no hardware and no trading keys. A scenario
plays real headlines at their historical times over real historical prices, on a compressed clock. Each shock
headline goes to a real decider call. Confirmed trades fill on a paper venue. Every step is logged as an episode
you can replay.

## What is real and what is simulated

| Part | In a simulation run |
|---|---|
| Brain | **Real.** Every sim decision is a real decider call: 0G Compute (`OG_API_KEY`) in live mode. Safe-stop applies: if 0G is unreachable (or `POST /sim/safe-stop` is on), the headline is recorded as `skipped: "brain_offline"` and no decision is made. Decisions are never faked. |
| Headlines | **Real past headlines**, verbatim or close paraphrase, with the real date and a source URL each. Most outlets do not publish the minute, so `ts` is approximate; each headline's `tsNote` says how it was placed. |
| Prices | **Real historical candles** from keyless public APIs (Binance public klines via `data-api.binance.vision`, or Hyperliquid `candleSnapshot`). The mid at a sim time is interpolated between the candle's open and close. Cached in `server/.ghosty/candles/`. |
| Clock | **Simulated.** `speed` = market seconds per real second (default 360, so one market hour takes 10 s). The clock stops at each headline while the brain thinks, and (by default) while an alert waits for a press. |
| Execution | **Paper only.** Sim decisions are tagged `sim: true, runId` and always fill on the run's PaperVenue at the historical mid ± slippage (default 5 bps). The Hyperliquid and Uniswap executors are never called, whatever keys are set (covered by a test). |
| Memory | Your 0G memory, read-only, when `OG_PRIVATE_KEY` is set. Without it the run uses the default memory snapshot and says so in `memory`. The watchlist is narrowed to the scenario's markets, the only ones we can price. A sim never saves memory. |
| Episodes | 0G Storage when `OG_PRIVATE_KEY` is set (`storage: "0g"`, real merkle root). Otherwise an append-only local log `server/.ghosty/sim-episodes.jsonl` with `storage: "local"` and root `local:<sha256>`. Each episode links to the previous one (`prevRoot`). Sim episodes never join the live episode chain. |

**OG_PRIVATE_KEY is not required.** With only `OG_API_KEY` you get real 0G decisions, paper fills and local
episodes.

What a run measures: the paper P&L of the trades you confirmed (`pnlUsd`, `pnlPct`), against a **hold** baseline
(`baselinePnlUsd`, `baselinePct`): `MAX_TRADE_USD` split equally long across the scenario markets from the run
start. Both are marked to the same historical prices.

## Scenarios

| id | Event | Window (UTC) | Markets | Kind |
|---|---|---|---|---|
| `israel-iran-strikes-2025` | Israel strikes Iran, 13 Jun 2025 | 2025-06-12 18:00 → 06-13 12:00 | BTC, ETH, xyz:GOLD (PAXG proxy) | geopolitical shock |
| `bybit-hack-2025` | Bybit $1.5B hack, 21 Feb 2025 | 2025-02-21 12:00 → 02-22 06:00 | BTC, ETH | hack |
| `sec-sues-binance-2023` | SEC sues Binance, then Coinbase, 5-6 Jun 2023 | 2023-06-05 12:00 → 06-06 20:00 | BTC, ETH | regulatory |

Headline sources (full list with notes in each JSON file):

- Israel/Iran: Reuters, "Israel strikes Iran nuclear facilities, missile factories"
  ([copy](https://www.deccanherald.com/amp/story/world%2Fisrael-strikes-iran-nuclear-facilities-missile-factories-3584001)),
  "Israel hits Iran nuclear, missile facilities; Tehran launches drones"
  ([copy](https://theeastafrican.co.ke/tea/news/world/israel-hits-iran-nuclear-facilities-iran-launches-drones-5079952)),
  "Israel hits Iran nuclear and missile facilities, appears to block retaliation"
  ([copy](https://www.thejakartapost.com/world/2025/06/13/israel-hits-iran-nuclear-and-missile-facilities-appears-to-block-retaliation.html)).
- Bybit: Ben Zhou's post on X, quoted by [Kitco](https://www.kitco.com/news/article/2025-02-21/bybit-exchange-loses-14-billion-eth-hackers-cofounder-insists-they-are);
  [Bloomberg](https://www.bloomberg.com/news/articles/2025-02-21/bybit-says-exchange-wallet-hacked-1-5-billion-estimated-loss);
  [AP](https://m.washingtontimes.com/news/2025/feb/22/1-5-billion-hack-strikes-major-cryptocurrency-exchange-bybit/).
- SEC: press releases [2023-101](https://www.sec.gov/news/press-release/2023-101) (Binance) and
  [2023-102](https://www.sec.gov/news/press-release/2023-102) (Coinbase).

Why Binance klines: Hyperliquid `candleSnapshot` returns at most ~5000 candles per interval, so its 1h history
only reaches back to mid-April 2026 (checked 2026-11-06). These events are older. Binance public klines need no key
and reach back years. Gold uses PAXG (a gold-backed token) as a proxy and says so in `proxy`. Oil (`xyz:WTI`) has
no keyless historical source here, so no scenario includes it.

Which headlines reach the brain: the same keyword pre-filter as the live news poller (`news/shock.ts`: war,
strikes, nuclear, sanctions, bans, hack, exploit...) plus the decider's own classes (`SEC`, lawsuit, crackdown). A
headline that matches neither is recorded as `skipped: "no_shock"`. A match always goes to the real brain, which
may still answer `none`.

### Scenario file format

`server/src/sim/scenarios/<id>.json`, validated at load (`server/src/sim/scenarios.ts`):

```json
{
  "id": "sec-sues-binance-2023",
  "title": "SEC sues Binance, then Coinbase (5-6 Jun 2023)",
  "description": "What happened, one or two sentences.",
  "category": "regulatory",
  "start": "2023-06-05T12:00:00Z",
  "end": "2023-06-06T20:00:00Z",
  "interval": "15m",
  "markets": [
    { "coin": "BTC", "source": "binance", "symbol": "BTCUSDT" },
    { "coin": "xyz:GOLD", "source": "binance", "symbol": "PAXGUSDT", "proxy": "PAXG (gold-backed token) as the gold price" }
  ],
  "headlines": [
    {
      "ts": "2023-06-05T15:00:00Z",
      "title": "SEC Files 13 Charges Against Binance Entities and Founder Changpeng Zhao",
      "source": "U.S. SEC",
      "handle": "SECGov",
      "url": "https://www.sec.gov/news/press-release/2023-101",
      "tsNote": "How exact ts is."
    }
  ],
  "sources": ["Extra references and the price source"]
}
```

Rules: real events only, every headline has a source `url`, `ts` inside `[start, end]`, `interval` one of
`1m | 5m | 15m | 1h`, `source` `binance` or `hyperliquid` (use `hyperliquid` with the HL coin as `symbol` for
events in the last ~200 days). Only list markets you can price.

## Run a scenario

The server must be running (`npm run dev`). With `GHOSTY_MODE=live` and `OG_API_KEY` set, decisions are real 0G
calls. In test mode the keyword FakeDecider stands in.

### UI

The terminal's simulation panel (PR #45) lists scenarios, starts a run, shows the sim clock, the alerts, the paper
P&L against hold and the episode replay. It reads `GET /sim/run` and the `sim` SSE event.

### CLI

```bash
cd server
npm run pod -- sim list
npm run pod -- sim run sec-sues-binance-2023 --speed 1800   # add --no-autopause to let the clock run on
npm run pod -- sim status        # sim time, progress, P&L vs hold, positions, decisions
npm run pod -- press confirm     # an alert is pending: fills on paper at the historical price
npm run pod -- sim pause | resume | stop
npm run pod -- watch             # SSE, including `sim` events
```

### curl

```bash
S=http://localhost:3000; T='x-device-token: <DEVICE_TOKEN if set>'
curl -s $S/sim/scenarios | jq '.scenarios[].id'
curl -s -XPOST $S/sim/run -H "$T" -H 'content-type: application/json' \
  -d '{"scenarioId":"israel-iran-strikes-2025","speed":1800}'
curl -s $S/sim/run | jq '{status, simTime, progress, pending, pnlUsd, baselinePnlUsd}'
# status "paused" + pauseReason "awaiting_press": the brain proposed a trade. Confirm it on paper:
curl -s -XPOST $S/button -H "$T" -H 'content-type: application/json' -d '{"action":"confirm"}'
curl -s -XPOST $S/sim/control -H "$T" -H 'content-type: application/json' -d '{"action":"stop"}'
# Episodes of the run, then walk the chain back from the newest root
curl -s "$S/episodes?runId=<runId>" | jq
curl -s "$S/episodes/replay?from=$(curl -s $S/sim/run | jq -r .lastRootHash)&limit=20" | jq
```

`POST /button` goes to the sim while a sim decision is pending. A live pending decision waits until the sim one is
confirmed, cancelled or the run is stopped. Only one run is active at a time; starting another ends the previous one.

## Code

| File | What |
|---|---|
| `server/src/sim/scenarios.ts`, `scenarios/*.json` | Scenario schema, loader, files |
| `server/src/sim/candles.ts` | Keyless historical candles, cache, `priceAt` |
| `server/src/sim/engine.ts` | `SimEngine`: clock, headline scheduling, decision loop, auto-pause, status |
| `server/src/sim/paperVenue.ts` | `PaperVenue` (fills, positions, P&L), hold baseline |
| `server/src/sim/episodes.ts` | `SimEpisodeLog` (0G or local, chained), `replayChain` |
| `server/src/sim/runRoutes.ts` | `/sim/scenarios`, `/sim/run`, `/sim/control`, `/episodes`, `/episodes/replay` |
| `server/test/sim-engine.test.ts` | Offline tests (mocked 0G, mocked candles) |

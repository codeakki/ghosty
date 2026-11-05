# Ethos + Grok — developer notes

Role: **optional credibility and news providers.** Neither is a sponsor. Both sit behind provider interfaces, so the agent works without them. Researched 2026-11-05; implemented and verified 2026-11-06 (branch `feat/server-audio-news`).

## Ethos Network (credibility score)

Gives a reputation score for an X handle or a wallet address. We use it to weight news sources and posters before the 0G decision.

| Item | Value |
|---|---|
| Base URL | `https://api.ethos.network/api/v2` (`ETHOS_API_URL`) |
| Auth | None. The `X-Ethos-Client: ghosty@0.1.0` header is required (`ETHOS_CLIENT`). |
| Score range | `0–2800`, response `{ score, level }` |
| Switch | `ETHOS_ENABLED=true` → `EthosScorer`; otherwise `FakeEthosScorer`, so tests and dev stay offline |
| Docs | https://developers.ethos.network, https://api.ethos.network/docs/llms-full.txt |

### Endpoints (all four called live on 2026-11-06)

| Method | Path | Live response |
|---|---|---|
| GET | `/score/userkey?userkey=service:x.com:username:VitalikButerin` | `200 {"score":2626,"level":"renowned"}` |
| GET | `/score/userkey?userkey=service:x.com:username:<unknown>` | `404 {"message":"Twitter username not found","code":"NOT_FOUND",…}` |
| GET | `/score/address?address=0xd8dA…6045` | `200 {"score":1312,"level":"neutral"}` |
| POST | `/score/userkeys` body `{"userkeys":[…]}` | `200 {"service:x.com:username:VitalikButerin":{"score":2626,"level":"renowned"},"service:x.com:username:Reuters":{"score":1427,"level":"known"}}` |
| POST | `/score/addresses` body `{"addresses":[…]}` | `200 {"0xd8dA…6045":{"score":1312,"level":"neutral"}}` |

Ethos's own `level` values include `known`, `neutral` and `renowned`, which are not our five coarse levels. We keep theirs in `ethosLevel` and still derive our `level` from the score, so `FakeDecider` keeps working.

### Implementation (`server/src/credibility/ethos.ts`)

- `scoreHandle`, `scoreHandles`, `scoreAddress` and `scoreAddresses` serve cached keys first. They score the rest with individual GETs when 3 or fewer are missing, or with bulk POSTs in chunks of 50 when more than 3 are missing.
- **404 → unknown** (`score: null`, weight 0.5) and is cached. Keys missing from a bulk reply are treated the same way.
- **5xx or network error → unknown, not cached**, so the scorer never blocks a decision and retries on the next poll.
- **Cache:** in memory, 1 h TTL (`ETHOS_CACHE_TTL_MS`). Scores move slowly.
- **Weight:** `weightFromScore(score) = 0.2 + 0.8 × clamp(score, 0, 2800) / 2800`, so 0 → 0.2, 1400 → 0.6 and 2800 → 1.0. Unknown → 0.5.
- `weightItems(items, scorer)` (also `EthosScorer#weightItems`) attaches `credibility` to each `NewsItem`:
  - The publisher domain is in the static table (`credibility/sources.ts`): `max(domain weight, Ethos weight)`.
  - Otherwise: the Ethos weight when Ethos knows the handle, else 0.6 (medium).
  - Table: reuters, apnews, bloomberg 1.0; ft, wsj 0.95; coindesk, theblock, cnbc 0.9; polymarket, blockworks 0.8; decrypt, cointelegraph 0.75; cryptopanic 0.6; x.com 0.5 (the poster's Ethos score decides); unknown 0.6. Subdomains match their parent.
- The weight is an input to the 0G prompt, not a hard filter. The decision and its reasoning stay on 0G.

## xAI Grok — X search

Live X posts for breaking events, faster than RSS. Implemented in `server/src/news/grok.ts` as `GrokProvider`. It is off unless `XAI_API_KEY` is set.

| Item | Value |
|---|---|
| Endpoint | `POST https://api.x.ai/v1/responses`, `Authorization: Bearer $XAI_API_KEY` |
| Model | `grok-4.7` (`XAI_MODEL`) |
| Tool | `{ "type": "x_search", "allowed_x_handles": [...], "from_date": "YYYY-MM-DD" }` |
| Tool options | All go **inside the tool object**: `allowed_x_handles` / `excluded_x_handles` (max 20 each, no `@`, mutually exclusive), `from_date` / `to_date` (`YYYY-MM-DD`, UTC, `to_date` exclusive), `enable_image_understanding`, `enable_video_understanding` |
| Response | Text is at `output[type=message].content[type=output_text].text`. Citations are in `annotations[]` with `{type:"url_citation", url, start_index, end_index, title}`. Searches appear as `custom_tool_call` items; usage is under `usage.server_side_tool_usage_details`. |
| Pricing | $5 per 1k posts fetched, $10 per 1k profiles, plus tokens |
| Docs | https://docs.x.ai/developers/tools/x-search, https://docs.x.ai/developers/tools/citations |

### What we send and parse

- **Request:** a system instruction asks for a JSON array only: `[{handle, text, url, posted_at}]`. The user turn asks for the latest market-moving posts. The tool block carries `allowed_x_handles` (`XAI_X_HANDLES`, default `DeItaone, Reuters, WatcherGuru, tier10k, zerohedge`) and `from_date` set to yesterday in UTC.
- **Parse:** we take the JSON array from the output text, which tolerates code fences. If that yields nothing, we fall back to `url_citation` annotations that point at `x.com/<handle>/status/<id>`, using the citing line as the title. Items get the id `grok:<statusId>`, a `handle` (scored by Ethos), and the domain `x.com`.

### Cost control

- **Off by default:** Grok is used only when `XAI_API_KEY` is set.
- **Rate limit:** at most one paid call per `XAI_MIN_INTERVAL_SECONDS` (default 300). Polls in between get the cached result.
- **One call in flight:** if the aggregator's deadline fires, the next poll shares the pending call instead of paying for a second one.
- **Scope:** an allowlist of at most 20 handles and a one-day window.

## Pipeline

```
Grok x_search ─┐
RSS / CryptoPanic / Polymarket ─┼─> NewsAggregator (dedupe, 120 min window, seen file)
                                │        └─> weightItems: Ethos + source table → item.credibility
                                └─> NewsPoller.onNew → shockDetector pre-filter → 0G decision
```

## Unverified

- A possible Ethos x402 route `/x402/score/{userkey}`, which would be a nice Hedera tie-in if it exists. Not probed.
- The maximum bulk size for `/score/userkeys`. We chunk at 50 to be safe.
- The Grok response from a real `x_search` call. No key was available, so the parser is tested against the documented shape only. Whether `grok-4.7` reliably follows the "JSON array only" instruction is also untested; the annotation fallback covers prose replies.
- Top-level `citations` on Responses API results. The docs show it for chat completions only, and we do not rely on it.

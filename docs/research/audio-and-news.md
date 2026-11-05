# Audio (STT / TTS / ESP32) and news sources — developer notes

Researched 2026-11-05. Implemented and re-verified 2026-11-06 (branch `feat/server-audio-news`).

## Audio contract with the pod

| Direction | Format | Size |
|---|---|---|
| Pod → server | WAV: 44-byte header + PCM, 16 kHz, 16-bit, mono | 32 KB/s; 5 s ≈ 160 KB |
| Server → pod | Raw s16le, 16 kHz, mono, `application/octet-stream` | Streamed to I2S in 1–2 KB chunks |

Push-to-talk: hold button → record int16 into PSRAM → prepend WAV header → `HTTPClient` POST `Content-Type: audio/wav` → read `http.getStreamPtr()` → `playPcm16()`.

**Do not decode MP3 on the device.** ESP8266Audio is GPL and creates its own TX-only I2S channel, which clashes with our shared full-duplex port. The server must return raw PCM at 16 kHz.

## What is implemented

Every real provider sits behind the existing interface. A factory picks the real one when its key is set and the fake otherwise, so `npm run dev` and the test suite still work with an empty `.env`.

| Module | Real | Picked when | Fake |
|---|---|---|---|
| `src/audio/stt.ts` | `GroqStt` | `GROQ_API_KEY` | `FakeStt` |
| `src/audio/tts.ts` | `ElevenLabsTts`, then `OpenAiTts` | `ELEVENLABS_API_KEY`, else `OPENAI_API_KEY` | `ToneTts` |
| `src/audio/resample.ts` | `resamplePcm16` linear resampler | used by `OpenAiTts` (24 kHz → 16 kHz) | |
| `src/news/rss.ts` | `RssProvider` + `parseRss` (zero-dependency regex parser, RSS 2.0 and Atom) | `NEWS_LIVE=true` | `FakeRssProvider` |
| `src/news/cryptopanic.ts` | `CryptoPanicProvider` (votes → `sentiment` 0–1) | `CRYPTOPANIC_TOKEN` | `FakeCryptoPanicProvider` |
| `src/news/polymarket.ts` | `PolymarketProvider` (keyword-filtered Gamma events → `probability`) | `NEWS_LIVE=true` | `FakePolymarketProvider` |
| `src/news/grok.ts` | `GrokProvider` (xAI Responses + `x_search`) | `XAI_API_KEY` | `FakeGrokProvider` |
| `src/news/aggregator.ts` | `NewsAggregator`, `NewsPoller` | | |
| `src/news/shock.ts` | `shockDetector` keyword pre-filter | | |
| `src/news/factory.ts` | `createNewsProviders`, `createNewsAggregator` | | |

With `NEWS_LIVE=true`, sources without a key are dropped instead of faked, so live mode never mixes canned headlines with real ones.

## STT: Groq Whisper

| Item | Value |
|---|---|
| Endpoint | `POST https://api.groq.com/openai/v1/audio/transcriptions` (multipart) |
| Auth | `Authorization: Bearer $GROQ_API_KEY` |
| Fields sent | `file` (`ptt.wav`, `audio/wav`), `model`, `response_format=verbose_json`, `temperature=0`, optional `language` |
| Models | `whisper-large-v3-turbo` (default, transcription only), `whisper-large-v3` (also translation) |
| Limits | 25 MB direct upload on the free tier (5 s of 16 kHz mono is ~160 KB) |
| Timeout | 15 s (`STT_TIMEOUT_MS`) |
| Docs | https://console.groq.com/docs/speech-to-text |

Returns `{ text, provider: 'groq:<model>', language?, durationMs }`. `durationMs` comes from `verbose_json.duration` when present, else from the PCM length. HTTP and network errors throw `SttError` (with `status`).

Alternatives kept on file: OpenAI `gpt-4o-mini-transcribe`, Deepgram Nova-3 (streaming), and 0G Whisper Large v3. `ZeroGStt` is a commented TODO in `stt.ts` because the 0G branch owns that integration.

## TTS: ElevenLabs, OpenAI fallback

| Item | ElevenLabs (default) | OpenAI (fallback) |
|---|---|---|
| Endpoint | `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000` | `POST https://api.openai.com/v1/audio/speech` |
| Auth | `xi-api-key` header | `Authorization: Bearer` |
| Body | `{ text, model_id: "eleven_flash_v2_5" }` | `{ model: "gpt-4o-mini-tts", voice: "marin", input, response_format: "pcm" }` |
| Output | raw s16le mono 16 kHz, played as-is | raw s16le mono **24 kHz**, resampled to 16 kHz |
| Voice | `ELEVENLABS_VOICE_ID`, default `JBFqnCBsd6RMkjVDRZzb` ("George", the id the API reference uses) | `marin` (OpenAI recommends `marin`/`cedar`) |
| Docs | https://elevenlabs.io/docs/api-reference/text-to-speech/stream | https://developers.openai.com/api/docs/guides/text-to-speech |

Notes:

- `pcm_16000` is in the documented `output_format` list. Some formats need a higher subscription tier. The docs do not say which, so check this on the account we use.
- `optimize_streaming_latency` is deprecated, so we do not send it.
- The OpenAI guide says `gpt-4o-mini-tts`, `tts-1` and `tts-1-hd` shut down on 2027-01-06. That is fine for the hackathon; after that, move the fallback.
- The resampler is linear with no anti-alias filter. That is acceptable for speech on a small speaker. It is unit-tested for length and values.
- Pre-render fixed phrases at startup ("brain offline", "Done.", "Cancelled.") so safe-stop still works when TTS is down. This is not done yet and belongs with the pipeline wiring.

## News sources

### RSS (verified: each URL fetched once on 2026-11-06)

| Outlet | URL | Result | X handle (for Ethos) |
|---|---|---|---|
| CoinDesk | `https://www.coindesk.com/arc/outboundfeeds/rss/` | 200 `application/xml`, 25 items | `CoinDesk` |
| Cointelegraph | `https://cointelegraph.com/rss` | 200 `application/xml`, 30 items | `Cointelegraph` |
| The Block | `https://www.theblock.co/rss.xml` | 200 `text/xml`, 20 items | `TheBlock__` |
| Decrypt | `https://decrypt.co/feed` | 200 `application/xml`, 37 items | `decryptmedia` |

All four are RSS 2.0 with `<title>` (sometimes CDATA), `<link>` (Cointelegraph wraps it in CDATA and adds `utm_*` params, which we strip), `<pubDate>` (RFC 822), and `<guid>`. The parser also handles Atom `<entry>` for custom feeds. We send `User-Agent: ghosty/0.1 (+https://github.com/codeakki/ghosty)`. One failing feed never sinks the others.

### CryptoPanic

| Item | Value |
|---|---|
| Endpoint | `GET https://cryptopanic.com/api/growth/v2/posts/?auth_token=…&public=true&kind=news[&currencies=BTC,ETH]` |
| Path check | `/api/v1/posts/` now returns an HTML page. `/api/developer/v2/posts/` returns `Unknown API endpoint. Valid paths are /api/{growth\|growth_weekly\|enterprise}/v2/{posts\|portfolio\|status}/` (probed 2026-11-06). `CRYPTOPANIC_API_URL` lets us switch plans. |
| Mapping | `results[].{id,title,original_url ?? url,published_at,source.domain,votes,author.twitter}` → `NewsItem` |
| Sentiment | `(positive + liked + 1) / (positive + liked + negative + disliked + toxic + 2)`: 0.5 with no votes, near 1 bullish, near 0 bearish |
| Docs | https://cryptopanic.com/developers/api/ (JS-rendered). Field names were cross-checked against the `cryptopanic-go` SDK. |

### Polymarket Gamma

| Item | Value |
|---|---|
| Endpoint | `GET https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200&order=volume24hr&ascending=false[&tag_slug=…]`, no auth |
| Filter | Keep open markets whose event title or question **starts a word** with one of `NEWS_POLYMARKET_KEYWORDS`, so `war` does not match "Starwars". |
| Output | One `NewsItem` per market: title `"<question> (Polymarket 24% yes, +4 pts 24h)"`, `probability` = "Yes" price, `probabilityChange24h` = `oneDayPriceChange`, sorted by 24 h volume |
| Fields | `outcomes` and `outcomePrices` are JSON-encoded strings (`'["Yes","No"]'`, `'["0.23","0.77"]'`). We parse them defensively and accept real arrays too. |
| Fallback | If the API rejects `order` with a 4xx, we retry once without `order`/`ascending`. |

**Blocked from Indian ISPs.** From this network `gamma-api.polymarket.com` resolves to `49.44.79.236` (a sinkhole) and times out, and so do `polymarket.com` and `docs.polymarket.com`. At ETHGlobal Mumbai, use a VPN or a hotspot that does not block it. Otherwise the provider times out after 8 s and the aggregator carries on without it.

### Grok x_search

See [ethos-grok.md](ethos-grok.md). It is off unless `XAI_API_KEY` is set. Results are cached for `XAI_MIN_INTERVAL_SECONDS` (default 300 s), so the 60 s poller does not pay on every tick.

### Skipped

NewsAPI.org (delayed on the free tier) and CoinGecko `/news` (paid only).

## Aggregator, poller, shock detector

- `NewsAggregator.poll()` fans out to every provider. Each provider gets its own deadline: `NEWS_PROVIDER_TIMEOUT_MS`, default 8 s, and 45 s for `grok`, whose late result is cached for the next poll anyway. It returns `{ fresh, window, errors }`.
- **Dedupe:** two items are the same story if they share the provider id, the normalized URL (host without `www`, path without trailing slash, no query or hash), or the normalized title (lowercase, letters and digits only, at least 12 chars).
- **Window:** keeps items published within `NEWS_WINDOW_MINUTES` (default 120). Future or unparseable timestamps are clamped to now. A repeated provider id refreshes the stored item (moving Polymarket odds) without re-announcing it.
- **Seen file:** dedupe keys are persisted to `NEWS_SEEN_PATH` (default `server/.ghosty/news-seen.json`, gitignored, capped at 5000 keys, written atomically). After a restart, old headlines rebuild the window but are not "fresh" again.
- **Credibility:** when given a `scorer`, fresh items get a `credibility` value from `weightItems` (see [ethos-grok.md](ethos-grok.md)).
- **As a provider:** the aggregator is itself a `NewsProvider`. `fetchLatest()` returns the window, so the pipeline can take `news: [aggregator]` unchanged.
- **Poller:** `NewsPoller(aggregator, { intervalMs })` polls on an unref'd interval, never overlaps ticks, and calls each `onNew(items)` listener once per batch of never-seen items. Listener errors go to `onError` and do not stop other listeners.
- **Shock detector:** `shockDetector(items)` is a pure keyword pre-filter. Its priority order is `geopolitical_shock` (war, missile, strike, invasion, nuclear) > `regulatory_crackdown` (sanction, ban) > `crypto_incident` (hack, exploit, depeg). It returns `{ candidate, signal, matched, all }`. `crypto_incident` has no playbook yet, so its `signal` is `none`. The detector only narrows the input; the 0G agent makes the decision.

Live smoke run (2026-11-06, no keys, Ethos on): 4 feeds produced 40 items in the window, Ethos weights were attached, and Polymarket timed out (ISP block, see above).

## Keys to obtain

| Key | Where | Cost |
|---|---|---|
| `GROQ_API_KEY` | https://console.groq.com/keys | Free tier; Whisper turbo ~$0.04/h |
| `ELEVENLABS_API_KEY` | https://elevenlabs.io/app/settings/api-keys | Free tier has a monthly character quota |
| `OPENAI_API_KEY` (optional fallback) | https://platform.openai.com/api-keys | Paid |
| `CRYPTOPANIC_TOKEN` | https://cryptopanic.com/developers/api/ | Check which plan unlocks `/growth/v2` |
| `XAI_API_KEY` (optional) | https://console.x.ai | $5 / 1k posts fetched + tokens |
| RSS, Polymarket, Ethos | none | free |

## Unverified

- Groq `verbose_json` top-level `language` and `duration`: the docs page lists only segment fields. We read both defensively and compute the duration from the PCM when it is missing.
- Whether `pcm_16000` needs a paid ElevenLabs tier.
- Whether the free or "developer" CryptoPanic tier still exists. The probe says only `growth`, `growth_weekly` and `enterprise` paths are valid. The `votes` object on v2 responses comes from SDK docs, not a live response.
- Polymarket `order=volume24hr` as a valid order field (there is a retry without it), and the response shape against the live API, which we could not reach from India. The field names come from the Gamma OpenAPI mirror and the Polymarket `agents` repo.
- Whether the 0G Router exposes Whisper or MiniMax audio endpoints.

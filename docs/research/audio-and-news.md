# Audio (STT / TTS / ESP32) and news sources — developer notes

Researched 2026-11-05.

## Audio contract with the pod

| Direction | Format | Size |
|---|---|---|
| Pod → server | WAV: 44-byte header + PCM, 16 kHz, 16-bit, mono | 32 KB/s; 5 s ≈ 160 KB |
| Server → pod | Raw s16le, 16 kHz, mono, `application/octet-stream` | Streamed to I2S in 1–2 KB chunks |

Push-to-talk: hold button → record int16 into PSRAM → prepend WAV header → `HTTPClient` POST `Content-Type: audio/wav` → read `http.getStreamPtr()` → `playPcm16()`.

**Do not decode MP3 on the device.** ESP8266Audio is GPL and creates its own TX-only I2S channel, which clashes with our shared full-duplex port. The server must return raw PCM at 16 kHz.

## STT options

| Provider | Model | Price / notes | Pick |
|---|---|---|---|
| Groq | `whisper-large-v3-turbo` | ~$0.04/h, OpenAI-compatible `/audio/transcriptions` | **Default** (cheapest, fast) |
| OpenAI | `gpt-4o-mini-transcribe` | Paid | Backup |
| Deepgram | Nova-3 | Streaming | Only if we move to streaming upload |
| 0G | Whisper Large v3 | $0.00013/s; sponsor points | Use if the 0G Router exposes audio (UNVERIFIED) |

```ts
import OpenAI from 'openai';
// Groq is OpenAI-compatible; set baseURL from Groq's docs
const stt = new OpenAI({ baseURL: process.env.STT_BASE_URL, apiKey: process.env.GROQ_API_KEY });
const text = await stt.audio.transcriptions.create({
  model: 'whisper-large-v3-turbo',
  file: await OpenAI.toFile(wavBuffer, 'clip.wav'),
});
```

## TTS options

| Provider | Model | Output | Pick |
|---|---|---|---|
| ElevenLabs | `eleven_flash_v2_5` | `output_format=pcm_16000` → raw 16 kHz PCM straight to I2S | **Default** |
| OpenAI | `gpt-4o-mini-tts` | `pcm` is **24 kHz** → must resample to 16 kHz | Backup |
| 0G | MiniMax TTS | In catalogue; Router audio support UNVERIFIED | Optional |

Pre-render fixed phrases at startup ("brain offline", "Done.", "Cancelled.") so safe-stop works even if TTS is down.

## ESP32 audio notes (summary)

- One I2S port, full duplex, shared BCLK (GPIO14) / WS (GPIO15); DOUT GPIO12 → amp, DIN GPIO13 ← mic.
- 16 kHz, 32-bit slots. Speaker: `int16 << 16`. Mic: `int32 >> 14` → int16 (~4× gain).
- `ESP_I2S.h` only; legacy `driver/i2s.h` cannot coexist.
- Details and code: `firmware/` sketches and [../troubleshooting.md](../troubleshooting.md).

## News and signal sources

| Source | Access | Notes |
|---|---|---|
| CryptoPanic | https://cryptopanic.com/developers/api/ — free token | ~5 req/s; includes votes / sentiment |
| RSS: CoinDesk | `coindesk.com/arc/outboundfeeds/rss/` | From prior knowledge (UNVERIFIED) |
| RSS: Cointelegraph | `cointelegraph.com/rss` | From prior knowledge (UNVERIFIED) |
| RSS: The Block | `theblock.co/rss.xml` | From prior knowledge (UNVERIFIED) |
| RSS: Decrypt | `decrypt.co/feed` | From prior knowledge (UNVERIFIED) |
| Polymarket Gamma | `GET https://gamma-api.polymarket.com/events?limit=…` and `/markets`, no auth | Market odds as a "how likely" signal |
| NewsAPI.org | Free dev tier | Delayed; low priority |
| CoinGecko `/news` | Paid plan only | Skip |
| Grok `x_search` | Paid | See [ethos-grok.md](ethos-grok.md) |

### Provider interface

```ts
export interface NewsItem {
  id: string;
  source: string;          // 'cryptopanic' | 'rss:coindesk' | 'polymarket' | 'grok' ...
  text: string;
  url?: string;
  handle?: string;         // X handle, for Ethos
  address?: string;        // wallet, for Ethos
  ts: string;              // ISO
}
export interface NewsProvider {
  name: string;
  poll(since: Date): Promise<NewsItem[]>;
}
```

Dedupe by URL and normalised headline. Keep a demo "inject" path that pushes a canned headline so the live demo does not depend on real news timing.

## Unverified

- Whether the 0G Router exposes Whisper / MiniMax audio endpoints.
- The four RSS feed URLs (from prior knowledge, not fetched).
- Groq and ElevenLabs base URLs are intentionally not listed; take them from each provider's docs.
- Polymarket Gamma query parameters beyond `limit`.

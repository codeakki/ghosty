# Ethos + Grok — developer notes

Role: **optional credibility and news providers.** Neither is a sponsor. Both are built behind provider interfaces so the agent works without them. Researched 2026-11-05.

## Ethos Network (credibility score)

Gives a reputation score for an X handle or wallet address. We use it to weight news sources and posters before the 0G decision.

| Item | Value |
|---|---|
| Base URL | `https://api.ethos.network/api/v2` |
| Required header | `X-Ethos-Client: ghosty@0.1.0` |
| Score range | `0–2800`, response `{ score, level }` |
| Docs | https://developers.ethos.network, https://api.ethos.network/docs/llms-full.txt |

### Endpoints

| Method | Path | Use |
|---|---|---|
| GET | `/score/userkey?userkey=service:x.com:username:<handle>` | Score for an X handle |
| GET | `/score/address?address=0x…` | Score for a wallet |
| POST | `/score/userkeys` | Bulk, handles |
| POST | `/score/addresses` | Bulk, addresses |

```ts
const ETHOS = 'https://api.ethos.network/api/v2';
const h = { 'X-Ethos-Client': 'ghosty@0.1.0' };

export async function ethosScoreForHandle(handle: string) {
  const userkey = `service:x.com:username:${handle}`;
  const r = await fetch(`${ETHOS}/score/userkey?userkey=${encodeURIComponent(userkey)}`, { headers: h });
  if (!r.ok) return null;                       // optional provider: never block on it
  return (await r.json()) as { score: number; level: string };
}
```

### How we weight

- Normalise `score / 2800` into `0..1`, default `0.5` when unknown.
- Weight is an input to the 0G prompt, not a hard filter. The decision and its reasoning stay on 0G.
- Cache scores for the session; handles do not change score minute to minute.

## xAI Grok — X search

Live X posts for breaking events, faster than RSS.

| Item | Value |
|---|---|
| Endpoint | `POST https://api.x.ai/v1/responses` |
| Tool | `{ "type": "x_search" }` |
| Model | `grok-4.7` |
| Options | `allowed_x_handles` / `excluded_x_handles` (≤ 20), `from_date`, `to_date` |
| Pricing | $5 per 1k posts fetched, $10 per 1k profiles, plus tokens ($2/M in, $6/M out) |
| Docs | https://docs.x.ai/developers/tools/x-search, https://docs.x.ai/developers/models |

```ts
const r = await fetch('https://api.x.ai/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.XAI_API_KEY}` },
  body: JSON.stringify({
    model: 'grok-4.7',
    input: 'Breaking geopolitical news affecting oil, gold or BTC in the last hour. Return handles and links.',
    tools: [{ type: 'x_search' /* allowed_x_handles, from_date, to_date: placement UNVERIFIED */ }],
  }),
});
```

### Cost control

- Off by default (`GROK_ENABLED=false`).
- Restrict to an allowlist of ≤ 20 handles and a short date window.
- Poll on demand (voice "what's happening on X?") or every few minutes, not continuously.

## Pipeline

```
Grok x_search ─┐
RSS / CryptoPanic / Polymarket ─┼─> normalise {source, handle?, address?, text, ts}
                                │
                                └─> Ethos weight (if handle/address) ─> 0G decision
```

## Unverified

- A possible Ethos x402 route `/x402/score/{userkey}` (would be a nice Hedera tie-in if it exists).
- Exact placement of `allowed_x_handles`, `from_date`, `to_date` in the Grok request (inside the tool object vs top level).
- Request body field names for the Grok Responses API beyond `model` and `tools`.
- Auth header format for xAI (`Bearer` assumed).

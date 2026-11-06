# Demo script (90 seconds)

One presenter talks, one drives the laptop. The pod is worn (clip or lanyard) and visible to judges.

## Before judges arrive (checklist)

- [ ] Pod charged, on the 5V boost, WiFi on the 2.4 GHz hotspot, `/health` shows `safeStop: false`.
- [ ] Server running in a visible terminal with log lines for: transcript, 0G request ID, storage root hash, x402 tx ID, order ID.
- [ ] Browser tabs open: 0G storage explorer (https://storagescan-galileo.0g.ai), 0G chain explorer (https://chainscan-galileo.0g.ai), HashScan on the latest x402 tx, Hyperliquid UI (testnet or mainnet) on the positions tab, the Uniswap swap tx on the chain explorer, `FEEDBACK.md` on GitHub.
- [ ] The war alert does not depend on live news timing: trigger it via `POST /button` (the fake news feed already contains a geopolitical headline).
- [ ] Hyperliquid account funded; target market confirmed via `meta(dex:"xyz")` that morning.
- [ ] Backup video of the full flow on the laptop.

## Script

| Time | Say | Do | Judges see |
|---|---|---|---|
| 0:00–0:10 | "Ghosty is a wearable trading copilot. Private memory, its own wallet, one button. It is not a chatbot with a body: it decides, and it acts." | Hold up the pod. | Hardware: ESP32-CAM, mic, speaker, button. |
| 0:10–0:25 | "Ask it anything." | Hold button: "Ghosty, what's my exposure right now?" Release. | Pod answers out loud. Terminal shows transcript and the **0G Compute request ID**. |
| 0:25–0:40 | "It's always reading the news and checking who said it." | Trigger the war alert via `POST /button` (the fake news already contains a geopolitical headline). | Terminal: headline, Ethos weight, **x402 payment** for `/signal` settled on Hedera, then a 0G decision with request ID. |
| 0:40–0:55 | "Now it calls me." | Nothing; wait for the pod. | Pod speaks: "Conflict headline, credible sources. Long gold, short BTC. Press to confirm." Terminal shows the episode written to **0G Storage** with root hash. |
| 0:55–1:10 | "One press." | Press the button. | Terminal: Uniswap spot leg tx (USDC → PAXG or token → USDC), Hyperliquid order IDs. Pod says "Done." Switch to the Hyperliquid positions tab. |
| 1:10–1:20 | "And if its brain goes offline, it refuses to trade." | Kill 0G access (toggle env flag / block the Router host), press the button again. | Pod blinks red 3 times ("brain offline"). `/button` returns 503 `brain_offline`. `/health` shows `safeStop: true`. |
| 1:20–1:30 | "Everything it decided is on 0G Storage, every payment is on Hedera, the spot leg is on Uniswap. Links are in the README." | Show the evidence tabs briefly. | Explorer pages. |

## Fallback paths

| If | Then |
|---|---|
| **0G down** (Router or storage unreachable) | Make it the feature. Go straight to the safe-stop beat: pod blinks red 3 times, `/button` returns 503, no order is sent. Show prior request IDs and root hashes from the README as proof the loop ran earlier. Do not fake a decision. |
| **Hyperliquid testnet lacks the gold / oil perp** | Use the BTC perp on testnet (short BTC is part of the same playbook). Or switch the server to mainnet with minimum size; say so out loud. |
| Hyperliquid testnet fully unavailable | Mainnet, minimum size, pre-approved API wallet. |
| x402 facilitator slow or down | Switch to another listed testnet facilitator (see [research/hedera-x402.md](research/hedera-x402.md)). If all fail, show the earlier settled tx ID on HashScan from the README. |
| Uniswap testnet pair has no liquidity | Use the pre-tested pair. If none works, show the pre-recorded swap tx and skip the spot leg live (perp still fires). |
| Venue WiFi blocks the pod | Phone hotspot (2.4 GHz). |
| Pod browns out or audio dies | Run the same flow with `curl` against `/voice` and `/button` (see [api.md](api.md)) and play the reply on the laptop. Then show the backup video of the hardware. |
| STT mishears | Repeat once. If it fails twice, use the `POST /button` path, which does not need speech. |

## Evidence to show per track

| Track | Evidence | Where |
|---|---|---|
| 0G Physical AI | 0G Compute **request IDs** per decision; **storage root hashes** of the episode log; the safe-stop beat; live hardware | Server log, storage explorer, README "Evidence" table |
| Hedera x402 | Settled **tx ID** for an autonomous Signal Desk intel payment with **HashScan link**, the HCS audit topic, `GET /x402/status` showing `verified: true`; architecture + payment flow diagram; video ≤5 min | README, [hedera.md](hedera.md) |
| Uniswap | Swap **tx hash** from the Trading API spot leg; README pointer to the exact lines in `server/src/wallet/uniswap.ts`; **FEEDBACK.md**; feedback form submitted | Chain explorer, GitHub |
| Hyperliquid (venue, not a track) | Order ID / fill on the positions tab | Hyperliquid UI |

Record every ID as it happens during rehearsal and paste them into the README evidence table, so the fallback paths always have something real to point to.

## Videos

- 0G submission video: **under 3 minutes**.
- Hedera submission video: **5 minutes or less**, must show the HashScan link.
- One recording can serve both if it stays under 3 minutes.

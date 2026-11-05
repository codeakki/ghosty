# Prize tracks (ETHGlobal Mumbai, Nov 6–8 2026)

Source: https://ethglobal.com/events/mumbai/prizes, fetched 2026-11-05. Requirements are close paraphrases; re-read the official page before submitting.

## Corrections to the original brief

- The sponsor is **Arkiv**, not "Arkive".
- **Swarm** is not a sponsor. It is a $500 bonus that stacks on an Arkiv track; Swarm alone does not qualify.
- **Hyperliquid, Ethos Network, xAI/Grok** are not sponsors. We still use them: Hyperliquid as the main execution venue, Ethos and Grok as optional credibility/news providers.
- Possible limit: Arkiv's section mentions "three partner-prize picks". Not confirmed in the official rules (UNVERIFIED).

## All tracks

"Cont." = Continuity (existing projects only).

| Sponsor | Track | Prize | Requirements |
|---|---|---|---|
| ETHGlobal | Finalist (top 10) | $250–$1,000/person + travel | Be a finalist |
| World | World ID Agent Pass | $5,000 | Agent Pass guarding a human-verification action; server-side checks; debrief |
| World | Best Use of IDKit | $2,500 | IDKit with minimal credential; server/onchain verification |
| 1inch | Build an Aqua App | $5,000 | Official Aqua/SwapVM contracts; onchain transfers in demo; real git history |
| 0G | Build with 0G Private Computer | $5,000 | Consumer app with 0G inference in main flow + request IDs; "what breaks without 0G" line |
| 0G | **Physical AI: Agents with a Body** | $5,000 (2.5k / 1.5k + $1k best real hardware) | 0G call in decision loop; episode log on 0G Storage with request ID per decision; replayable sim or live hardware demo; safe-stop fallback; NOT a chatbot with a body; NOT 0G only for logs |
| 0G | Keep Building (Cont.) | $3,000 | Prior state, dated changelog |
| 0G | Agents That Pay for Themselves | $2,000 | Agent earns money and pays for its own 0G Compute; no human top-ups; spend cap |
| Uniswap | **Build with Uniswap** | $10,000 (4k / 3k / 2k / 1k) | Any part of the Uniswap stack (API, v2/v3/v4, hooks, CCA); public repo; FEEDBACK.md; feedback form; README pointing to the exact code |
| Arc (Circle) | 5 tracks | $3,000 each | All built in Arc Studio; USDC/EURC settlement |
| Hedera | **AI Agents That Pay: x402 on Hedera** | $6,500 (3k / 2k / 1.5k) | x402 endpoint settling on Hedera (testnet ok) via a listed facilitator; agent pays ≥1 time with no human approval; repo with tx ID + architecture + payment flow; video ≤5 min with HashScan link. Extra credit: spend caps/allowlists, HCS-14/ERC-8004 identity, HCS audit topic, USDC via HTS, Scheduled Tx, Agent Kit / Hedera MCP |
| Hedera | Tokenize Anything (ATS / Stablecoin Studio) | $5,000 | Testnet issuance + lifecycle op video |
| Hedera | No Solidity Allowed (SDKs) | $2,000 | JS/TS or Python SDK; ≥2 native services (HTS + HCS); README; video |
| Arkiv | Mirror something Ethereum depends on | $4,000 | Public data mirrored as queryable entities |
| Arkiv | Build on Arkiv (from scratch) | $4,000 | Writes to Arkiv testnet; ≥1 user-visible feature reads from Arkiv; `/arkiv/*.md` files |
| Arkiv | Node tooling | $2,000 | Operator dashboard / slow-query finder |
| Arkiv | **Arkiv + Swarm bonus** | $500 | Real use of both; `/arkiv/swarm.md`; stacks on an Arkiv track; Swarm alone does not qualify |
| Whitechain | 4 tracks | $3–5k | Verified contracts on Whitechain Sepolia; USDT settled; `WHITECHAIN_FEEDBACK.md` |
| Ethereum Foundation | Best Use of Anon-RPC | $5,000 | App routes RPC reads via Anon-RPC by default; open source + CROPS README section |
| EF | Frame Tx Alternative Mempool | $5,000 | Devnet admitted-transaction link |
| EF | Best CROPS App | $3,500 | One CROPS property (censorship resistance, open source, privacy, security) is the app's reason to exist; video ≤3 min |
| ENS | Best Use of ENSv2 | $7,000 | ENSv2 central; live demo; open source |
| Definitive | Flash Advanced Orders in a Social App | $2,500 | Flash API/MCP advanced orders; onchain execution in demo; video on Discord + X tagging @DefinitiveFi |
| Chainlink | CRE workflow / CCIP 2.0 | $1,500 / $3,500 | CRE workflow; CCIP changing onchain state |

## Our picks

| # | Track | Prize | Why it fits |
|---|---|---|---|
| 1 | **0G — Physical AI: Agents with a Body** | $5,000 (+$1k best real hardware) | A real wearable. The decision loop runs on 0G Compute, memory and the episode log live on 0G Storage. Most entrants will bring sims; we bring hardware. This track dictates where memory lives (0G Storage, not Arkiv/Swarm). |
| 2 | **Hedera — AI Agents That Pay: x402** | $6,500 | "Device pays per AI call from its own wallet" is the brief. Our server exposes an x402-paywalled `/signal`; the agent wallet pays without human approval. |
| 3 | **Uniswap — Build with Uniswap** | $10,000 (4 winners) | Rule only requires "any part of the stack" + FEEDBACK.md. One real spot leg of the panic flow runs through the Trading API (wallet tokens → USDC before funding perps, or USDC → PAXG safe haven). |
| exec | **Hyperliquid** (not a sponsor) | — | Main execution venue. HIP-3 markets on trade.xyz (`dex:"xyz"`): perps on stocks, indices, gold, silver, oil, 24/7, same API as crypto perps. Uniswap cannot short or trade stocks at usable liquidity. |
| stretch | **Arkiv "Build from scratch" + Swarm bonus** | $4,000 + $500 | Arkiv as a public, queryable, expiring **market-event index** (never private memory); Swarm for an encrypted blob archive. Only after 1–3 are done. |
| stretch | **EF — Best Use of Anon-RPC** | $5,000 | Route the agent's chain reads through Anon-RPC. Low effort. |

### Set aside

| Track | Reason |
|---|---|
| 0G Agents That Pay for Themselves | Agent must *earn* its money; trading its own token is excluded. We do not have an honest revenue loop. |
| Definitive Flash social app | Needs posting to X and a social app surface. Off-product. |
| EF Best CROPS App (privacy) | Our server sees audio and trades. Would need device-held keys, TEE inference and no analytics. |

## Qualification checklists

### 1. 0G Physical AI: Agents with a Body

- [ ] 0G Compute call **inside** the decision loop (not only for logging)
- [ ] Request ID recorded for every decision
- [ ] Episode log entry per decision on **0G Storage** (input, request ID, output, action) with root hash
- [ ] Memory stored on 0G Storage, encrypted
- [ ] Live hardware demo (or replayable sim as backup)
- [ ] **Safe-stop**: 0G unreachable → "brain offline", no trade, no faked decision
- [ ] "What breaks without 0G" line in README
- [ ] Not on the "not wanted" list: not a chatbot with a body, not 0G only for logs
- [ ] Submission: public repo, README, video **< 3 min**, live link, contract addresses (if any), team Telegram / X

### 2. Hedera x402

- [x] x402 endpoint (`GET /signal`) settling on `hedera:testnet` through a listed facilitator. Evidence: `server/src/payments/x402Server.ts` (`registerPaidRoutes`; `@x402/core` resource server + `@x402/hedera` exact scheme, facilitator `https://x402.org/facilitator`); 402 payload in [api.md](api.md#get-signal-x402-on-hedera); tests in `server/test/x402.test.ts`. Live settlement needs a funded account (see next item).
- [ ] Agent wallet pays at least once with **no human approval**. Code done: `server/src/payments/x402Client.ts` (`@x402/fetch` + Hedera signer). To finish: fund two testnet accounts, run `npm run x402:demo`, and a row lands in [evidence.md](evidence.md).
- [ ] Settled **tx ID** in README with HashScan link (copy the first row of [evidence.md](evidence.md))
- [ ] Architecture + payment-flow diagram in README (flow diagram ready in [api.md](api.md#get-signal-x402-on-hedera))
- [ ] Video **≤ 5 min** showing the HashScan link
- [x] Extra credit: spend controls, done in `server/src/payments/spendControls.ts` + `x402Client.ts`. Covers the host allowlist `X402_ALLOWED_HOSTS`, the per-call cap `X402_MAX_PER_CALL_TINYBAR` and the daily cap `X402_MAX_SPEND_TINYBAR`, persisted in `server/.ghosty/spend.json`. The agent also refuses to pay its own account.
- [x] Extra credit: HCS audit topic, done in `server/src/payments/hcsAudit.ts`. Each payment and each trade decision becomes one message; the topic link is printed by `x402:demo`. Not yet run on testnet.
- [ ] Extra credit, not done: USDC via HTS, Agent Kit

### 3. Uniswap

- [ ] At least one real call path through the Uniswap stack (Trading API: `check_approval` → `quote` → `swap`, signed with viem)
- [ ] A real swap tx hash from the demo
- [ ] Public repo
- [ ] `FEEDBACK.md` filled with real friction we hit
- [ ] Feedback form submitted: https://developers.uniswap.org/hackathon-feedback
- [ ] README points at the exact Uniswap code lines (file + line range)

### Stretch: Arkiv from scratch + Swarm bonus

- [ ] Writes to Arkiv testnet (Rabdi)
- [ ] At least one user-visible feature reads from Arkiv (e.g. "recent market events" list)
- [ ] `/arkiv/*.md` docs in the repo
- [ ] No plaintext trade history and no encrypted Swarm refs in Arkiv entities (refs contain keys)
- [ ] Swarm bonus: real use of Swarm + `/arkiv/swarm.md`
- [ ] Confirm the "three partner picks" limit before adding a fourth sponsor

### Stretch: EF Anon-RPC

- [ ] All chain reads routed through Anon-RPC by default
- [ ] Open-source license (MIT, in repo)
- [ ] CROPS section in README

## Submission checklist

- [ ] Repo is **public**: `codeakki/ghosty`
- [ ] README: pitch, diagram, how it works, BOM, quick starts, tracks, "what breaks without 0G", evidence table (request IDs, root hashes, tx IDs)
- [ ] Demo video: **< 3 min** for 0G, **≤ 5 min** for Hedera (with HashScan link)
- [ ] Live link (server URL or hosted status page)
- [ ] Contract addresses / account IDs: agent EVM address, Hedera account `0.0.X`, Hyperliquid master address, any deployed contracts
- [ ] `FEEDBACK.md` + Uniswap feedback form
- [ ] `/arkiv/*.md` (only if the Arkiv stretch is pursued)
- [ ] Team Telegram / X handles
- [ ] No secrets in git history (`secrets.h`, `.env`)

## Doc URLs

| Sponsor | Links |
|---|---|
| 0G | https://docs.0g.ai, https://pc.0g.ai, https://pc.0g.ai/models, https://build.0g.ai, https://faucet.0g.ai, https://github.com/0gfoundation/zerobot |
| Hedera | https://docs.hedera.com/solutions/ai/x402 (+ `/how-it-works`, `/pay-with-x402`, `/merchant-integration`, `/facilitators`, `/exact-scheme`), https://github.com/x402-foundation/x402, https://docs.hedera.com/solutions/ai/agent-kit, https://docs.hedera.com/solutions/ai/hosted-mcp-server, https://portal.hedera.com, https://portal.hedera.com/faucet |
| Uniswap | https://developers.uniswap.org/docs, https://developers.uniswap.org/dashboard/welcome, https://developers.uniswap.org/hackathon-feedback |
| Arkiv / Swarm | https://docs.arkiv.network, https://hub.arkiv.network, https://github.com/Arkiv-Network/arkiv, https://docs.ethswarm.org |
| EF | https://ethereum.github.io/anon-rpc/, https://github.com/ethereum/anon-rpc, https://blog.ethereum.org/2026/03/13/ef-mandate |
| Definitive | https://flash.definitive.fi/docs |
| Ethos | https://developers.ethos.network, https://api.ethos.network/docs/llms-full.txt |
| xAI | https://docs.x.ai/developers/tools/x-search, https://docs.x.ai/developers/models |

Developer notes per integration: [research/](research/).

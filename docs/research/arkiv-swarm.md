# Arkiv + Swarm — developer notes

Stretch track: **Arkiv "Build on Arkiv (from scratch)"** ($4,000) + **Arkiv + Swarm bonus** ($500). Only after the 0G, Hedera and Uniswap work is done. Researched 2026-11-05.

## Naming

- The sponsor is **Arkiv** (Golem's "DB-chain"), not "Arkive".
- **Swarm** is not a sponsor. It is a bonus that stacks on an Arkiv track; Swarm alone does not qualify.
- Arkiv's section mentions a possible "three partner-prize picks" limit. UNVERIFIED in official rules; confirm before adding Arkiv as a fourth sponsor.

## Where it fits in Ghosty

| Store | Visibility | Use for | Never use for |
|---|---|---|---|
| 0G Storage | Encrypted | Private memory, episode log (primary) | — |
| Arkiv | **Public**, queryable, expiring | Market-event index: `{kind:"war", ts, sources, credibility}` | Trade history, user memory, encrypted Swarm refs |
| Swarm | Encrypted client-side | Archive of raw event blobs (article snapshots) | Anything we have not encrypted ourselves |

**Rules:** Arkiv entities are public; never write plaintext trade history there. Do not store encrypted Swarm references in Arkiv entities, because encrypted refs contain the decryption key.

## Arkiv

### Network (testnet "Rabdi")

| Item | Value |
|---|---|
| RPC | https://rpc.rabdi.db-chain.testnet.arkiv.network |
| Chain ID | `7794095` |
| Explorer | https://rabdi.explorer.arkiv.network |
| Gas token | tGLM |
| Faucet | https://hub.arkiv.network/faucet |
| Access key | https://hub.arkiv.network/access-keys |
| Docs | https://docs.arkiv.network, https://hub.arkiv.network, https://github.com/Arkiv-Network/arkiv |

### SDK

`@arkiv-network/sdk` + `viem`. Node **22.10+**, ESM only.

```ts
import { createWalletClient, createPublicClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { defineSchema, str, bytes } from '@arkiv-network/sdk/schema';
import { http } from 'viem';

const Ev = defineSchema('ghosty.event', { kind: str().indexed(), blob: bytes() });
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY! });

const wc = createWalletClient({ chain, transport: http(), account });
await wc.createEntity(Ev, { kind: 'war', blob }, { expiration: ExpirationTime.fromDays(30) });
```

No built-in encryption.

### Qualification (Build from scratch)

- [ ] Writes to Arkiv testnet
- [ ] ≥ 1 user-visible feature reads from Arkiv (e.g. pod: "what happened in the last hour?" answered from the Arkiv index; or a web list)
- [ ] `/arkiv/*.md` docs in repo

## Swarm

Package `@ethersphere/bee-js` (Bee 2.5+). Docs: https://docs.ethswarm.org

| Option | Notes |
|---|---|
| Public gateway, no stamp | `new Bee(SWARM_GATEWAY_URL).uploadData(NULL_STAMP, data)` — UNVERIFIED that this still works |
| Beeport | https://beeport.ethswarm.org — hosted, buy a postage stamp |
| `bee-factory` | Local docker cluster, API on `:1633` |
| Light node on mainnet | Fund via fund.ethswarm.org |

- Native encryption (`Swarm-Encrypt: true`) and ACT need your own Bee node. Easier: **encrypt client-side** (AES-GCM) and upload ciphertext.
- No free hackathon stamp found. Ask the booth.

### Qualification (bonus)

- [ ] Real use of both Arkiv and Swarm
- [ ] `/arkiv/swarm.md` in repo
- [ ] Stacked on an Arkiv track

## Unverified

- Whether gateway upload with `NULL_STAMP` still works without a stamp.
- The "three partner-prize picks" limit.
- `ExpirationTime.fromDays` and schema helper names beyond the snippet above (taken from docs research, not run).
- Exact Swarm funding URL path (fund.ethswarm.org was noted without scheme).

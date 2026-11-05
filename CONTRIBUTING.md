# Contributing to Ghosty

Hackathon speed, but with a clean history. Read this once before your first commit.

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <short imperative summary>
```

| Type | Use for |
|---|---|
| `feat` | New behavior |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `chore` | Tooling, config, housekeeping |
| `refactor` | Code change with no behavior change |
| `test` | Tests only |

| Scope | Area |
|---|---|
| `fw` | `firmware/` (sketches, GhostyBoard library) |
| `server` | `server/` |
| `hw` | `hardware/` (BOM, wiring, photos) |
| `docs` | `docs/`, README, PLAN |
| `ci` | `.github/` workflows and templates |

Examples:

```
feat(fw): add 03_MicTest RMS meter
fix(fw): keep GPIO12 low at boot in 04_SpeakerTest
feat(server): stream TTS reply as s16le PCM
feat(server): log 0G request ID in episode record
docs(hw): add boost converter to wiring guide
chore(ci): pin esp32 core to 3.3.12
```

Rules:

- **One logical change per commit.** If the summary needs "and", split it.
- Keep commits small. Each commit should compile (firmware) or lint and typecheck (server) on its own.
- Summary in the imperative, lowercase, no trailing period, under 72 characters.

## Branches

```
feat/<scope>-<slug>     feat/fw-mic-test, feat/server-x402-client
fix/<scope>-<slug>      fix/fw-gpio12-boot
docs/<slug>             docs/demo-script
```

Branch from `main`, open a PR back to `main`. No branch protection during the hackathon, but always go through a PR so the template checklist gets read.

## Pull requests

- Title follows the commit format (`feat(server): ...`).
- Link the issue (`Closes #12`).
- Fill in the PR template checklist:
  - [ ] Conventional title
  - [ ] Firmware compiles, or server passes `npm test` / lint / typecheck
  - [ ] Tested on hardware (firmware) or locally (server), with a note on how
  - [ ] No secrets committed
  - [ ] Docs updated (README, `docs/`, `hardware/`) if behavior or wiring changed
- One reviewer is enough. Self-merge is fine if the change is small and CI is green.

## Secrets policy

- **Never commit** `firmware/**/secrets.h`, `.env`, or any `.env.*` other than `.env.example`. They are in `.gitignore`.
- Copy from the examples: `secrets.h.example` → `secrets.h`, `server/.env.example` → `server/.env`.
- When you add a new key, add a placeholder line to the matching example file in the same PR.
- Use testnet keys and burner wallets. The Hyperliquid mainnet fallback uses an API (agent) wallet, never the master key.
- If a secret is ever pushed: rotate it immediately, then tell the team. Rewriting history does not un-leak it.

## Running CI locally

**Server** (matches `.github/workflows/server.yml`):

```bash
cd server
npm ci
npm run lint
npx tsc --noEmit
npm test        # if tests exist
```

**Firmware** (matches `.github/workflows/firmware.yml`, needs `arduino-cli`):

```bash
arduino-cli core install esp32:esp32@3.3.12 \
  --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
cp firmware/libraries/GhostyBoard/src/secrets.h.example firmware/libraries/GhostyBoard/src/secrets.h
for s in firmware/sketches/*/; do
  arduino-cli compile --fqbn esp32:esp32:esp32cam \
    --library firmware/libraries/GhostyBoard "$s" || exit 1
done
```

In Arduino IDE, opening a sketch and pressing *Verify* is the same check.

## Issue labels

| Label | Meaning |
|---|---|
| `fw`, `server`, `hw`, `docs`, `ci` | Area (same as commit scopes) |
| `track:0g`, `track:hedera`, `track:uniswap`, `track:arkiv` | Counts toward a prize track |
| `venue:hyperliquid` | Hyperliquid execution work |
| `P0` | Needed for the demo |
| `P1` | Nice to have |
| `blocked` | Waiting on hardware, funds, keys, or another issue |

Every issue uses the task template and has acceptance criteria. Put it under a milestone (M0–M5, see [PLAN.md](PLAN.md)).

## Adding a sketch

1. Pick the next number: `firmware/sketches/NN_Name/NN_Name.ino`. The folder name **must** equal the `.ino` name.
2. `#include <GhostyBoard.h>` for pins and secrets. Do not use relative includes like `../shared/pins.h`; the IDE copies sketches to a temp folder and they break.
3. New pins go in `firmware/libraries/GhostyBoard/src/pins.h`, not in the sketch.
4. Follow the wiring rules in [hardware/wiring.md](hardware/wiring.md): nothing drives GPIO12 HIGH at reset, button on GPIO2 → GND, never `SD_MMC.begin()`.
5. Use `ESP_I2S.h` (new driver). Do not mix with legacy `driver/i2s.h`.
6. Add a row to the sketch roadmap table in the README.
7. CI compiles every folder under `firmware/sketches/` automatically.

## Adding a server provider

Providers live under `server/src/<area>/` (`news`, `credibility`, `audio`, `agent`, `payments`, `wallet`, `execution`).

1. Implement the area's existing interface in a new file, for example `server/src/news/newsapi.ts`.
2. Start with a deterministic stub so `npm run dev` works with no key. Mark real-SDK work with `// TODO(track): ...`.
3. Read config from `server/src/config.ts`; add any new env var to `server/.env.example`.
4. The provider must fail closed: if a required service is down, return an error that the safe-stop path can handle. Never return a fake trading decision.
5. Register it where the area's providers are wired up and document it in [docs/architecture.md](docs/architecture.md).

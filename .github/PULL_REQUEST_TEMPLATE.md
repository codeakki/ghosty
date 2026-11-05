## What

<!-- One or two sentences. -->

Closes #

## How it was tested

<!-- Board + power source for firmware; commands for server. -->

## Checklist

- [ ] Title follows Conventional Commits (`feat(fw): ...`, scopes `fw|server|hw|docs|ci`)
- [ ] Firmware compiles / server passes `npm run lint`, `npx tsc --noEmit`, `npm test`
- [ ] Tested on hardware (firmware) or locally (server)
- [ ] No secrets committed (`secrets.h`, `.env`, private keys, WiFi passwords)
- [ ] Docs updated if behavior, pins, or API changed (README, `docs/`, `hardware/`)
- [ ] Linked issue

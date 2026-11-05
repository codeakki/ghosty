# Uniswap feedback

Feedback for the ETHGlobal Mumbai "Build with Uniswap" track. Form: https://developers.uniswap.org/hackathon-feedback

## What we used

- **Uniswap Trading API** (`https://trade-api.gateway.uniswap.org/v1`): `POST /check_approval` → `POST /quote` → `POST /swap`, then sign and send with viem.
- Purpose: the spot leg of Ghosty's trade flow. Either swap wallet tokens → USDC before funding the Hyperliquid perp account, or swap USDC → PAXG as a safe-haven on a geopolitical-shock signal.
- Chain: _TODO (Base Sepolia / Unichain Sepolia / mainnet small size)_
- Code: [`server/src/wallet/uniswap.ts`](server/src/wallet/uniswap.ts) — _TODO: add exact line links once implemented_
- Tx hash from the demo: _TODO_

## What worked

- TODO
- TODO

## What was confusing

- TODO
- TODO

## Suggestions

- TODO
- TODO

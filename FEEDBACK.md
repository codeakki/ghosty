# Uniswap feedback

Feedback for the ETHGlobal Mumbai "Build with Uniswap" track. Form: https://developers.uniswap.org/hackathon-feedback

**Status (2026-11-07):** the swap path is built and verified against the live Trading API on Base mainnet, up to an unsigned `/swap` transaction. A real broadcast swap happens when the wearer confirms an alert on the device. Its tx link goes into [docs/evidence.md](docs/evidence.md) when that happens.

## Setup we used

- **API:** Uniswap Trading API (`https://trade-api.gateway.uniswap.org/v1`), with an `x-api-key` header.
- **Chain:** Base mainnet (`EVM_CHAIN_ID=8453`). Base Sepolia (84532) is still the code default; mainnet is set in our `.env`.
- **Pair:** native ETH (`0x0000000000000000000000000000000000000000`) to USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
- **Size:** 0.0003 ETH per confirmed trade (`UNISWAP_DEMO_AMOUNT=300000000000000`), slippage 1% (`UNISWAP_SLIPPAGE_PCT=1`).
- **Switch:** `UNISWAP_SPOT_LEG=true`, so the spot leg runs before the Hyperliquid perp legs.
- **Flow:** `POST /check_approval`, send any approval tx it returns, `POST /quote`, sign `permitData` if present, `POST /swap`, then sign, send and wait for the receipt with viem.
- **Routing:** we send `protocols: ["V2","V3","V4"]`, so the answer is always a gasful `CLASSIC` swap with a plain tx hash we can show. UniswapX would need `/order` instead.

## Verified results (2026-11-07, read-only calls on Base mainnet)

| Step | What came back |
| --- | --- |
| `/check_approval` | `approval: null`, `cancel: null` (native ETH needs no approval) |
| `/quote` routing | `CLASSIC`, `[v3]` 100% through the 0.01% pool `0xb4CB…00e5` |
| `/quote` output | `amountOut` 668852 (0.668852 USDC), minimum 0.662163 USDC at 1% slippage |
| Price impact | 0.01% |
| Gas estimate | 121,853 units (about $0.0016) |
| `permitData` | `null` for native ETH, so no Permit2 signature was needed |
| `/swap` | unsigned tx with `value` exactly 3e14 wei (`0x0110d9316ec000`), `gasLimit` 158,408 |

We stopped before signing on purpose. The broadcast is tied to a real wearer confirmation, not a script.

## Code

All in [`server/src/wallet/uniswap.ts`](server/src/wallet/uniswap.ts) unless noted.

- [`UniswapSpotLeg.quoteAndSwap`, L178-L241](server/src/wallet/uniswap.ts#L178-L241): the whole flow.
  - [L184-L196](server/src/wallet/uniswap.ts#L184-L196): `/check_approval`, then send the `cancel` (revoke) and `approval` txs if returned.
  - [L198-L213](server/src/wallet/uniswap.ts#L198-L213): `/quote`, `EXACT_INPUT`, AMM-only, and reject any routing other than `CLASSIC`/`WRAP`/`UNWRAP`.
  - [L215-L226](server/src/wallet/uniswap.ts#L215-L226): sign `permitData` (EIP-712) with viem when the quote has one.
  - [L228-L230](server/src/wallet/uniswap.ts#L228-L230): `/swap`, then sign, send and wait.
- [L141-L148](server/src/wallet/uniswap.ts#L141-L148): `primaryTypeOf`, which infers the EIP-712 primary type that `permitData` leaves out.
- [L150-L163](server/src/wallet/uniswap.ts#L150-L163): checks on every API-built tx before broadcast (valid `to`, non-empty `data`, matching `chainId`).
- [L243-L248](server/src/wallet/uniswap.ts#L243-L248): send and wait for the receipt; a reverted tx is an error.
- [L250-L259](server/src/wallet/uniswap.ts#L250-L259): `x-api-key` header and error handling.
- [L262-L290](server/src/wallet/uniswap.ts#L262-L290): factory that wires the viem wallet from [`server/src/wallet/account.ts`](server/src/wallet/account.ts#L11) (Base, Base Sepolia, Unichain, Unichain Sepolia, Sepolia, mainnet).
- Spot leg before perps: [`executePlan` in `server/src/execution/executor.ts`, L24-L50](server/src/execution/executor.ts#L24-L50). A failed spot leg is recorded and the perp legs still run.
- Plan step: [`planSteps` in `server/src/execution/playbook.ts`, L146-L164](server/src/execution/playbook.ts#L146-L164).
- Config keys (`UNISWAP_API_KEY`, `UNISWAP_API_URL`, `UNISWAP_SPOT_LEG`, `UNISWAP_DEMO_TOKEN_IN`, `UNISWAP_DEMO_TOKEN_OUT`, `UNISWAP_DEMO_AMOUNT`, `UNISWAP_SLIPPAGE_PCT`): [`server/src/config.ts`, L165-L176](server/src/config.ts#L165-L176). Chain: [L181](server/src/config.ts#L181).
- Tests: [`server/test/uniswap.test.ts`](server/test/uniswap.test.ts) (approval path, no-approval path, revoke then approve, API errors, UniswapX routing, empty calldata, wrong chain, reverted swap, primary type inference).

## What worked

- One flow (`check_approval`, `quote`, `swap`) covers approval, pricing and calldata. We never had to encode Universal Router commands ourselves.
- The OpenAPI spec at `https://trade-api.gateway.uniswap.org/v1/api.json` is complete and machine-readable. It answered every field-name question the guides left open (for example, `ApprovalResponse` has both `approval` and `cancel`).
- `/check_approval` returns a ready transaction only when one is needed. For native ETH both fields came back `null`, so the "nothing to approve" path needs no special case.
- For native ETH the quote had no `permitData`, and the `/swap` tx carried the exact input amount as `value`. Easy to check before signing.
- The docs say plainly which routings go to `/swap` and which go to `/order`, and that `protocols` can pin AMM-only routing.
- Quotes on Base mainnet were fast and tight: 0.01% price impact on a tiny trade, routed through a single V3 pool.

## What was confusing

- **Two approvals, three steps.** The landing-page flow says "check approval, quote, swap", but with Permit2 there is also an EIP-712 signature between quote and swap. `/swap` fails validation unless you send both `signature` and `permitData`, or neither. This is only clear from the integration guide's "WRONG" examples.
- **`permitData` has no `primaryType`.** The API returns `domain`, `types` and `values`, but most libraries (viem included) need `primaryType` too. The guide warns that "the API does not return every field some libraries expect". We infer it as the one type no other type references (`PermitSingle`).
- **UniswapX is not on testnets.** Without `protocols: ["V2","V3","V4"]` a quote can come back as a UniswapX routing that needs `/order`, which gives no plain tx hash. We restrict to V2/V3/V4 so every confirmed trade has a hash to show.
- **The no-Permit2 proxy is not on Base Sepolia.** The `x-permit2-disabled` proxy is deployed on Unichain Sepolia, Sepolia and Monad testnet, not Base Sepolia. Supported Chains lists Base Sepolia as available, so you only learn this from the proxy page's table.
- **Thin testnet liquidity.** WETH/USDC on Base Sepolia is thin, so testnet quotes are not a good preview of real behaviour. This is one reason we verified on Base mainnet with a tiny amount.
- **`/quote` sometimes already contains the swap tx** (`swapTransaction`, when no permit is needed), which makes `/swap` optional. The quickstart still calls `/swap` every time, so it is unclear which path is preferred.
- **Error shapes differ.** The integration guide shows `{ error, message, details }`, the 404 schema uses `errorCode`, and the Universal Router balance section mentions `detail`. We log the raw body.
- **Code examples use ethers v5** (`_signTypedData`, `BigNumber`), which is deprecated.

## Suggestions

- **A native-ETH, server-side signing example.** Show ETH to USDC from a backend wallet with viem: `check_approval` returning nulls, a quote with no `permitData`, and a `/swap` tx whose `value` is the input amount. That is the simplest real path and the docs do not show it end to end.
- **A per-chain feature table.** One table on Supported Chains listing, for each chain and testnet, whether UniswapX, the no-Permit2 proxy and Permit2 flows are available.
- **Include `primaryType` in `permitData`,** so it can be passed straight to `signTypedData` without inferring it.
- Publish which testnet pairs have usable liquidity, or return a specific `errorCode` for "pool exists but has no liquidity".
- Use one error schema (`errorCode` plus `detail`) on all endpoints.

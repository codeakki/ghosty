# Uniswap feedback

Feedback for the ETHGlobal Mumbai "Build with Uniswap" track. Form: https://developers.uniswap.org/hackathon-feedback

Status: code written and unit-tested against mocked API responses (2026-11-06). Items marked **TODO (live)** wait on a Trading API key and a funded Base Sepolia wallet.

## What we used

- **Uniswap Trading API** (`https://trade-api.gateway.uniswap.org/v1`): `POST /check_approval` → approval tx (if any) → `POST /quote` → Permit2 signature (if `permitData`) → `POST /swap` → sign, send and wait for the receipt with viem.
- Purpose: the spot leg of Ghosty's trade flow. On a confirmed trade it runs **before** the Hyperliquid perp legs. Demo pair: WETH → USDC (wallet tokens → USDC, the collateral the perps use).
- Chain: Base Sepolia (84532) by default, configurable with `EVM_CHAIN_ID` (Unichain Sepolia 1301 and Sepolia 11155111 also work in the API).
- Routing: we send `protocols: ["V2","V3","V4"]` so the answer is always a gasful `CLASSIC` swap with a tx hash we can show. UniswapX is not on the testnets and would need `/order` instead.
- Code (`server/src/wallet/uniswap.ts`):
  - [`UniswapSpotLeg.quoteAndSwap`, L176–L239](server/src/wallet/uniswap.ts#L176-L239): the whole flow.
    - [L182–L194](server/src/wallet/uniswap.ts#L182-L194): `/check_approval`, then send `cancel` (revoke) and `approval` txs if returned.
    - [L196–L210](server/src/wallet/uniswap.ts#L196-L210): `/quote`, `EXACT_INPUT`, AMM-only.
    - [L212–L224](server/src/wallet/uniswap.ts#L212-L224): sign `permitData` (EIP-712) with viem.
    - [L226–L228](server/src/wallet/uniswap.ts#L226-L228): `/swap`, then sign + send + wait.
  - [L148–L162](server/src/wallet/uniswap.ts#L148-L162): checks on every API-built tx before broadcast (valid `to`, non-empty `data`, matching `chainId`).
  - [L248–L257](server/src/wallet/uniswap.ts#L248-L257): `x-api-key` header and error handling.
  - [L261–L283](server/src/wallet/uniswap.ts#L261-L283): factory that wires the viem wallet (`server/src/wallet/account.ts`).
- Execution order (spot first, then perps): [`server/src/execution/executor.ts` L29–L50](server/src/execution/executor.ts#L29-L50); plan step: [`planSteps` in `server/src/execution/playbook.ts`](server/src/execution/playbook.ts#L128).
- Tests: [`server/test/uniswap.test.ts`](server/test/uniswap.test.ts) (approval path, no-approval path, revoke + approve, API errors, UniswapX routing, empty calldata, wrong chain, reverted swap).
- Tx hash from the demo: **TODO (live)**

## What worked

- One flow (`check_approval` → `quote` → `swap`) covers approve, quote and calldata. We did not have to encode Universal Router commands ourselves.
- The OpenAPI spec at `https://trade-api.gateway.uniswap.org/v1/api.json` is complete and machine-readable. It answered every field-name question the guides left open (for example `ApprovalResponse` has both `approval` and `cancel`).
- `/check_approval` returns a ready transaction only when one is needed, so the "already approved" path is just `approval: null`.
- The docs say plainly which routings go to `/swap` and which go to `/order`, and that `protocols` can pin AMM-only routing.
- Testnet support is listed per chain, with the Universal Router address for each (Base Sepolia `0x8702…2650`).
- Time to first successful quote: **TODO (live)**

## What was confusing

- **Two approvals, three steps.** The landing-page flow says "check approval → quote → swap", but with Permit2 there is also an EIP-712 signature between quote and swap. Swap fails validation unless you send both `signature` and `permitData`, or neither. This is only clear in the integration guide's "WRONG" examples.
- **Proxy (no-Permit2) flow is not on Base Sepolia.** The `x-permit2-disabled` proxy is deployed on Unichain Sepolia, Sepolia and Monad testnet, not Base Sepolia. Supported Chains lists Base Sepolia as available, so you only learn this from the proxy page's table.
- **Signing `permitData` is left to you.** The API returns `domain`, `types` and `values` but no `primaryType`. Most libraries (viem included) require it, and the guide warns that "the API does not return every field some libraries expect". We infer it as the one type no other type references (`PermitSingle`).
- **`/quote` sometimes contains the swap tx already** (`swapTransaction`, when no permit is needed), which makes `/swap` optional. The quickstart still calls `/swap` every time, so it is unclear which path is preferred.
- **Error shapes differ.** The integration guide shows `{ error, message, details }`, the 404 schema uses `errorCode`, and the Universal Router balance section mentions `detail`. We log the raw body.
- **Code examples use ethers v5** (`_signTypedData`, `BigNumber`), which is deprecated. A viem example would match what most new TS projects use.
- **`x-universal-router-version` default can change.** The docs suggest pinning it for a stable target but do not say what changed between versions.
- **TODO (live):** testnet liquidity for WETH/USDC on Base Sepolia, real error messages, and whether `check_approval` → approve → `quote` returns a permit for a fresh wallet.

## Suggestions

- Add a viem (TypeScript) end-to-end example: approve → sign permit → swap, including `primaryType`.
- Return `primaryType` inside `permitData` so it can be passed straight to `signTypedData`.
- On Supported Chains, mark which testnets support which flows (Permit2, proxy, UniswapX) in one table.
- Publish a list of testnet pairs that have liquidity, or return a specific `errorCode` for "pool exists but no liquidity on testnet".
- Use one error schema (`errorCode` + `detail`) on all endpoints.
- **TODO (live):** anything we hit during the real Base Sepolia swap.

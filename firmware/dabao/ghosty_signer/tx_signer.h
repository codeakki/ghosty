// tx_signer.h - Base (Uniswap swap) and Hedera (x402 payment) signer core for the Dabao.
//
// Same rule as hl_signer.h: the Dabao never signs a hash it was handed.
//  - Base: it receives the transaction FIELDS, checks them, builds the EIP-1559
//    RLP bytes itself and signs keccak256(0x02 || rlp(...)).
//  - Hedera: it receives the protobuf TransactionBody bytes, parses them, checks
//    that they are only a small transfer to an allowed account, and signs
//    keccak256(body), which is what Hedera verifies for an ECDSA key.
#pragma once

#include <stddef.h>
#include <stdint.h>

#define HL_CMD_SIGN_EVM_TX 0x03   // payload: see evm_parse_tx
#define HL_CMD_SIGN_HEDERA 0x04   // payload: TransactionBody bytes
#define HL_CMD_SIGN_PERMIT2 0x05  // payload: see permit_parse

// Base mainnet only.
#define EVM_CHAIN_ID 8453ULL
// Swaps pay in USDC (Permit2), never in ETH: no ETH value. At most 0.0001 ETH of gas.
#define EVM_MAX_VALUE_WEI 0ULL
#define EVM_MAX_FEE_WEI 100000000000000ULL
#define EVM_MAX_DATA 3000  // a Uniswap v4 swap with the Permit2 permit inside is ~1.7 KB

// Hedera x402: at most 0.1 HBAR or 0.10 USDC per payment.
#define HED_MAX_TINYBAR 10000000LL
#define HED_MAX_USDC_MICROS 100000LL
#define HED_USDC_TOKEN_NUM 429274ULL      // testnet USDC 0.0.429274

// Permit2 on Base: only USDC, only to the Uniswap router.
// The owner chose Uniswap's standard permit: the uint160 maximum (sent as amount = PERMIT_AMOUNT_MAX), valid up
// to 31 days. The router can use it only inside a transaction from this address, and the Dabao signs each of those
// (router, chain, gas, no ETH value). The 100 USD per day limit for stock buys is then enforced by the server.
#define PERMIT_AMOUNT_MAX 0xFFFFFFFFFFFFFFFFULL  // means uint160 max
#define PERMIT_MAX_USDC_MICROS 100000000ULL      // an exact permit: at most 100 USDC
#define PERMIT_MAX_LIFE_S (31ULL * 86400ULL)     // expiration at most 31 days after the signature deadline

typedef struct {
  uint8_t token[20], spender[20];
  uint64_t amount, expiration, nonce, sig_deadline;
} permit_t;

// Payload: token[20] | amount u64 | expiration u64 | nonce u64 | spender[20] | sig_deadline u64 (LE)
int permit_parse(const uint8_t *p, size_t len, permit_t *out);
int permit_check(const permit_t *pm);
// EIP-712 digest of PermitSingle for the Permit2 contract on Base.
void permit_digest(const permit_t *pm, uint8_t digest[32]);

typedef struct {
  uint64_t chain_id, nonce, max_priority_fee, max_fee, gas, value;
  uint8_t to[20];
  const uint8_t *data;  // points into the request payload
  uint16_t data_len;
} evm_tx_t;

typedef struct {
  int64_t tinybar_out;   // HBAR debited from any account (the payer is us)
  int64_t usdc_out;      // USDC micro-units debited
  uint64_t valid_start;  // seconds, from the transaction id
} hedera_summary_t;

// Payload: chain_id u64 | nonce u64 | max_priority_fee u64 | max_fee u64 | gas u64 |
//          value u64 | to[20] | data_len u16 | data   (all integers little-endian)
int evm_parse_tx(const uint8_t *p, size_t len, evm_tx_t *tx);

// Chain, gas and value limits, and one of: Universal Router execute(), or USDC approve(Permit2, amount).
int evm_check_tx(const evm_tx_t *tx);

// deadline argument of execute(bytes,bytes[],uint256): the swap's day for the daily limit.
uint64_t evm_deadline(const evm_tx_t *tx);

// keccak256(0x02 || rlp([chain_id, nonce, tip, max_fee, gas, to, value, data, []])). 0 if it does not fit.
int evm_tx_digest(const evm_tx_t *tx, uint8_t digest[32]);

// Parses and checks a Hedera TransactionBody: a CryptoTransfer only, credits only to allowed
// accounts, HBAR or testnet USDC only, under the per-payment limits.
int hedera_check_body(const uint8_t *body, size_t len, hedera_summary_t *out);

// 33-byte compressed public key (for the Hedera account key).
int hl_public_key(const uint8_t priv[32], uint8_t pub[33]);

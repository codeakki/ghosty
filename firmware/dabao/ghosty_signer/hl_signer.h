// hl_signer.h - Hyperliquid order signer core for the Dabao (portable C, no libc).
//
// The Dabao never signs a hash it was handed. It receives the order FIELDS,
// checks them against its own limits, rebuilds the exact bytes Hyperliquid
// hashes (msgpack action + nonce + vault flag -> keccak -> EIP-712 Agent),
// and signs that digest with its own secp256k1 key.
//
// Wire frame (both directions, UART 115200 8N1):
//   0xA5 | type u8 | len u16 LE | payload[len] | crc16 u16 LE
//   crc16 = CRC-16/CCITT-FALSE over type, len and payload.
#pragma once

#include <stddef.h>
#include <stdint.h>

#define HL_FRAME_START 0xA5
#define HL_MAX_PAYLOAD 3100  // a Uniswap swap with its calldata (EVM_MAX_DATA + 70); orders are under 96

// Requests (ESP32 -> Dabao) and replies (Dabao -> ESP32).
#define HL_CMD_GET_INFO 0x01        // payload: none
#define HL_CMD_SIGN_ORDER 0x02      // payload: see hl_parse_order
#define HL_RSP_INFO 0x81            // payload: address[20] | network u8 | version u8 [| pubkey[33] from v2]
#define HL_RSP_SIGNATURE 0x82       // payload: r[32] | s[32]
#define HL_RSP_ERROR 0xFF           // payload: error code u8

enum hl_error {
  HL_OK = 0,
  HL_ERR_FRAME = 1,          // bad length or CRC
  HL_ERR_COMMAND = 2,        // unknown command
  HL_ERR_FIELD = 3,          // malformed order field
  HL_ERR_ASSET = 4,          // asset not on the allowlist
  HL_ERR_NOTIONAL = 5,       // price * size above the per-order limit
  HL_ERR_NETWORK = 6,        // order for a different network than this signer
  HL_ERR_NONCE = 7,          // nonce not greater than the last signed one
  HL_ERR_REJECTED = 8,       // nobody pressed the button in time
  HL_ERR_KEY = 9,            // no usable key
  HL_ERR_SIGN = 10,          // signing failed
  HL_ERR_DAILY = 11,         // today's signed total would pass the daily limit
  HL_ERR_RATE = 12,          // asked again too soon after the last signature
  HL_ERR_CHAIN = 13,         // transaction for another chain
  HL_ERR_TARGET = 14,        // contract or receiver not on the allowlist
  HL_ERR_AMOUNT = 15,        // amount or gas above the per-transaction limit
  HL_ERR_TXTYPE = 16,        // method or transaction type the Dabao does not sign
};

typedef struct {
  uint32_t asset;      // Hyperliquid asset id: 0 = BTC, 110003 = xyz:GOLD
  uint8_t is_buy;      // 1 = buy, 0 = sell
  uint8_t network;     // 0 = mainnet ("a"), 1 = testnet ("b")
  uint64_t nonce;      // ms timestamp, as sent in the /exchange request
  char px[16];         // limit price, Hyperliquid wire string ("4106")
  uint8_t px_len;
  char sz[16];         // size in coin units ("0.0025")
  uint8_t sz_len;
  uint8_t reduce_only; // 1 = can only shrink a position (closing). Exempt from the spend limits.
} hl_order_t;

// Limits the Dabao enforces whatever the ESP32 or the server say.
#define HL_MAX_ORDER_MICRO_USD 15000000ULL   // 15 USD per order (price * size)

uint16_t hl_crc16(const uint8_t *data, size_t len);

// Payload: asset u32 LE | is_buy u8 | network u8 | nonce u64 LE |
//          px_len u8 | px | sz_len u8 | sz [| reduce_only u8]
int hl_parse_order(const uint8_t *payload, size_t len, hl_order_t *out);

// Allowlist and per-order notional limit (reduce-only orders skip the limit).
// Network, nonce and daily checks need device state and live in the caller.
int hl_check_order(const hl_order_t *o);

// price * size in micro-USD. Returns 0 if a field is malformed or it overflows.
int hl_order_notional(const hl_order_t *o, uint64_t *micro_usd);

// Exact msgpack bytes of {"type":"order","orders":[{a,b,p,s,r:false,t:{limit:{tif:"Ioc"}}}],"grouping":"na"}.
size_t hl_order_msgpack(const hl_order_t *o, uint8_t *out, size_t cap);

// EIP-712 digest Hyperliquid verifies for this order.
void hl_order_digest(const hl_order_t *o, uint8_t digest[32]);

void hl_keccak256(const uint8_t *data, size_t len, uint8_t out[32]);

// Address = last 20 bytes of keccak256(public key x||y).
int hl_address(const uint8_t priv[32], uint8_t address[20]);

// Deterministic (RFC 6979) secp256k1 signature r||s over digest.
int hl_sign(const uint8_t priv[32], const uint8_t digest[32], uint8_t sig[64]);

// Builds a reply frame into out (needs 6 + payload bytes). Returns its length.
size_t hl_frame(uint8_t type, const uint8_t *payload, uint16_t len, uint8_t *out);

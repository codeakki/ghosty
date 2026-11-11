// tx_signer.c - see tx_signer.h. Builds on the Dabao (one translation unit with
// ghosty_signer.c) and on a host for tests. Uses hl_keccak256 from hl_signer.c.
#include "tx_signer.h"
#include "hl_signer.h"

#include "third_party/micro-ecc/uECC.h"

static void cs_copy(uint8_t *dst, const void *src, size_t n) {
  const uint8_t *s = (const uint8_t *)src;
  for (size_t i = 0; i < n; i++) dst[i] = s[i];
}

static void cs_wipe(void *p, size_t n) {
  volatile uint8_t *b = (volatile uint8_t *)p;
  while (n--) *b++ = 0;
}

// ---------------------------------------------------------------------------
// Allowlists

// Uniswap Universal Router on Base (the address the Trading API returns, and the v4 router).
static const uint8_t EVM_ROUTERS[][20] = {
    {0xd6, 0x14, 0x5b, 0x2d, 0x3f, 0x37, 0x99, 0x19, 0xe8, 0xcd, 0xed, 0xa7, 0xb9, 0x7e, 0x37, 0xc4, 0xb2, 0xca, 0x9c, 0x40},
    {0x6f, 0xf5, 0x69, 0x3b, 0x99, 0x21, 0x2d, 0xa7, 0x6a, 0xd3, 0x16, 0x17, 0x8a, 0x18, 0x4a, 0xb5, 0x6d, 0x29, 0x9b, 0x43},
};
// execute(bytes commands, bytes[] inputs, uint256 deadline)
static const uint8_t EXECUTE_SELECTOR[4] = {0x35, 0x93, 0x56, 0x4c};

// USDC on Base and the Permit2 contract (the only spender USDC may approve).
static const uint8_t USDC_BASE[20] = {0x83, 0x35, 0x89, 0xfc, 0xd6, 0xed, 0xb6, 0xe0, 0x8f, 0x4c, 0x7c, 0x32, 0xd4, 0xf7, 0x1b, 0x54, 0xbd, 0xa0, 0x29, 0x13};
static const uint8_t PERMIT2[20] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x22, 0xd4, 0x73, 0x03, 0x0f, 0x11, 0x6d, 0xde, 0xe9, 0xf6, 0xb4, 0x3a, 0xc7, 0x8b, 0xa3};
static const uint8_t APPROVE_SELECTOR[4] = {0x09, 0x5e, 0xa7, 0xb3};

// Hedera accounts that may receive a payment: the Signal Desk (X402_PAY_TO 0.0.11342424).
static const uint64_t HED_PAY_TO[] = {11342424ULL};

static int same(const uint8_t *a, const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (a[i] != b[i]) return 0;
  return 1;
}

static uint64_t rd64(const uint8_t *p) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = v << 8 | p[i];
  return v;
}

// ---------------------------------------------------------------------------
// Base: parse, check, RLP digest

int evm_parse_tx(const uint8_t *p, size_t len, evm_tx_t *tx) {
  if (len < 48 + 20 + 2) return HL_ERR_FIELD;
  tx->chain_id = rd64(p);
  tx->nonce = rd64(p + 8);
  tx->max_priority_fee = rd64(p + 16);
  tx->max_fee = rd64(p + 24);
  tx->gas = rd64(p + 32);
  tx->value = rd64(p + 40);
  cs_copy(tx->to, p + 48, 20);
  tx->data_len = (uint16_t)(p[68] | (p[69] << 8));
  if ((size_t)70 + tx->data_len != len || tx->data_len > EVM_MAX_DATA) return HL_ERR_FIELD;
  tx->data = p + 70;
  return HL_OK;
}

uint64_t evm_deadline(const evm_tx_t *tx) {
  // Third head word of the ABI arguments: data[4 + 64 .. 4 + 96]. Only the low 8 bytes may be set.
  if (tx->data_len < 4 + 96) return 0;
  const uint8_t *w = tx->data + 4 + 64;
  for (int i = 0; i < 24; i++)
    if (w[i]) return 0;
  uint64_t v = 0;
  for (int i = 24; i < 32; i++) v = v << 8 | w[i];
  return v;
}

int evm_check_tx(const evm_tx_t *tx) {
  if (tx->chain_id != EVM_CHAIN_ID) return HL_ERR_CHAIN;
  int router = 0;
  for (size_t i = 0; i < sizeof EVM_ROUTERS / sizeof EVM_ROUTERS[0]; i++)
    if (same(tx->to, EVM_ROUTERS[i], 20)) router = 1;
  if (router) {
    if (tx->data_len < 4 || !same(tx->data, EXECUTE_SELECTOR, 4) || evm_deadline(tx) == 0) return HL_ERR_TXTYPE;
  } else if (same(tx->to, USDC_BASE, 20)) {
    // approve(address spender, uint256 amount): only Permit2 may be the spender. Permit2 still needs a permit per swap.
    if (tx->data_len != 4 + 64 || !same(tx->data, APPROVE_SELECTOR, 4)) return HL_ERR_TXTYPE;
    for (int i = 0; i < 12; i++)
      if (tx->data[4 + i]) return HL_ERR_TARGET;
    if (!same(tx->data + 4 + 12, PERMIT2, 20)) return HL_ERR_TARGET;
  } else {
    return HL_ERR_TARGET;
  }
  if (tx->value > EVM_MAX_VALUE_WEI) return HL_ERR_AMOUNT;
  // gas < 2^24 and max_fee < 2^40 keep the product inside 64 bits.
  if (tx->gas == 0 || tx->gas >= (1ULL << 24) || tx->max_fee >= (1ULL << 40) || tx->max_priority_fee > tx->max_fee) return HL_ERR_FIELD;
  if (tx->gas * tx->max_fee > EVM_MAX_FEE_WEI) return HL_ERR_AMOUNT;
  return HL_OK;
}

typedef struct {
  uint8_t *p;
  size_t n, cap;
  int overflow;
} rlp_t;

static void rput(rlp_t *w, const uint8_t *src, size_t n) {
  if (w->n + n > w->cap) {
    w->overflow = 1;
    return;
  }
  cs_copy(w->p + w->n, src, n);
  w->n += n;
}

static void rput1(rlp_t *w, uint8_t b) { rput(w, &b, 1); }

// Length prefix for a string (base 0x80) or list (base 0xc0).
static void rlp_len(rlp_t *w, uint8_t base, size_t len) {
  if (len <= 55) {
    rput1(w, (uint8_t)(base + len));
    return;
  }
  uint8_t be[4];
  int k = 0;
  for (size_t v = len; v; v >>= 8) be[k++] = (uint8_t)v;
  rput1(w, (uint8_t)(base + 55 + k));
  while (k--) rput1(w, be[k]);
}

static void rlp_bytes(rlp_t *w, const uint8_t *b, size_t n) {
  if (n == 1 && b[0] < 0x80) {
    rput1(w, b[0]);
    return;
  }
  rlp_len(w, 0x80, n);
  rput(w, b, n);
}

static void rlp_uint(rlp_t *w, uint64_t v) {
  uint8_t be[8];
  int k = 0;
  for (uint64_t x = v; x; x >>= 8) be[7 - k++] = (uint8_t)x;
  rlp_bytes(w, be + 8 - k, (size_t)k);  // 0 -> empty string 0x80
}

static void rlp_fields(rlp_t *w, const evm_tx_t *tx) {
  rlp_uint(w, tx->chain_id);
  rlp_uint(w, tx->nonce);
  rlp_uint(w, tx->max_priority_fee);
  rlp_uint(w, tx->max_fee);
  rlp_uint(w, tx->gas);
  rlp_bytes(w, tx->to, 20);
  rlp_uint(w, tx->value);
  rlp_bytes(w, tx->data, tx->data_len);
  rput1(w, 0xc0);  // empty access list
}

int evm_tx_digest(const evm_tx_t *tx, uint8_t digest[32]) {
  // Fields go in at offset 8; the type byte and list header (at most 4 bytes) go right before them.
  static uint8_t buf[EVM_MAX_DATA + 160];
  rlp_t body = {buf + 8, 0, sizeof buf - 8, 0};
  rlp_fields(&body, tx);
  if (body.overflow) return 0;
  rlp_t head = {buf, 0, 8, 0};
  rput1(&head, 0x02);
  rlp_len(&head, 0xc0, body.n);
  // Move the header right next to the body.
  size_t off = 8 - head.n;
  for (size_t i = head.n; i-- > 0;) buf[off + i] = buf[i];
  hl_keccak256(buf + off, head.n + body.n, digest);
  return 1;
}

// ---------------------------------------------------------------------------
// Hedera: minimal protobuf reader

typedef struct {
  const uint8_t *p, *end;
  int bad;
} pb_t;

static uint64_t pb_varint(pb_t *r) {
  uint64_t v = 0;
  for (int shift = 0; shift < 64; shift += 7) {
    if (r->p >= r->end) break;
    uint8_t b = *r->p++;
    v |= (uint64_t)(b & 0x7f) << shift;
    if (!(b & 0x80)) return v;
  }
  r->bad = 1;
  return 0;
}

// Next field: returns 0 at the end. *wt = wire type. For wire type 2, *sub is the value.
static int pb_next(pb_t *r, uint32_t *field, uint32_t *wt, pb_t *sub, uint64_t *num) {
  if (r->bad || r->p >= r->end) return 0;
  uint64_t key = pb_varint(r);
  *field = (uint32_t)(key >> 3);
  *wt = (uint32_t)(key & 7);
  *num = 0;
  if (*wt == 0) {
    *num = pb_varint(r);
  } else if (*wt == 2) {
    uint64_t n = pb_varint(r);
    if (n > (uint64_t)(r->end - r->p)) {
      r->bad = 1;
      return 0;
    }
    sub->p = r->p;
    sub->end = r->p + n;
    sub->bad = 0;
    r->p += n;
  } else if (*wt == 1 || *wt == 5) {
    size_t n = *wt == 1 ? 8 : 4;
    if (n > (size_t)(r->end - r->p)) {
      r->bad = 1;
      return 0;
    }
    for (size_t i = 0; i < n; i++) *num |= (uint64_t)r->p[i] << (8 * i);
    r->p += n;
  } else {
    r->bad = 1;
    return 0;
  }
  return !r->bad;
}

typedef struct {
  uint64_t shard, realm, num;
  int alias;
} hed_id_t;

static int pb_id(pb_t r, hed_id_t *id) {
  uint32_t f, wt;
  uint64_t v;
  pb_t sub;
  id->shard = id->realm = id->num = 0;
  id->alias = 0;
  while (pb_next(&r, &f, &wt, &sub, &v)) {
    if (f == 1 && wt == 0) id->shard = v;
    else if (f == 2 && wt == 0) id->realm = v;
    else if (f == 3 && wt == 0) id->num = v;
    else if (f == 4 && wt == 2) id->alias = 1;
    else return 0;
  }
  return !r.bad;
}

static int pay_to_allowed(const hed_id_t *id) {
  if (id->alias || id->shard || id->realm) return 0;
  for (size_t i = 0; i < sizeof HED_PAY_TO / sizeof HED_PAY_TO[0]; i++)
    if (id->num == HED_PAY_TO[i]) return 1;
  return 0;
}

// One AccountAmount. Adds a debit to *out_sum; checks a credit's receiver.
static int pb_amount(pb_t r, int64_t *out_sum) {
  uint32_t f, wt;
  uint64_t v;
  pb_t sub;
  hed_id_t id = {0, 0, 0, 0};
  int have_id = 0;
  int64_t amount = 0;
  while (pb_next(&r, &f, &wt, &sub, &v)) {
    if (f == 1 && wt == 2) {
      if (!pb_id(sub, &id)) return HL_ERR_FIELD;
      have_id = 1;
    } else if (f == 2 && wt == 0) {
      amount = (int64_t)(v >> 1) ^ -(int64_t)(v & 1);  // sint64 zigzag
    } else if (f == 3 && wt == 0) {
      if (v) return HL_ERR_TXTYPE;  // allowance spends: never
    } else {
      return HL_ERR_FIELD;
    }
  }
  if (r.bad || !have_id) return HL_ERR_FIELD;
  if (amount > 0 && !pay_to_allowed(&id)) return HL_ERR_TARGET;
  if (amount < 0) {
    if (amount < -(int64_t)1e15) return HL_ERR_AMOUNT;
    *out_sum += -amount;
  }
  return HL_OK;
}

static int pb_transfer_list(pb_t r, int64_t *sum) {
  uint32_t f, wt;
  uint64_t v;
  pb_t sub;
  while (pb_next(&r, &f, &wt, &sub, &v)) {
    if (f != 1 || wt != 2) return HL_ERR_FIELD;
    int rc = pb_amount(sub, sum);
    if (rc != HL_OK) return rc;
  }
  return r.bad ? HL_ERR_FIELD : HL_OK;
}

static int pb_token_list(pb_t r, int64_t *usdc) {
  uint32_t f, wt;
  uint64_t v;
  pb_t sub;
  int token_ok = 0;
  int64_t sum = 0;
  while (pb_next(&r, &f, &wt, &sub, &v)) {
    if (f == 1 && wt == 2) {
      hed_id_t t;
      if (!pb_id(sub, &t)) return HL_ERR_FIELD;  // TokenID: shard, realm, num
      token_ok = !t.alias && !t.shard && !t.realm && t.num == HED_USDC_TOKEN_NUM;
      if (!token_ok) return HL_ERR_TARGET;
    } else if (f == 2 && wt == 2) {
      int rc = pb_amount(sub, &sum);
      if (rc != HL_OK) return rc;
    } else if (f == 4 && wt == 2) {
      // expected_decimals (UInt32Value): fine
    } else {
      return HL_ERR_TXTYPE;  // NFT transfers and anything new
    }
  }
  if (r.bad || !token_ok) return HL_ERR_FIELD;
  *usdc += sum;
  return HL_OK;
}

int hedera_check_body(const uint8_t *body, size_t len, hedera_summary_t *out) {
  pb_t r = {body, body + len, 0};
  uint32_t f, wt;
  uint64_t v;
  pb_t sub;
  int have_transfer = 0, have_id = 0;
  out->tinybar_out = out->usdc_out = 0;
  out->valid_start = 0;
  while (pb_next(&r, &f, &wt, &sub, &v)) {
    if (f == 1 && wt == 2) {  // transactionID { transactionValidStart { seconds } , accountID, ... }
      uint32_t f2, wt2;
      uint64_t v2;
      pb_t s2;
      while (pb_next(&sub, &f2, &wt2, &s2, &v2)) {
        if (f2 == 1 && wt2 == 2) {
          uint32_t f3, wt3;
          uint64_t v3;
          pb_t s3;
          while (pb_next(&s2, &f3, &wt3, &s3, &v3))
            if (f3 == 1 && wt3 == 0) out->valid_start = v3;
        } else if (f2 == 3 && wt2 == 0 && v2) {
          return HL_ERR_TXTYPE;  // scheduled
        }
      }
      have_id = 1;
    } else if ((f == 2 || f == 4) && wt == 2) {
      // nodeAccountID, transactionValidDuration
    } else if ((f == 3 || f == 5) && wt == 0) {
      // transactionFee (paid by the facilitator), generateRecord
    } else if (f == 6 && wt == 2) {
      // memo
    } else if (f == 14 && wt == 2) {  // cryptoTransfer
      uint32_t f2, wt2;
      uint64_t v2;
      pb_t s2;
      while (pb_next(&sub, &f2, &wt2, &s2, &v2)) {
        int rc;
        if (f2 == 1 && wt2 == 2) rc = pb_transfer_list(s2, &out->tinybar_out);
        else if (f2 == 2 && wt2 == 2) rc = pb_token_list(s2, &out->usdc_out);
        else rc = HL_ERR_TXTYPE;
        if (rc != HL_OK) return rc;
      }
      if (sub.bad) return HL_ERR_FIELD;
      have_transfer = 1;
    } else {
      return HL_ERR_TXTYPE;  // any other transaction type or field
    }
  }
  if (r.bad || !have_transfer || !have_id || out->valid_start == 0) return HL_ERR_FIELD;
  if (out->tinybar_out > HED_MAX_TINYBAR || out->usdc_out > HED_MAX_USDC_MICROS) return HL_ERR_AMOUNT;
  if (out->tinybar_out == 0 && out->usdc_out == 0) return HL_ERR_AMOUNT;
  return HL_OK;
}

// ---------------------------------------------------------------------------
// Permit2 PermitSingle

int permit_parse(const uint8_t *p, size_t len, permit_t *pm) {
  if (len != 20 + 8 + 8 + 8 + 20 + 8) return HL_ERR_FIELD;
  cs_copy(pm->token, p, 20);
  pm->amount = rd64(p + 20);
  pm->expiration = rd64(p + 28);
  pm->nonce = rd64(p + 36);
  cs_copy(pm->spender, p + 44, 20);
  pm->sig_deadline = rd64(p + 64);
  return HL_OK;
}

int permit_check(const permit_t *pm) {
  if (!same(pm->token, USDC_BASE, 20)) return HL_ERR_TARGET;
  int router = 0;
  for (size_t i = 0; i < sizeof EVM_ROUTERS / sizeof EVM_ROUTERS[0]; i++)
    if (same(pm->spender, EVM_ROUTERS[i], 20)) router = 1;
  if (!router) return HL_ERR_TARGET;
  if (pm->amount == 0 || (pm->amount > PERMIT_MAX_USDC_MICROS && pm->amount != PERMIT_AMOUNT_MAX)) return HL_ERR_AMOUNT;
  // uint48 fields, and a bounded life.
  if (pm->nonce >= (1ULL << 48) || pm->expiration >= (1ULL << 48) || pm->sig_deadline >= (1ULL << 40)) return HL_ERR_FIELD;
  if (pm->sig_deadline == 0 || pm->expiration > pm->sig_deadline + PERMIT_MAX_LIFE_S) return HL_ERR_AMOUNT;
  return HL_OK;
}

static void word_u64(uint8_t w[32], uint64_t v) {
  for (int i = 0; i < 32; i++) w[i] = 0;
  for (int i = 0; i < 8; i++) w[31 - i] = (uint8_t)(v >> (8 * i));
}

static void word_addr(uint8_t w[32], const uint8_t a[20]) {
  for (int i = 0; i < 12; i++) w[i] = 0;
  cs_copy(w + 12, a, 20);
}

static void keccak_str(const char *s, uint8_t out[32]) {
  size_t n = 0;
  while (s[n]) n++;
  hl_keccak256((const uint8_t *)s, n, out);
}

void permit_digest(const permit_t *pm, uint8_t digest[32]) {
  static const char DETAILS[] = "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)";
  static const char SINGLE[] =
      "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
      "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)";
  uint8_t buf[32 * 5];
  // details struct hash
  keccak_str(DETAILS, buf);
  word_addr(buf + 32, pm->token);
  word_u64(buf + 64, pm->amount);
  if (pm->amount == PERMIT_AMOUNT_MAX)  // uint160 max: low 20 bytes all 0xff
    for (int i = 12; i < 32; i++) buf[64 + i] = 0xff;
  word_u64(buf + 96, pm->expiration);
  word_u64(buf + 128, pm->nonce);
  uint8_t details[32];
  hl_keccak256(buf, 160, details);
  // PermitSingle struct hash
  keccak_str(SINGLE, buf);
  cs_copy(buf + 32, details, 32);
  word_addr(buf + 64, pm->spender);
  word_u64(buf + 96, pm->sig_deadline);
  uint8_t single[32];
  hl_keccak256(buf, 128, single);
  // domain: EIP712Domain(string name,uint256 chainId,address verifyingContract), name "Permit2", Base, Permit2
  keccak_str("EIP712Domain(string name,uint256 chainId,address verifyingContract)", buf);
  keccak_str("Permit2", buf + 32);
  word_u64(buf + 64, EVM_CHAIN_ID);
  word_addr(buf + 96, PERMIT2);
  uint8_t domain[32];
  hl_keccak256(buf, 128, domain);
  uint8_t msg[66];
  msg[0] = 0x19;
  msg[1] = 0x01;
  cs_copy(msg + 2, domain, 32);
  cs_copy(msg + 34, single, 32);
  hl_keccak256(msg, 66, digest);
}

int hl_public_key(const uint8_t priv[32], uint8_t pub[33]) {
  uint8_t xy[64];
  int ok = uECC_compute_public_key(priv, xy, uECC_secp256k1());
  if (ok) uECC_compress(xy, pub, uECC_secp256k1());
  cs_wipe(xy, sizeof xy);
  return ok ? HL_OK : HL_ERR_KEY;
}

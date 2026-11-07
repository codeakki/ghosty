// hl_signer.c - see hl_signer.h. Builds on the Dabao and on a host for tests.
#include "hl_signer.h"

#include "third_party/micro-ecc/uECC.h"
#include "third_party/tiny_sha3/sha3.h"

// ---------------------------------------------------------------------------
// Small helpers (no libc on the Dabao)

static void copy(uint8_t *dst, const void *src, size_t n) {
  const uint8_t *s = (const uint8_t *)src;
  for (size_t i = 0; i < n; i++) dst[i] = s[i];
}

static void wipe(void *p, size_t n) {
  volatile uint8_t *b = (volatile uint8_t *)p;
  while (n--) *b++ = 0;
}

uint16_t hl_crc16(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

size_t hl_frame(uint8_t type, const uint8_t *payload, uint16_t len, uint8_t *out) {
  out[0] = HL_FRAME_START;
  out[1] = type;
  out[2] = (uint8_t)len;
  out[3] = (uint8_t)(len >> 8);
  copy(out + 4, payload, len);
  uint16_t crc = hl_crc16(out + 1, 3 + (size_t)len);
  out[4 + len] = (uint8_t)crc;
  out[5 + len] = (uint8_t)(crc >> 8);
  return 6 + (size_t)len;
}

// ---------------------------------------------------------------------------
// Order fields

static uint32_t rd32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// Hyperliquid wire decimal: digits with at most one '.', no sign, no exponent,
// no leading zeros (except "0.x") and no trailing zeros after the '.'.
static int valid_decimal(const char *s, uint8_t n) {
  if (n == 0 || n > 15) return 0;
  int dot = -1;
  for (uint8_t i = 0; i < n; i++) {
    if (s[i] == '.') {
      if (dot >= 0 || i == 0 || i == n - 1) return 0;
      dot = i;
    } else if (s[i] < '0' || s[i] > '9') {
      return 0;
    }
  }
  if (n > 1 && s[0] == '0' && dot != 1) return 0;
  if (dot >= 0 && s[n - 1] == '0') return 0;
  return 1;
}

int hl_parse_order(const uint8_t *p, size_t len, hl_order_t *o) {
  if (len < 4 + 1 + 1 + 8 + 1) return HL_ERR_FIELD;
  o->asset = rd32(p);
  o->is_buy = p[4];
  o->network = p[5];
  o->nonce = (uint64_t)rd32(p + 6) | ((uint64_t)rd32(p + 10) << 32);
  size_t i = 14;
  o->px_len = p[i++];
  if (o->px_len > sizeof o->px || i + o->px_len + 1 > len) return HL_ERR_FIELD;
  copy((uint8_t *)o->px, p + i, o->px_len);
  i += o->px_len;
  o->sz_len = p[i++];
  if (o->sz_len > sizeof o->sz || (i + o->sz_len != len && i + o->sz_len + 1 != len)) return HL_ERR_FIELD;
  copy((uint8_t *)o->sz, p + i, o->sz_len);
  i += o->sz_len;
  o->reduce_only = i < len ? p[i] : 0;
  if (o->is_buy > 1 || o->network > 1 || o->reduce_only > 1) return HL_ERR_FIELD;
  if (!valid_decimal(o->px, o->px_len) || !valid_decimal(o->sz, o->sz_len)) return HL_ERR_FIELD;
  return HL_OK;
}

// Decimal string -> value in 1e-9 units. Returns 0 if it has more than 9 decimals or overflows.
static int to_nano(const char *s, uint8_t n, uint64_t *out) {
  uint64_t v = 0;
  int decimals = -1;
  for (uint8_t i = 0; i < n; i++) {
    if (s[i] == '.') { decimals = 0; continue; }
    if (v > 1844674407370955ULL) return 0;  // v * 10 would overflow
    v = v * 10 + (uint64_t)(s[i] - '0');
    if (decimals >= 0) decimals++;
  }
  if (decimals < 0) decimals = 0;
  if (decimals > 9) return 0;
  for (int d = decimals; d < 9; d++) {
    if (v > 1844674407370955161ULL) return 0;
    v *= 10;
  }
  *out = v;
  return 1;
}

static const uint32_t ALLOWED_ASSETS[] = {
    0,       // BTC
    1,       // ETH
    5,       // SOL
    110003,  // xyz:GOLD
    110029,  // xyz:CL (WTI)
};

int hl_order_notional(const hl_order_t *o, uint64_t *micro_usd) {
  uint64_t px, sz;
  if (!to_nano(o->px, o->px_len, &px) || !to_nano(o->sz, o->sz_len, &sz)) return 0;
  // micro-USD = (px/1e9) * (sz/1e9) * 1e6 = (px/1e3) * sz / 1e9. Split to avoid overflow.
  uint64_t px_micro = px / 1000;
  if (px_micro != 0 && sz > UINT64_MAX / px_micro) return 0;
  *micro_usd = px_micro * sz / 1000000000ULL;
  return 1;
}

int hl_check_order(const hl_order_t *o) {
  int allowed = 0;
  for (size_t i = 0; i < sizeof ALLOWED_ASSETS / sizeof ALLOWED_ASSETS[0]; i++) {
    if (ALLOWED_ASSETS[i] == o->asset) allowed = 1;
  }
  if (!allowed) return HL_ERR_ASSET;
  uint64_t notional;
  if (!hl_order_notional(o, &notional)) return HL_ERR_NOTIONAL;
  if (!o->reduce_only && notional > HL_MAX_ORDER_MICRO_USD) return HL_ERR_NOTIONAL;
  return HL_OK;
}

// ---------------------------------------------------------------------------
// msgpack (only the shapes an order needs)

typedef struct {
  uint8_t *b;
  size_t n, cap;
  int overflow;
} buf_t;

static void put(buf_t *w, const void *src, size_t n) {
  if (w->n + n > w->cap) { w->overflow = 1; return; }
  copy(w->b + w->n, src, n);
  w->n += n;
}

static void put1(buf_t *w, uint8_t v) { put(w, &v, 1); }

static void put_str(buf_t *w, const char *s, size_t n) {  // fixstr, n <= 31
  put1(w, (uint8_t)(0xA0 | n));
  put(w, s, n);
}

static void put_cstr(buf_t *w, const char *s) {
  size_t n = 0;
  while (s[n]) n++;
  put_str(w, s, n);
}

static void put_uint(buf_t *w, uint32_t v) {  // smallest encoding, as @std/msgpack does
  if (v < 0x80) {
    put1(w, (uint8_t)v);
  } else if (v < 0x100) {
    put1(w, 0xCC); put1(w, (uint8_t)v);
  } else if (v < 0x10000) {
    put1(w, 0xCD); put1(w, (uint8_t)(v >> 8)); put1(w, (uint8_t)v);
  } else {
    put1(w, 0xCE);
    put1(w, (uint8_t)(v >> 24)); put1(w, (uint8_t)(v >> 16)); put1(w, (uint8_t)(v >> 8)); put1(w, (uint8_t)v);
  }
}

size_t hl_order_msgpack(const hl_order_t *o, uint8_t *out, size_t cap) {
  buf_t w = {out, 0, cap, 0};
  put1(&w, 0x83);                       // {type, orders, grouping}
  put_cstr(&w, "type");   put_cstr(&w, "order");
  put_cstr(&w, "orders"); put1(&w, 0x91); put1(&w, 0x86);  // [ {a,b,p,s,r,t} ]
  put_cstr(&w, "a"); put_uint(&w, o->asset);
  put_cstr(&w, "b"); put1(&w, o->is_buy ? 0xC3 : 0xC2);
  put_cstr(&w, "p"); put_str(&w, o->px, o->px_len);
  put_cstr(&w, "s"); put_str(&w, o->sz, o->sz_len);
  put_cstr(&w, "r"); put1(&w, o->reduce_only ? 0xC3 : 0xC2);
  put_cstr(&w, "t"); put1(&w, 0x81); put_cstr(&w, "limit"); put1(&w, 0x81); put_cstr(&w, "tif"); put_cstr(&w, "Ioc");
  put_cstr(&w, "grouping"); put_cstr(&w, "na");
  return w.overflow ? 0 : w.n;
}

// ---------------------------------------------------------------------------
// Hashes

void hl_keccak256(const uint8_t *data, size_t len, uint8_t out[32]) {
  sha3_ctx_t c;
  sha3_init(&c, 32);
  sha3_update(&c, data, len);
  c.st.b[c.pt] ^= 0x01;  // original Keccak padding (Ethereum), not SHA3's 0x06
  c.st.b[c.rsiz - 1] ^= 0x80;
  sha3_keccakf(c.st.q);
  copy(out, c.st.b, 32);
}

static void keccak_cstr(const char *s, uint8_t out[32]) {
  size_t n = 0;
  while (s[n]) n++;
  hl_keccak256((const uint8_t *)s, n, out);
}

void hl_order_digest(const hl_order_t *o, uint8_t digest[32]) {
  // connectionId = keccak(msgpack(action) || nonce u64 BE || 0x00 (no vault))
  uint8_t buf[160];
  size_t n = hl_order_msgpack(o, buf, sizeof buf - 9);
  for (int i = 0; i < 8; i++) buf[n + i] = (uint8_t)(o->nonce >> (56 - 8 * i));
  buf[n + 8] = 0x00;
  uint8_t connection_id[32];
  hl_keccak256(buf, n + 9, connection_id);

  // EIP-712 domain {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}
  uint8_t enc[5 * 32];
  for (size_t i = 0; i < sizeof enc; i++) enc[i] = 0;
  keccak_cstr("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)", enc);
  keccak_cstr("Exchange", enc + 32);
  keccak_cstr("1", enc + 64);
  enc[96 + 30] = 0x05;  // 1337 = 0x0539
  enc[96 + 31] = 0x39;
  uint8_t domain[32];
  hl_keccak256(enc, sizeof enc, domain);

  // struct Agent { string source; bytes32 connectionId; }
  keccak_cstr("Agent(string source,bytes32 connectionId)", enc);
  keccak_cstr(o->network ? "b" : "a", enc + 32);
  copy(enc + 64, connection_id, 32);
  uint8_t agent[32];
  hl_keccak256(enc, 96, agent);

  uint8_t msg[2 + 64];
  msg[0] = 0x19;
  msg[1] = 0x01;
  copy(msg + 2, domain, 32);
  copy(msg + 34, agent, 32);
  hl_keccak256(msg, sizeof msg, digest);
}

// ---------------------------------------------------------------------------
// SHA-256 for RFC 6979 (deterministic k). Plain FIPS 180-4.

typedef struct {
  uint32_t h[8];
  uint8_t block[64];
  uint64_t bits;
  uint32_t used;
} sha256_t;

static const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(sha256_t *s) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)s->block[4 * i] << 24) | ((uint32_t)s->block[4 * i + 1] << 16) |
           ((uint32_t)s->block[4 * i + 2] << 8) | s->block[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3], e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = h + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
    uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void sha256_init(sha256_t *s) {
  static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  for (int i = 0; i < 8; i++) s->h[i] = iv[i];
  s->bits = 0;
  s->used = 0;
}

static void sha256_update(sha256_t *s, const uint8_t *p, unsigned n) {
  while (n--) {
    s->block[s->used++] = *p++;
    s->bits += 8;
    if (s->used == 64) { sha256_block(s); s->used = 0; }
  }
}

static void sha256_final(sha256_t *s, uint8_t out[32]) {
  uint64_t bits = s->bits;
  uint8_t pad = 0x80;
  sha256_update(s, &pad, 1);
  pad = 0;
  while (s->used != 56) sha256_update(s, &pad, 1);
  for (int i = 7; i >= 0; i--) { uint8_t b = (uint8_t)(bits >> (8 * i)); sha256_update(s, &b, 1); }
  for (int i = 0; i < 8; i++) {
    out[4 * i] = (uint8_t)(s->h[i] >> 24); out[4 * i + 1] = (uint8_t)(s->h[i] >> 16);
    out[4 * i + 2] = (uint8_t)(s->h[i] >> 8); out[4 * i + 3] = (uint8_t)s->h[i];
  }
}

typedef struct {
  uECC_HashContext uECC;
  sha256_t ctx;
} sha256_hash_ctx;

static void hc_init(const uECC_HashContext *base) { sha256_init(&((sha256_hash_ctx *)base)->ctx); }
static void hc_update(const uECC_HashContext *base, const uint8_t *m, unsigned n) {
  sha256_update(&((sha256_hash_ctx *)base)->ctx, m, n);
}
static void hc_finish(const uECC_HashContext *base, uint8_t *out) { sha256_final(&((sha256_hash_ctx *)base)->ctx, out); }

// ---------------------------------------------------------------------------
// Keys and signatures

int hl_address(const uint8_t priv[32], uint8_t address[20]) {
  uint8_t pub[64], h[32];
  if (!uECC_compute_public_key(priv, pub, uECC_secp256k1())) return HL_ERR_KEY;
  hl_keccak256(pub, 64, h);
  copy(address, h + 12, 20);
  return HL_OK;
}

int hl_sign(const uint8_t priv[32], const uint8_t digest[32], uint8_t sig[64]) {
  uint8_t tmp[32 + 32 + 64];
  sha256_hash_ctx ctx = {{&hc_init, &hc_update, &hc_finish, 64, 32, tmp}, {{0}, {0}, 0, 0}};
  int ok = uECC_sign_deterministic(priv, digest, 32, &ctx.uECC, sig, uECC_secp256k1());
  wipe(tmp, sizeof tmp);
  wipe(&ctx, sizeof ctx);
  return ok ? HL_OK : HL_ERR_SIGN;
}

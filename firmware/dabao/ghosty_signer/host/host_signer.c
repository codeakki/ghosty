// host_signer.c - runs the Dabao signer core on a computer, for tests.
//
// Usage: host_signer <priv hex> <request frame hex>
// Prints the reply frame hex plus, for a sign request, the msgpack and digest.
// The server tests compare these bytes with the Hyperliquid SDK.
#include <stdio.h>
#include <string.h>

#include "../hl_signer.h"

static int unhex(const char *s, uint8_t *out, size_t cap) {
  size_t n = strlen(s);
  if (n % 2 || n / 2 > cap) return -1;
  for (size_t i = 0; i < n / 2; i++) {
    unsigned v;
    if (sscanf(s + 2 * i, "%2x", &v) != 1) return -1;
    out[i] = (uint8_t)v;
  }
  return (int)(n / 2);
}

static void hex(const char *label, const uint8_t *b, size_t n) {
  printf("%s ", label);
  for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
  printf("\n");
}

int main(int argc, char **argv) {
  uint8_t priv[32], frame[128];
  if (argc != 3 || unhex(argv[1], priv, 32) != 32) {
    fprintf(stderr, "usage: host_signer <priv hex> <request frame hex>\n");
    return 2;
  }
  int n = unhex(argv[2], frame, sizeof frame);
  if (n < 6 || frame[0] != HL_FRAME_START) return 2;
  uint16_t len = (uint16_t)(frame[2] | (frame[3] << 8));
  uint8_t out[128];
  uint8_t err;
  if (len + 6 != n || hl_crc16(frame + 1, 3 + len) != (uint16_t)(frame[4 + len] | (frame[5 + len] << 8))) {
    err = HL_ERR_FRAME;
    hex("reply", out, hl_frame(HL_RSP_ERROR, &err, 1, out));
    return 0;
  }
  if (frame[1] == HL_CMD_GET_INFO) {
    uint8_t info[22];
    hl_address(priv, info);
    info[20] = 0;
    info[21] = 1;
    hex("reply", out, hl_frame(HL_RSP_INFO, info, sizeof info, out));
    return 0;
  }
  hl_order_t o;
  int rc = frame[1] == HL_CMD_SIGN_ORDER ? hl_parse_order(frame + 4, len, &o) : HL_ERR_COMMAND;
  if (rc == HL_OK) rc = hl_check_order(&o);
  if (rc != HL_OK) {
    err = (uint8_t)rc;
    hex("reply", out, hl_frame(HL_RSP_ERROR, &err, 1, out));
    return 0;
  }
  uint8_t mp[160], digest[32], sig[64];
  hex("msgpack", mp, hl_order_msgpack(&o, mp, sizeof mp));
  hl_order_digest(&o, digest);
  hex("digest", digest, 32);
  hl_sign(priv, digest, sig);
  hex("reply", out, hl_frame(HL_RSP_SIGNATURE, sig, 64, out));
  return 0;
}

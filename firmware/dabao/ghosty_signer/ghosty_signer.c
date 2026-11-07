/*
 * ghosty_signer.c - Dabao (Baochip-1x) transaction signer for the Ghosty pod.
 *
 * The ESP32 relays order requests over UART2; this program checks each order,
 * rebuilds the Hyperliquid digest itself (hl_signer.c), applies its own limits
 * (per order, per day, speed) and returns the secp256k1 signature. With
 * AUTO_APPROVE 0 it also waits for a press on the Dabao's own button. The private key
 * is made here from the hardware TRNG, kept in RRAM, and never sent anywhere:
 * the only things that leave are the address and signatures.
 *
 * Wiring (3 wires to the ESP32-S3, Dabao powered by its own USB-C):
 *   PB13 (UART2 RX) <- 1k <- ESP32 GPIO17 (TX)
 *   PB14 (UART2 TX) -> 1k -> ESP32 GPIO18 (RX)
 *   GND             -- ESP32 GND
 *   PB3             -> approve button -> GND   (a jumper touched to GND works)
 *   PB1             -> LED -> 330R -> GND      (optional: on while waiting)
 *
 * Only frames are written to UART2, plus one status line at boot that the
 * ESP32 skips (it reads frames by start byte and CRC).
 * Build: firmware/dabao/build.sh   Flash: firmware/dabao/build.sh flash <port>
 */

#include "bao.h"
#include "hardware/rram.h"
#include "hardware/trng.h"
#include "hardware/uart.h"

#define uECC_SUPPORTS_secp160r1 0
#define uECC_SUPPORTS_secp192r1 0
#define uECC_SUPPORTS_secp224r1 0
#define uECC_SUPPORTS_secp256r1 0
#define uECC_SUPPORTS_secp256k1 1

/* Single translation unit: the SDK build compiles one .c file per program. */
#include "hl_signer.c"
#include "third_party/micro-ecc/uECC.c"
#include "third_party/tiny_sha3/sha3.c"

#define LINK_UART 2
#define BUTTON_PORT GPIO_PORT_B
#define BUTTON_PIN 3
#define LED_PORT GPIO_PORT_B
#define LED_PIN 1

#define APPROVE_TIMEOUT_MS 30000
#define BYTE_TIMEOUT_MS 200

/*
 * 1 = sign without a button press (the owner chose hands-free). The limits below
 * then carry the whole load: per order (hl_signer.h), per UTC day, and speed.
 * 0 = also wait for a press on PB3 before every signature.
 */
#define AUTO_APPROVE 1
#define DAILY_LIMIT_MICRO_USD 50000000ULL   /* 50 USD of orders per UTC day */
#define MIN_SIGN_INTERVAL_MS 10000          /* at most one signature per 10 s */

/* 0 = Hyperliquid mainnet ("a"), 1 = testnet ("b"). Orders for the other network are refused. */
#define SIGNER_NETWORK 0
#define SIGNER_VERSION 1

/* RRAM user area (survives reflashing the program region). 32-byte pages. */
#define KEY_ADDR (RRAM_USER_BASE + 0x1000)    /* "GHK1" | key[32] | crc16 -> 64 bytes */
#define NONCE_ADDR (RRAM_USER_BASE + 0x1040)  /* "GHN1" | last nonce u64 | crc16 -> 32 bytes */
#define DAILY_ADDR (RRAM_USER_BASE + 0x1060)  /* "GHD1" | day u32 | spent micro-USD u64 | crc16 */

static uint8_t g_key[32];
static uint64_t g_last_nonce;
static uint32_t g_day;          /* UTC day of the order nonce (ms / 86400000) */
static uint64_t g_day_spent;    /* micro-USD signed on g_day */
static uint64_t g_last_sign_ms; /* millis() of the last signature, 0 = none yet */

/* ------------------------------------------------------------------------ */
/* Persistent state */

static int load_record(uint32_t addr, const char magic[4], uint8_t *data, uint32_t len) {
    uint8_t rec[64];
    rram_read(addr, rec, 4 + len + 2);
    for (int i = 0; i < 4; i++)
        if (rec[i] != (uint8_t)magic[i]) return 0;
    uint16_t crc = hl_crc16(rec, 4 + len);
    if (rec[4 + len] != (uint8_t)crc || rec[5 + len] != (uint8_t)(crc >> 8)) return 0;
    copy(data, rec + 4, len);
    wipe(rec, sizeof rec);
    return 1;
}

static int store_record(uint32_t addr, const char magic[4], const uint8_t *data, uint32_t len) {
    uint8_t rec[64];
    for (uint32_t i = 0; i < sizeof rec; i++) rec[i] = 0xFF;
    copy(rec, magic, 4);
    copy(rec + 4, data, len);
    uint16_t crc = hl_crc16(rec, 4 + len);
    rec[4 + len] = (uint8_t)crc;
    rec[5 + len] = (uint8_t)(crc >> 8);
    int rc = rram_write(addr, rec, 4 + len + 2);
    wipe(rec, sizeof rec);
    return rc == 0;
}

static int trng_bytes(uint8_t *dest, unsigned size) {
    uint32_t w[16];
    unsigned words = (size + 3) / 4;
    if (words > 16 || trng_generate(w, words) != 0) return 0;
    copy(dest, w, size);
    wipe(w, sizeof w);
    return 1;
}

#if __has_include("provision_key.h")
/*
 * One-time provisioning build (firmware/dabao/build.sh provision): writes an existing API wallet key into RRAM.
 * The header exists only for that build and is deleted right after. There is no UART command that sets a key.
 */
#include "provision_key.h"

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void provision_key(void) {
    static const char hex[] = PROVISION_KEY_HEX;
    uint8_t k[32], addr[20];
    if (sizeof hex != 65) return;
    for (int i = 0; i < 32; i++) {
        int hi = hexval(hex[2 * i]), lo = hexval(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) { wipe(k, sizeof k); return; }
        k[i] = (uint8_t)(hi << 4 | lo);
    }
    if (hl_address(k, addr) == HL_OK) store_record(KEY_ADDR, "GHK1", k, 32);
    wipe(k, sizeof k);
}
#endif

/* Loads the key, or makes one from the TRNG on first boot. */
static int key_ready(void) {
    uint8_t addr[20];
#if __has_include("provision_key.h")
    provision_key();
#endif
    if (load_record(KEY_ADDR, "GHK1", g_key, 32) && hl_address(g_key, addr) == HL_OK) return 1;
    for (int tries = 0; tries < 8; tries++) {
        if (!trng_bytes(g_key, 32)) continue;
        if (hl_address(g_key, addr) != HL_OK) continue;  /* zero or >= n: draw again */
        if (store_record(KEY_ADDR, "GHK1", g_key, 32) && load_record(KEY_ADDR, "GHK1", g_key, 32)) return 1;
    }
    wipe(g_key, sizeof g_key);
    return 0;
}

static void store_nonce(uint64_t nonce) {
    uint8_t b[8];
    for (int i = 0; i < 8; i++) b[i] = (uint8_t)(nonce >> (8 * i));
    store_record(NONCE_ADDR, "GHN1", b, 8);
}

static void load_nonce(void) {
    uint8_t b[8];
    g_last_nonce = 0;
    if (!load_record(NONCE_ADDR, "GHN1", b, 8)) return;
    for (int i = 0; i < 8; i++) g_last_nonce |= (uint64_t)b[i] << (8 * i);
}

static void store_daily(void) {
    uint8_t b[12];
    for (int i = 0; i < 4; i++) b[i] = (uint8_t)(g_day >> (8 * i));
    for (int i = 0; i < 8; i++) b[4 + i] = (uint8_t)(g_day_spent >> (8 * i));
    store_record(DAILY_ADDR, "GHD1", b, sizeof b);
}

static void load_daily(void) {
    uint8_t b[12];
    g_day = 0;
    g_day_spent = 0;
    if (!load_record(DAILY_ADDR, "GHD1", b, sizeof b)) return;
    for (int i = 0; i < 4; i++) g_day |= (uint32_t)b[i] << (8 * i);
    for (int i = 0; i < 8; i++) g_day_spent |= (uint64_t)b[4 + i] << (8 * i);
}

/* ------------------------------------------------------------------------ */
/* UART frames */

static int read_byte(uint8_t *out, uint32_t timeout_ms) {
    uint64_t t0 = millis();
    while (!uart_is_readable(LINK_UART)) {
        if (millis() - t0 > timeout_ms) return 0;
    }
    *out = (uint8_t)uart_getc(LINK_UART);
    return 1;
}

/* Waits for one complete, CRC-checked frame. Bytes outside frames are dropped. */
static int read_frame(uint8_t *type, uint8_t *payload, uint16_t *len) {
    uint8_t b, hdr[3], crc[2];
    do {
        if (!read_byte(&b, 0xFFFFFFFF)) return 0;
    } while (b != HL_FRAME_START);
    for (int i = 0; i < 3; i++)
        if (!read_byte(&hdr[i], BYTE_TIMEOUT_MS)) return 0;
    uint16_t n = (uint16_t)(hdr[1] | (hdr[2] << 8));
    if (n > HL_MAX_PAYLOAD) return -1;
    for (uint16_t i = 0; i < n; i++)
        if (!read_byte(&payload[i], BYTE_TIMEOUT_MS)) return 0;
    for (int i = 0; i < 2; i++)
        if (!read_byte(&crc[i], BYTE_TIMEOUT_MS)) return 0;
    uint8_t buf[3 + HL_MAX_PAYLOAD];
    copy(buf, hdr, 3);
    copy(buf + 3, payload, n);
    if (hl_crc16(buf, 3 + n) != (uint16_t)(crc[0] | (crc[1] << 8))) return -1;
    *type = hdr[0];
    *len = n;
    return 1;
}

static void send(uint8_t type, const uint8_t *payload, uint16_t len) {
    uint8_t out[6 + 72];
    uart_write(LINK_UART, out, (uint32_t)hl_frame(type, payload, len, out));
}

static void send_error(uint8_t code) {
    send(HL_RSP_ERROR, &code, 1);
}

/* ------------------------------------------------------------------------ */
/* Approval */

/* True when the button is held for 50 ms within the timeout. The LED is on while waiting. */
static int wait_for_approval(void) {
    if (AUTO_APPROVE) return 1;
    gpio_put(LED_PORT, LED_PIN, true);
    uint64_t t0 = millis();
    int approved = 0;
    while (millis() - t0 < APPROVE_TIMEOUT_MS) {
        if (!gpio_get(BUTTON_PORT, BUTTON_PIN)) {
            delay_ms(50);
            if (!gpio_get(BUTTON_PORT, BUTTON_PIN)) {
                approved = 1;
                break;
            }
        }
    }
    gpio_put(LED_PORT, LED_PIN, false);
    while (approved && !gpio_get(BUTTON_PORT, BUTTON_PIN)) delay_ms(10);  /* wait for release */
    return approved;
}

static void handle_sign(const uint8_t *payload, uint16_t len) {
    hl_order_t o;
    int rc = hl_parse_order(payload, len, &o);
    if (rc == HL_OK) rc = hl_check_order(&o);
    if (rc == HL_OK && o.network != SIGNER_NETWORK) rc = HL_ERR_NETWORK;
    if (rc == HL_OK && o.nonce <= g_last_nonce) rc = HL_ERR_NONCE;
    uint64_t notional = 0;
    uint32_t day = (uint32_t)(o.nonce / 86400000ULL);
    if (rc == HL_OK && !hl_order_notional(&o, &notional)) rc = HL_ERR_NOTIONAL;
    uint64_t spent = day == g_day ? g_day_spent : 0;
    /* Reduce-only orders only shrink positions ("close all"): no daily or speed limit, not counted as spend. */
    if (o.reduce_only) notional = 0;
    if (rc == HL_OK && spent + notional > DAILY_LIMIT_MICRO_USD) rc = HL_ERR_DAILY;
    if (rc == HL_OK && !o.reduce_only && g_last_sign_ms && millis() - g_last_sign_ms < MIN_SIGN_INTERVAL_MS) rc = HL_ERR_RATE;
    if (rc != HL_OK) {
        send_error((uint8_t)rc);
        return;
    }
    if (!wait_for_approval()) {
        send_error(HL_ERR_REJECTED);
        return;
    }
    uint8_t digest[32], sig[64];
    hl_order_digest(&o, digest);
    if (hl_sign(g_key, digest, sig) != HL_OK) {
        send_error(HL_ERR_SIGN);
        return;
    }
    g_last_nonce = o.nonce;
    store_nonce(o.nonce);
    g_day = day;
    g_day_spent = spent + notional;
    store_daily();
    if (!o.reduce_only) g_last_sign_ms = millis();
    send(HL_RSP_SIGNATURE, sig, 64);
    wipe(sig, sizeof sig);
}

int main(void) {
    bao_init();
    trng_init();

    gpio_init(LED_PORT, LED_PIN);
    gpio_set_dir(LED_PORT, LED_PIN, true);
    gpio_put(LED_PORT, LED_PIN, false);
    gpio_init(BUTTON_PORT, BUTTON_PIN);
    gpio_set_dir(BUTTON_PORT, BUTTON_PIN, false);
    gpio_pull_up(BUTTON_PORT, BUTTON_PIN);

    int have_key = key_ready();
    load_nonce();
    load_daily();

    /* One status line at boot (the ESP32 skips bytes outside frames). The address is public. */
    uint8_t addr[20];
    mini_printf("\r\n[ghosty-signer] v%u key=%s addr=0x", SIGNER_VERSION, have_key ? "ok" : "MISSING");
    if (have_key && hl_address(g_key, addr) == HL_OK)
        for (int i = 0; i < 20; i++) mini_printf("%02x", addr[i]);
    mini_printf("\r\n");

    uint8_t payload[HL_MAX_PAYLOAD];
    while (1) {
        uint8_t type;
        uint16_t len;
        int rc = read_frame(&type, payload, &len);
        if (rc == 0) continue;             /* partial frame: resync on the next 0xA5 */
        if (rc < 0) {
            send_error(HL_ERR_FRAME);
            continue;
        }
        if (!have_key) {
            send_error(HL_ERR_KEY);
        } else if (type == HL_CMD_GET_INFO && len == 0) {
            uint8_t info[22];
            hl_address(g_key, info);
            info[20] = SIGNER_NETWORK;
            info[21] = SIGNER_VERSION;
            send(HL_RSP_INFO, info, sizeof info);
        } else if (type == HL_CMD_SIGN_ORDER) {
            handle_sign(payload, len);
        } else {
            send_error(HL_ERR_COMMAND);
        }
    }
}

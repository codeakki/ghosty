/*
 * 06_CloudVoice - push-to-talk round trip with the Ghosty server (skeleton).
 *
 * Purpose: hold the button and speak (max 10 s). On release: WAV header ->
 *   POST GHOSTY_SERVER_URL "/voice" (X-Device-Token) -> stream the raw
 *   s16le 16 kHz mono reply to the speaker in 1024-byte chunks.
 *
 * Expected serial output (115200 baud):
 *   [wifi] connected, ip=192.168.1.42
 *   [rec] 48000 samples (96000 bytes) in 3002 ms
 *   [http] POST /voice -> 200
 *   [play] 64000 bytes played
 *
 * What to check: server log shows the WAV; reply plays without clicks.
 *   401 = token mismatch with server .env; negative code = network error;
 *   503 = brain offline (0G safe-stop): no audio, 3 fast blinks;
 *   any other error: printed, then 5 slow blinks.
 */
#include <GhostyBoard.h>
#include <GhostyNet.h>
#include <WiFi.h>
#if __has_include(<secrets.h>)
#include <secrets.h>
#else
#error "Copy firmware/libraries/GhostyBoard/src/secrets.h.example to secrets.h and fill it in"
#endif

constexpr size_t MAX_SAMPLES = SAMPLE_RATE * 10;  // 10 s cap = 320 KB
constexpr size_t MIN_SAMPLES = SAMPLE_RATE / 4;   // ignore taps < 250 ms
constexpr size_t REC_CHUNK = 256;
constexpr size_t NET_CHUNK = 1024;                // bytes per reply read

I2SClass i2s;
uint8_t *wav = nullptr;  // WAV header + PCM, in PSRAM

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(250);
  Serial.print(WiFi.status() == WL_CONNECTED ? "[wifi] connected, ip=" : "[wifi] FAILED, retry on next press ");
  Serial.println(WiFi.localIP());
}

size_t recordWhileHeld() {
  int16_t *pcm = (int16_t *)(wav + WAV_HEADER_BYTES);
  size_t n = 0;
  while (buttonPressed() && n < MAX_SAMPLES) {
    size_t k = MAX_SAMPLES - n < REC_CHUNK ? MAX_SAMPLES - n : REC_CHUNK;
    size_t got = readMic(i2s, pcm + n, k);
    if (got == 0) break;
    n += got;
  }
  return n;
}

// Reads the raw PCM reply and plays it. Keeps an odd trailing byte for the
// next chunk so samples never split. Returns bytes received.
size_t streamReply(HTTPClient &http) {
  static int16_t pcm[NET_CHUNK / 2 + 1];
  uint8_t *bytes = (uint8_t *)pcm;
  Stream *s = http.getStreamPtr();
  if (!s) return 0;
  int remaining = http.getSize();  // -1 = unknown, read until close
  size_t have = 0, total = 0;
  uint32_t lastData = millis();
  while (remaining != 0 && millis() - lastData < 3000) {
    int avail = s->available();
    if (avail <= 0) {
      if (!http.connected()) break;
      delay(2); continue;
    }
    size_t want = NET_CHUNK - have;
    if ((size_t)avail < want) want = avail;
    if (remaining > 0 && (size_t)remaining < want) want = remaining;
    size_t got = s->readBytes((char *)bytes + have, want);
    lastData = millis();
    have += got, total += got;
    if (remaining > 0) remaining -= got;
    playPcm16(i2s, pcm, have / 2);
    if (have & 1) bytes[0] = bytes[have - 1];
    have &= 1;
  }
  return total;
}

void sendVoice(size_t samples) {
  const uint32_t pcmBytes = samples * sizeof(int16_t);
  writeWavHeader(wav, pcmBytes, SAMPLE_RATE);

  HTTPClient http;
  ghostyHttpBegin(http, GHOSTY_SERVER_URL "/voice");  // TLS when the URL is https://
  http.useHTTP10(true);  // no chunked encoding -> body is raw PCM on the socket
  http.setTimeout(30000);  // STT + agent + TTS can be slow
  http.addHeader("Content-Type", "audio/wav");
  http.addHeader("X-Device-Token", GHOSTY_DEVICE_TOKEN);
  int code = http.POST(wav, WAV_HEADER_BYTES + pcmBytes);
  Serial.printf("[http] POST /voice -> %d\n", code);

  if (code == 200) {
    Serial.printf("[play] %u bytes played\n", (unsigned)streamReply(http));
  } else if (code == 503) {
    // TODO(0G safe-stop): server says the brain (0G Compute) is offline and no
    // trade was placed. Speak nothing; signal with 3 fast blinks.
    Serial.println("[safe-stop] brain offline, no action taken");
    blinkRed(3, 60, 60);
  } else {
    if (code < 0) Serial.printf("[http] error: %s\n", HTTPClient::errorToString(code).c_str());
    blinkRed(5, 200, 200);
  }
  http.end();
}

void setup() {
  ghostyBoardInit();
  wav = (uint8_t *)ps_malloc(WAV_HEADER_BYTES + MAX_SAMPLES * sizeof(int16_t));
  if (!wav || !ghostyI2SBegin(i2s)) {
    Serial.println("[06_CloudVoice] PSRAM or I2S init failed");
    while (true) blinkRed(1, 100, 100);
  }
  connectWiFi();
  Serial.println("[06_CloudVoice] hold the button and talk");
}

void loop() {
  if (!buttonPressed()) { delay(10); return; }
  delay(30);  // debounce
  if (!buttonPressed()) return;

  setRedLed(true);
  uint32_t t0 = millis();
  size_t n = recordWhileHeld();
  setRedLed(false);
  Serial.printf("[rec] %u samples (%u bytes) in %lu ms\n", (unsigned)n,
                (unsigned)(n * sizeof(int16_t)), (unsigned long)(millis() - t0));

  if (n < MIN_SAMPLES) {
    Serial.println("[rec] too short, ignored");
  } else if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] not connected, reconnecting");
    blinkRed(2, 200, 200);
    connectWiFi();
  } else {
    sendVoice(n);
  }
  while (buttonPressed()) delay(10);  // 10 s cap hit while still held
}

/*
 * 07_AlwaysListen - hands-free voice round trip with the Ghosty server.
 *
 * Purpose: no button. The mic listens all the time; a simple level detector
 *   starts recording when someone speaks and stops after 1 s of quiet (max 10 s).
 *   The clip goes to POST GHOSTY_SERVER_URL "/voice" with X-Listen: always, so the
 *   server answers only speech that says "Ghosty" (204 = not for us, stay quiet).
 *   The raw s16le 16 kHz reply plays on the speaker, then listening resumes.
 *   When a spoken order needs a signature the server answers 202 + a frame:
 *   the frame goes to the Dabao (UART, GPIO17/18), which checks and signs it,
 *   and its reply goes to POST /sign, which returns the audio.
 *   While idle it polls GET /announce every 15 s and speaks queued news
 *   signals with their prediction-market and price checks.
 *
 * Say: "Ghosty, put ten dollars into gold."   /   "Ghosty, what is gold at?"
 *
 * Expected serial output (115200 baud):
 *   [wifi] connected, ip=172.20.10.2
 *   [vad] noise floor 38, start level 264
 *   [vad] speech 2310 ms
 *   [http] POST /voice -> 200
 *   [play] 98000 bytes played
 *   (or: [http] POST /voice -> 204 (no wake word))
 *
 * What to check: if it never triggers, speak louder or lower START_FACTOR;
 *   if room noise triggers it, raise START_FACTOR or MIN_START.
 *   503 = brain offline (3 fast blinks); other errors print, then 5 slow blinks.
 */
#include <GhostyBoard.h>
#include <GhostyNet.h>
#include <WiFi.h>
#if __has_include(<secrets.h>)
#include <secrets.h>
#else
#error "Copy firmware/libraries/GhostyBoard/src/secrets.h.example to secrets.h and fill it in"
#endif

constexpr size_t CHUNK = 256;                        // 16 ms at 16 kHz
constexpr size_t MAX_SAMPLES = SAMPLE_RATE * 10;     // 10 s cap = 320 KB
constexpr size_t PRE_ROLL = SAMPLE_RATE;             // keep 1 s before the trigger: in a loud room the
                                                     // trigger fires late and a soft "Ghosty" falls before it
constexpr int START_CHUNKS = 3;                      // ~50 ms above the start level
constexpr int END_QUIET_CHUNKS = 62;                 // ~1 s below the start level
constexpr size_t MIN_SPEECH = SAMPLE_RATE * 2 / 5;   // ignore blips < 400 ms
constexpr float START_FACTOR = 4.0f;                 // start level = floor * factor ...
constexpr uint32_t MIN_START = 200;                  // ... but never below this
constexpr float KEEP_FACTOR = 2.0f;                  // once started, speech continues above floor * this
constexpr size_t NET_CHUNK = 1024;
constexpr float SPEAKER_GAIN = 6.0f;                 // reply loudness; peaks are soft-limited, not clipped
constexpr int32_t LIMIT_KNEE = 20000;                // soft limiter starts here (full scale 32767)

I2SClass i2s;
uint8_t *wav = nullptr;          // WAV header + PCM, in PSRAM
int16_t preRoll[PRE_ROLL];       // ring buffer of the latest samples
size_t preHead = 0;
float noiseFloor = 0;

// Mean distance from the chunk's own average: the INMP441 has a DC offset that
// would otherwise read as constant loud sound.
uint32_t meanAbs(const int16_t *s, size_t n) {
  int32_t dc = 0;
  for (size_t i = 0; i < n; i++) dc += s[i];
  dc /= (int32_t)n;
  uint32_t sum = 0;
  for (size_t i = 0; i < n; i++) sum += (uint32_t)abs((int)s[i] - dc);
  return sum / n;
}

uint32_t startLevel() {
  uint32_t level = (uint32_t)(noiseFloor * START_FACTOR);
  return level < MIN_START ? MIN_START : level;
}

uint32_t keepLevel() {
  uint32_t level = (uint32_t)(noiseFloor * KEEP_FACTOR);
  return level < MIN_START / 2 ? MIN_START / 2 : level;
}

// Louder replies: SPEAKER_GAIN, then a soft knee above LIMIT_KNEE that bends
// peaks toward full scale instead of clipping them flat.
void boost(int16_t *pcm, size_t n) {
  const float room = 32767.0f - LIMIT_KNEE;
  for (size_t i = 0; i < n; i++) {
    float y = pcm[i] * SPEAKER_GAIN;
    float a = fabsf(y);
    if (a > LIMIT_KNEE) {
      float over = a - LIMIT_KNEE;
      a = LIMIT_KNEE + room * over / (over + room);
      y = y < 0 ? -a : a;
    }
    pcm[i] = (int16_t)y;
  }
}

void connectWiFi() {
  WiFi.disconnect(true, false);  // end any half-open attempt, or begin() fails with "sta is connecting"
  delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[wifi] connected, ip=");
    Serial.println(WiFi.localIP());
  } else {
    Serial.printf("[wifi] FAILED, status=%d. Is the hotspot on?\n", (int)WiFi.status());
  }
}

// Reads the mic for `ms` and throws it away (speaker echo, DMA backlog after a request).
void drainMic(uint32_t ms) {
  int16_t buf[CHUNK];
  uint32_t t0 = millis();
  while (millis() - t0 < ms) readMic(i2s, buf, CHUNK);
}

void calibrate() {
  int16_t buf[CHUNK];
  uint64_t total = 0;
  const int n = 60;  // ~1 s
  for (int i = 0; i < n; i++) {
    readMic(i2s, buf, CHUNK);
    total += meanAbs(buf, CHUNK);
  }
  noiseFloor = (float)total / n;
  Serial.printf("[vad] noise floor %u, start level %u\n", (unsigned)noiseFloor, (unsigned)startLevel());
}

constexpr uint32_t ANNOUNCE_POLL_MS = 15000;  // ask the server for news signals this often while idle
constexpr size_t LISTEN_IDLE = SIZE_MAX;        // listen() result: nobody spoke, time to poll

// Waits for speech, then records until 1 s of quiet. Returns samples in wav
// (0 = too short), or LISTEN_IDLE after ANNOUNCE_POLL_MS of silence.
size_t listen() {
  int16_t buf[CHUNK];
  int loud = 0;
  uint32_t waitStart = millis();
  while (true) {
    if (loud == 0 && millis() - waitStart > ANNOUNCE_POLL_MS) return LISTEN_IDLE;
    if (readMic(i2s, buf, CHUNK) != CHUNK) continue;
    uint32_t level = meanAbs(buf, CHUNK);
    for (size_t i = 0; i < CHUNK; i++) preRoll[(preHead + i) % PRE_ROLL] = buf[i];
    preHead = (preHead + CHUNK) % PRE_ROLL;
    if (level > startLevel()) {
      if (++loud >= START_CHUNKS) break;
    } else {
      loud = 0;
      noiseFloor = noiseFloor * 0.98f + level * 0.02f;  // follow slow room changes
    }
  }

  // Speech started: pre-roll first (oldest to newest), then record live.
  int16_t *pcm = (int16_t *)(wav + WAV_HEADER_BYTES);
  size_t n = 0;
  for (size_t i = 0; i < PRE_ROLL; i++) pcm[n++] = preRoll[(preHead + i) % PRE_ROLL];
  size_t voiced = START_CHUNKS * CHUNK;
  int quiet = 0;
  setRedLed(true);
  // Web orb shows "listening" (background task, never delays recording).
  ghostyPodStateAsync(GHOSTY_SERVER_URL "/pod/state", GHOSTY_DEVICE_TOKEN, "listening");
  while (n + CHUNK <= MAX_SAMPLES && quiet < END_QUIET_CHUNKS) {
    size_t got = readMic(i2s, pcm + n, CHUNK);
    if (got == 0) break;
    if (meanAbs(pcm + n, got) > keepLevel()) {
      quiet = 0;
      voiced += got;
    } else {
      quiet++;
    }
    n += got;
  }
  setRedLed(false);
  Serial.printf("[vad] speech %lu ms\n", (unsigned long)(n * 1000 / SAMPLE_RATE));
  return voiced >= MIN_SPEECH ? n : 0;
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
  // 15 s: Wi-Fi here can stall for several seconds; a song should ride that out, not end.
  while (remaining != 0 && millis() - lastData < 15000) {
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
    boost(pcm, have / 2);
    playPcm16(i2s, pcm, have / 2);
    if (have & 1) bytes[0] = bytes[have - 1];
    have &= 1;
  }
  return total;
}

// ---- Error beeps ---------------------------------------------------------
// The server speaks its own errors ("Software error ... your pod hardware is fine").
// These beeps cover the cases where no speech can arrive, so silence never hides
// a software or network problem:
//   2 low beeps        = can't reach the server (Wi-Fi, server not running, timeout)
//   3 high-low beeps   = the server answered with an error and no audio
//   1 long low beep    = Wi-Fi lost and reconnecting failed
void beep(float hz, uint32_t ms) {
  static int16_t buf[256];
  const size_t total = SAMPLE_RATE * ms / 1000;
  const size_t ramp = SAMPLE_RATE / 100;  // 10 ms fade, no clicks
  for (size_t done = 0; done < total; done += 256) {
    for (size_t i = 0; i < 256; i++) {
      size_t n = done + i;
      float g = 1.0f;
      if (n < ramp) g = (float)n / ramp;
      else if (n + ramp > total) g = n >= total ? 0 : (float)(total - n) / ramp;
      buf[i] = (int16_t)(12000.0f * g * sinf(2.0f * PI * hz * n / SAMPLE_RATE));
    }
    playPcm16(i2s, buf, 256);
  }
}

void silence(uint32_t ms) {
  static int16_t zero[256] = {0};
  for (size_t done = 0; done < SAMPLE_RATE * ms / 1000; done += 256) playPcm16(i2s, zero, 256);
}

void errorBeepsUnreachable() {
  Serial.println("[error] beeps: can't reach the server");
  for (int i = 0; i < 2; i++) { beep(330, 250); silence(150); }
}

void errorBeepsServer() {
  Serial.println("[error] beeps: server error without audio");
  for (int i = 0; i < 3; i++) { beep(880, 120); beep(440, 120); silence(120); }
}

void errorBeepWiFi() {
  Serial.println("[error] beep: Wi-Fi lost");
  beep(260, 900);
}

// ---- Dabao signer relay ------------------------------------------------
// The server answers 202 + a frame when an order needs a signature. The frame
// goes to the Dabao unchanged; its reply frame goes back to POST /sign. The
// ESP32 only moves bytes: the server and the Dabao each check the CRC.

constexpr size_t FRAME_MAX = 3200;  // a Uniswap swap frame (~1.4 KB; Dabao limit 3100 + header)
constexpr uint32_t SIGN_WAIT_MS = 35000;  // covers the Dabao's 30 s button wait if AUTO_APPROVE is off

uint16_t crc16(const uint8_t *d, size_t n) {
  uint16_t crc = 0xFFFF;
  while (n--) {
    crc ^= (uint16_t)(*d++) << 8;
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
  }
  return crc;
}

// Error frame the server understands, for when the Dabao never answers.
size_t timeoutFrame(uint8_t *out) {
  out[0] = 0xA5; out[1] = 0xFF; out[2] = 1; out[3] = 0; out[4] = 8;  // 8 = not approved in time
  uint16_t c = crc16(out + 1, 4);
  out[5] = c & 0xFF; out[6] = c >> 8;
  return 7;
}

// Sends `req` to the Dabao and returns its reply frame length (0 = no reply).
size_t dabaoExchange(const uint8_t *req, size_t reqLen, uint8_t *out) {
  while (Serial1.available()) Serial1.read();  // drop boot text or stale bytes
  // 16-byte chunks with a short pause: the Dabao loses bytes in a long burst (a swap frame is ~1.4 KB).
  for (size_t i = 0; i < reqLen; i += 16) {
    Serial1.write(req + i, reqLen - i < 16 ? reqLen - i : 16);
    Serial1.flush();
    delayMicroseconds(2000);
  }
  size_t n = 0, need = 6;
  uint32_t t0 = millis();
  while (millis() - t0 < SIGN_WAIT_MS && n < need) {
    if (!Serial1.available()) { delay(2); continue; }
    uint8_t b = Serial1.read();
    if (n == 0 && b != 0xA5) continue;  // wait for a frame start
    out[n++] = b;
    if (n == 4) {
      need = 6 + (out[2] | (out[3] << 8));
      if (need > FRAME_MAX) n = 0, need = 6;  // not a frame: resync
    }
  }
  return n == need ? n : 0;
}

// One request to the server. Plays a 200 reply. On 202 fills signId + frame
// for the next round and returns 202.
int postOnce(const char *path, const uint8_t *body, size_t len, const char *contentType,
             String &signId, uint8_t *frame, size_t &frameLen) {
  String url = String(GHOSTY_SERVER_URL) + path;
  HTTPClient http;
  ghostyHttpBegin(http, url.c_str());  // TLS when the URL is https://
  http.useHTTP10(true);   // no chunked encoding -> body is raw bytes on the socket
  http.setTimeout(60000); // STT + Claude + order + TTS
  const char *keep[] = {"X-Sign-Id", "X-Ghosty-Error"};
  http.collectHeaders(keep, 2);
  http.addHeader("Content-Type", contentType);
  http.addHeader("X-Device-Token", GHOSTY_DEVICE_TOKEN);
  http.addHeader("X-Listen", "always");
  http.addHeader("X-Ghosty-Client", "pod");  // the web orb mirrors pod turns only
  if (signId.length()) http.addHeader("X-Sign-Id", signId);
  int code = http.POST((uint8_t *)body, len);

  if (code == 202) {
    signId = http.header("X-Sign-Id");
    frameLen = 0;
    Stream *s = http.getStreamPtr();
    int size = http.getSize();
    uint32_t t0 = millis();
    while (s && size > 0 && frameLen < (size_t)size && frameLen < FRAME_MAX && millis() - t0 < 5000) {
      if (s->available()) frame[frameLen++] = s->read(); else delay(1);
    }
    Serial.printf("[http] POST %s -> 202 (sign request, %u bytes)\n", path, (unsigned)frameLen);
  } else if (code == 204) {
    Serial.printf("[http] POST %s -> 204 (no wake word)\n", path);
  } else if (code == 200) {
    String err = http.header("X-Ghosty-Error");
    if (err.length()) Serial.printf("[http] POST %s -> 200, spoken software error: %s\n", path, err.c_str());
    else Serial.printf("[http] POST %s -> 200\n", path);
    size_t played = streamReply(http);
    Serial.printf("[play] %u bytes played\n", (unsigned)played);
    if (played == 0) errorBeepsServer();  // 200 with no audio: still never silent
  } else if (code < 0) {
    Serial.printf("[http] POST %s -> %d (%s)\n", path, code, HTTPClient::errorToString(code).c_str());
    errorBeepsUnreachable();
  } else {
    String err = http.header("X-Ghosty-Error");
    Serial.printf("[http] POST %s -> %d%s%s\n", path, code, err.length() ? ", error: " : "", err.c_str());
    errorBeepsServer();
  }
  http.end();
  return code;
}

void sendVoice(size_t samples) {
  const uint32_t pcmBytes = samples * sizeof(int16_t);
  writeWavHeader(wav, pcmBytes, SAMPLE_RATE);

  String signId;
  static uint8_t frame[FRAME_MAX], reply[FRAME_MAX];
  size_t frameLen = 0;
  int code = postOnce("/voice", wav, WAV_HEADER_BYTES + pcmBytes, "audio/wav", signId, frame, frameLen);
  for (int round = 0; code == 202 && round < 6; round++) {
    Serial.println("[dabao] signing");
    size_t n = dabaoExchange(frame, frameLen, reply);
    if (n == 0) {
      Serial.println("[dabao] no reply");
      n = timeoutFrame(reply);
    } else {
      Serial.printf("[dabao] reply type 0x%02x\n", reply[1]);
    }
    code = postOnce("/sign", reply, n, "application/octet-stream", signId, frame, frameLen);
  }
}

// Between voice turns the agent may need the Dabao (an x402 payment or a swap it started itself).
// GET /sign/next answers 202 + a frame when one is waiting, else 204.
void pollSignRequests() {
  static uint8_t frame[FRAME_MAX], reply[FRAME_MAX];
  for (int round = 0; round < 4; round++) {
    HTTPClient http;
    ghostyHttpBegin(http, GHOSTY_SERVER_URL "/sign/next");
    http.useHTTP10(true);
    http.setTimeout(10000);
    const char *keep[] = {"X-Sign-Id"};
    http.collectHeaders(keep, 1);
    http.addHeader("X-Device-Token", GHOSTY_DEVICE_TOKEN);
    int code = http.GET();
    if (code != 202) {
      if (code != 204) Serial.printf("[sign] GET /sign/next -> %d\n", code);
      http.end();
      return;
    }
    String signId = http.header("X-Sign-Id");
    size_t frameLen = 0;
    Stream *s = http.getStreamPtr();
    int size = http.getSize();
    uint32_t t0 = millis();
    while (s && size > 0 && frameLen < (size_t)size && frameLen < FRAME_MAX && millis() - t0 < 5000) {
      if (s->available()) frame[frameLen++] = s->read(); else delay(1);
    }
    http.end();
    Serial.printf("[sign] background request, %u bytes\n", (unsigned)frameLen);
    size_t n = dabaoExchange(frame, frameLen, reply);
    if (n == 0) {
      Serial.println("[dabao] no reply");
      n = timeoutFrame(reply);
    } else {
      Serial.printf("[dabao] reply type 0x%02x\n", reply[1]);
    }
    size_t unused = 0;
    if (postOnce("/sign", reply, n, "application/octet-stream", signId, frame, unused) != 204) return;
  }
}

// Plays queued audio (songs, reminders, news signals) if the server has some. When the stream is
// cut short (Wi-Fi drop), asks the server to resume from the byte where it stopped, up to 5 times.
void pollAnnouncement() {
  size_t resumeFrom = 0;
  for (int attempt = 0; attempt <= 5; attempt++) {
    HTTPClient http;
    ghostyHttpBegin(http, GHOSTY_SERVER_URL "/announce");
    http.useHTTP10(true);
    http.setTimeout(20000);
    http.addHeader("X-Device-Token", GHOSTY_DEVICE_TOKEN);
    http.addHeader("X-Ghosty-Client", "pod");
    if (resumeFrom) http.addHeader("X-Resume-From", String((unsigned long)resumeFrom));
    int code = http.GET();
    if (code != 200) {
      if (code != 204) Serial.printf("[announce] GET /announce -> %d\n", code);
      http.end();
      return;
    }
    int size = http.getSize();
    if (resumeFrom) Serial.printf("[announce] resuming at byte %u\n", (unsigned)resumeFrom);
    else Serial.println("[announce] audio from the server");
    size_t played = streamReply(http);
    http.end();
    Serial.printf("[play] %u bytes played\n", (unsigned)played);
    if (size <= 0 || played >= (size_t)size) return;  // finished (or unknown length)
    resumeFrom += played & ~(size_t)1;                // whole samples only
    Serial.printf("[play] stream cut after %u of %d bytes, resuming\n", (unsigned)played, size);
  }
  Serial.println("[play] gave up resuming");
}

void setup() {
  ghostyBoardInit();
  wav = (uint8_t *)ps_malloc(WAV_HEADER_BYTES + MAX_SAMPLES * sizeof(int16_t));
  if (!wav || !ghostyI2SBegin(i2s)) {
    Serial.println("[07_AlwaysListen] PSRAM or I2S init failed");
    while (true) blinkRed(1, 100, 100);
  }
  Serial1.begin(115200, SERIAL_8N1, PIN_DABAO_RX, PIN_DABAO_TX);  // Dabao signer link
  connectWiFi();
  drainMic(500);  // mic settles after power-up
  calibrate();
  Serial.println("[07_AlwaysListen] listening. Say \"Ghosty, ...\"");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    // The Wi-Fi radio adds mic noise: measure the floor again with Wi-Fi up.
    if (WiFi.status() == WL_CONNECTED) {
      drainMic(300);
      calibrate();
    } else {
      errorBeepWiFi();
    }
    return;
  }
  // Check for queued audio (songs, announcements) at least every ANNOUNCE_POLL_MS, even in a
  // room that keeps the mic busy: listen() only returns LISTEN_IDLE after 15 s of silence.
  static uint32_t lastPoll = 0;
  size_t n = listen();
  if (n == LISTEN_IDLE || millis() - lastPoll > ANNOUNCE_POLL_MS) {
    if (n != LISTEN_IDLE && n != 0) sendVoice(n);  // answer what was said first
    pollSignRequests();
    pollAnnouncement();
    lastPoll = millis();
    drainMic(300);
    return;
  }
  if (n == 0) {
    Serial.println("[vad] too short, ignored");
    ghostyPodStateAsync(GHOSTY_SERVER_URL "/pod/state", GHOSTY_DEVICE_TOKEN, "idle");
    return;
  }
  sendVoice(n);
  // Right after a reply, check the queue: "play Amplifier" starts the song now, not 15 s later.
  pollAnnouncement();
  lastPoll = millis();
  drainMic(300);  // skip our own reply's tail and the backlog from the request
}

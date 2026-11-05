#include "GhostyBoard.h"

namespace {
constexpr size_t I2S_CHUNK = 256;  // samples per I2S transfer
int32_t rxBuf[I2S_CHUNK];
int32_t txBuf[I2S_CHUNK];

inline void put16(uint8_t *p, uint16_t v) {
  p[0] = v & 0xff;
  p[1] = (v >> 8) & 0xff;
}
inline void put32(uint8_t *p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (v >> (8 * i)) & 0xff;
}
}  // namespace

void ghostyBoardInit(bool powerDownCamera) {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_LED_RED, OUTPUT);
  digitalWrite(PIN_LED_RED, HIGH);  // active LOW -> off
  pinMode(PIN_FLASH_LED, OUTPUT);
  digitalWrite(PIN_FLASH_LED, LOW);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  if (powerDownCamera) {
    pinMode(PIN_CAM_PWDN, OUTPUT);
    digitalWrite(PIN_CAM_PWDN, HIGH);
  }

  Serial.printf("\n[ghosty] board up, PSRAM %u bytes free\n", (unsigned)ESP.getFreePsram());
}

bool ghostyI2SBegin(I2SClass &i2s) {
  // Passing both DOUT and DIN creates TX and RX on the same port.
  i2s.setPins(PIN_I2S_BCLK, PIN_I2S_WS, PIN_I2S_DOUT, PIN_I2S_DIN);
  // INMP441 needs 64 SCK per frame -> 32-bit slots. If the mic reads pure
  // silence, try I2S_STD_SLOT_RIGHT here.
  bool ok = i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_32BIT,
                      I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT);
  Serial.println(ok ? "[ghosty] I2S full duplex ready" : "[ghosty] I2S init FAILED");
  return ok;
}

size_t readMic(I2SClass &i2s, int16_t *out, size_t samples) {
  size_t got = 0;
  while (got < samples) {
    size_t want = samples - got;
    if (want > I2S_CHUNK) want = I2S_CHUNK;
    size_t bytes = i2s.readBytes((char *)rxBuf, want * sizeof(int32_t));
    size_t n = bytes / sizeof(int32_t);
    if (n == 0) break;  // timeout: return what we have
    for (size_t i = 0; i < n; i++) {
      int32_t v = rxBuf[i] >> 14;  // 24-bit data in 32-bit slot, ~4x gain
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      out[got + i] = (int16_t)v;
    }
    got += n;
  }
  return got;
}

void playPcm16(I2SClass &i2s, const int16_t *pcm, size_t samples) {
  size_t done = 0;
  while (done < samples) {
    size_t k = samples - done;
    if (k > I2S_CHUNK) k = I2S_CHUNK;
    for (size_t j = 0; j < k; j++) txBuf[j] = (int32_t)pcm[done + j] << 16;
    i2s.write((uint8_t *)txBuf, k * sizeof(int32_t));
    done += k;
  }
}

bool buttonPressed() {
  return digitalRead(PIN_BUTTON) == LOW;
}

void setRedLed(bool on) {
  digitalWrite(PIN_LED_RED, on ? LOW : HIGH);
}

void blinkRed(uint8_t times, uint16_t onMs, uint16_t offMs) {
  for (uint8_t i = 0; i < times; i++) {
    setRedLed(true);
    delay(onMs);
    setRedLed(false);
    delay(offMs);
  }
}

void writeWavHeader(uint8_t *dst, uint32_t pcmBytes, uint32_t rate) {
  const uint16_t channels = 1, bits = 16;
  const uint16_t blockAlign = channels * bits / 8;
  memcpy(dst + 0, "RIFF", 4);
  put32(dst + 4, 36 + pcmBytes);
  memcpy(dst + 8, "WAVE", 4);
  memcpy(dst + 12, "fmt ", 4);
  put32(dst + 16, 16);  // fmt chunk size
  put16(dst + 20, 1);   // PCM
  put16(dst + 22, channels);
  put32(dst + 24, rate);
  put32(dst + 28, rate * blockAlign);  // byte rate
  put16(dst + 32, blockAlign);
  put16(dst + 34, bits);
  memcpy(dst + 36, "data", 4);
  put32(dst + 40, pcmBytes);
}

/*
 * 04_SpeakerTest - MAX98357A tone test.
 *
 * Purpose: play a 440 Hz sine for 1 s every 3 s through playPcm16(), using
 *   the same full-duplex I2S setup as the mic.
 *
 * Expected serial output (115200 baud):
 *   [ghosty] I2S full duplex ready
 *   [tone] 440 Hz for 1000 ms
 *   [tone] done in 1003 ms
 *   (repeats every 3 s)
 *
 * What to check:
 *   - A clean "A" tone, red LED on while it plays, silence in between.
 *   - Silence: check DIN on GPIO12, BCLK 14, LRC 15, amp VIN on 5V, GND.
 *   - Board resets when the tone starts: power brownout. Feed the amp from the
 *     5V boost and add a 470-1000 uF cap (hardware/wiring.md).
 *   - Board boot-loops after wiring the amp: GPIO12 is held HIGH at reset.
 */
#include <GhostyBoard.h>
#include <math.h>

constexpr float TONE_HZ = 440.0f;
constexpr uint32_t TONE_MS = 1000;
constexpr float AMPLITUDE = 8000.0f;          // ~ -12 dBFS, gentle on small speakers
constexpr size_t RAMP = SAMPLE_RATE / 100;    // 10 ms fade in/out, avoids clicks
constexpr size_t CHUNK = 256;

I2SClass i2s;
int16_t chunk[CHUNK];

void playTone(float hz, uint32_t ms) {
  const size_t total = (size_t)SAMPLE_RATE * ms / 1000;
  const float step = 2.0f * PI * hz / SAMPLE_RATE;
  float phase = 0;
  for (size_t done = 0; done < total;) {
    size_t k = total - done;
    if (k > CHUNK) k = CHUNK;
    for (size_t j = 0; j < k; j++) {
      size_t idx = done + j;
      float env = 1.0f;
      if (idx < RAMP) env = (float)idx / RAMP;
      else if (total - idx < RAMP) env = (float)(total - idx) / RAMP;
      chunk[j] = (int16_t)(AMPLITUDE * env * sinf(phase));
      phase += step;
      if (phase > 2.0f * PI) phase -= 2.0f * PI;
    }
    playPcm16(i2s, chunk, k);
    done += k;
  }
}

void setup() {
  ghostyBoardInit();
  if (!ghostyI2SBegin(i2s)) {
    while (true) blinkRed(1, 100, 100);
  }
}

void loop() {
  Serial.printf("[tone] %.0f Hz for %lu ms\n", TONE_HZ, (unsigned long)TONE_MS);
  uint32_t t0 = millis();
  setRedLed(true);
  playTone(TONE_HZ, TONE_MS);
  setRedLed(false);
  Serial.printf("[tone] done in %lu ms\n", (unsigned long)(millis() - t0));
  delay(2000);  // TX auto-clears to silence when idle
}

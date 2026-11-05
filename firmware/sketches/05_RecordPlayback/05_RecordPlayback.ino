/*
 * 05_RecordPlayback - mic -> PSRAM -> speaker loop.
 *
 * Purpose: press the button, record 5 s into a 160 KB PSRAM buffer, then play
 *   it straight back. Proves mic, amp, PSRAM and the button work together.
 *
 * Expected serial output (115200 baud):
 *   [05_RecordPlayback] buffer 160000 bytes in PSRAM. Press the button.
 *   [rec] recording 5 s...
 *   [rec] 80000 samples (160000 bytes) in 5001 ms, peak 12034
 *   [play] playing back...
 *   [play] done in 5003 ms
 *
 * What to check:
 *   - You hear your own voice back, at similar volume and pitch.
 *   - "ps_malloc failed" = PSRAM disabled (Tools > PSRAM: Enabled).
 *   - Chipmunk or slow-motion voice = sample rate mismatch between RX and TX.
 *   - Peak near 0 = mic problem (go back to 03_MicTest).
 */
#include <GhostyBoard.h>

constexpr uint32_t RECORD_SECONDS = 5;
constexpr size_t REC_SAMPLES = SAMPLE_RATE * RECORD_SECONDS;  // 80000
constexpr size_t REC_BYTES = REC_SAMPLES * sizeof(int16_t);   // 160000

I2SClass i2s;
int16_t *rec = nullptr;

void fail(const char *msg) {
  Serial.println(msg);
  while (true) blinkRed(1, 100, 100);
}

void setup() {
  ghostyBoardInit();
  if (!psramFound()) fail("[05_RecordPlayback] no PSRAM found");
  rec = (int16_t *)ps_malloc(REC_BYTES);
  if (!rec) fail("[05_RecordPlayback] ps_malloc failed");
  if (!ghostyI2SBegin(i2s)) fail("[05_RecordPlayback] I2S init failed");
  Serial.printf("[05_RecordPlayback] buffer %u bytes in PSRAM. Press the button.\n",
                (unsigned)REC_BYTES);
}

void loop() {
  if (!buttonPressed()) {
    delay(10);
    return;
  }
  delay(30);  // debounce
  if (!buttonPressed()) return;

  Serial.printf("[rec] recording %lu s...\n", (unsigned long)RECORD_SECONDS);
  setRedLed(true);
  uint32_t t0 = millis();
  size_t got = readMic(i2s, rec, REC_SAMPLES);
  uint32_t recMs = millis() - t0;
  setRedLed(false);

  int peak = 0;
  for (size_t i = 0; i < got; i++) {
    int v = abs((int)rec[i]);
    if (v > peak) peak = v;
  }
  Serial.printf("[rec] %u samples (%u bytes) in %lu ms, peak %d\n", (unsigned)got,
                (unsigned)(got * sizeof(int16_t)), (unsigned long)recMs, peak);

  Serial.println("[play] playing back...");
  t0 = millis();
  playPcm16(i2s, rec, got);
  Serial.printf("[play] done in %lu ms\n", (unsigned long)(millis() - t0));

  while (buttonPressed()) delay(10);  // wait for release before re-arming
  Serial.println("Press the button to record again.");
}

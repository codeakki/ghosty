/*
 * 03_MicTest - INMP441 level meter.
 *
 * Purpose: start the shared full-duplex I2S port and show the mic level.
 *   Every 100 ms (1600 samples) it prints RMS, peak, dBFS and a text bar.
 *
 * Expected serial output (115200 baud):
 *   [ghosty] I2S full duplex ready
 *   rms    42 peak   180  -57.8 dBFS |#
 *   rms  2210 peak  9800  -23.4 dBFS |##########################
 *   (quiet room: short bar; talking or clapping: long bar)
 *
 * What to check:
 *   - The bar reacts to your voice. Constant 0 = no data: check SD on GPIO13,
 *     L/R to GND, VDD on 3V3, then try I2S_STD_SLOT_RIGHT in GhostyBoard.cpp.
 *   - Peak pinned at 32767 while quiet = wiring noise or wrong slot.
 */
#include <GhostyBoard.h>
#include <math.h>

constexpr size_t WINDOW = SAMPLE_RATE / 10;  // 100 ms
constexpr int BAR_WIDTH = 50;

I2SClass i2s;
int16_t samples[WINDOW];

void setup() {
  ghostyBoardInit();
  if (!ghostyI2SBegin(i2s)) {
    while (true) blinkRed(1, 100, 100);
  }
  Serial.println("[03_MicTest] speak or clap near the mic");
}

void loop() {
  size_t n = readMic(i2s, samples, WINDOW);
  if (n == 0) {
    Serial.println("[mic] no data (I2S read timeout)");
    return;
  }

  // Remove DC offset, then RMS.
  double sum = 0, sumSq = 0;
  int peak = 0;
  for (size_t i = 0; i < n; i++) {
    int v = samples[i];
    sum += v;
    sumSq += (double)v * v;
    if (abs(v) > peak) peak = abs(v);
  }
  double mean = sum / n;
  double var = sumSq / n - mean * mean;
  double rms = var > 0 ? sqrt(var) : 0;
  double dbfs = 20.0 * log10(rms / 32768.0 + 1e-9);

  // Map -60..0 dBFS onto the bar.
  int len = (int)((dbfs + 60.0) / 60.0 * BAR_WIDTH);
  if (len < 0) len = 0;
  if (len > BAR_WIDTH) len = BAR_WIDTH;
  char bar[BAR_WIDTH + 1];
  memset(bar, '#', len);
  bar[len] = '\0';

  setRedLed(dbfs > -30.0);
  Serial.printf("rms %5u peak %5d %6.1f dBFS |%s\n", (unsigned)rms, peak, dbfs, bar);
}

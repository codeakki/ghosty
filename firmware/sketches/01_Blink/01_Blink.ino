/*
 * 01_Blink - first sign of life.
 *
 * Purpose: prove the toolchain, upload path and GhostyBoard library work.
 *   Blinks the small red LED on GPIO33 (active LOW; the board has no
 *   LED_BUILTIN) once per second and prints a heartbeat.
 *
 * Expected serial output (115200 baud):
 *   [ghosty] board up, PSRAM 4xxxxxx bytes free
 *   [01_Blink] hello from Ghosty
 *   heartbeat 1
 *   heartbeat 2
 *   ...
 *
 * What to check:
 *   - Red LED blinks at 1 Hz. The big white flash LED (GPIO4) stays OFF.
 *   - PSRAM is non-zero (Tools > PSRAM: Enabled). If it is 0, later sketches fail.
 *   - If nothing prints: press RESET after upload, and make sure GPIO0 is
 *     no longer tied to GND (or use the ESP32-CAM-MB base board).
 */
#include <GhostyBoard.h>

uint32_t beats = 0;

void setup() {
  ghostyBoardInit();
  Serial.println("[01_Blink] hello from Ghosty");
}

void loop() {
  setRedLed(true);
  Serial.printf("heartbeat %lu\n", (unsigned long)++beats);
  delay(500);
  setRedLed(false);
  delay(500);
}

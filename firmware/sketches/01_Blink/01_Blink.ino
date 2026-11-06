/*
 * 01_Blink - first sign of life.
 *
 * Purpose: prove the toolchain, upload path and GhostyBoard library work.
 *   Prints a heartbeat once per second. The ESP32-S3 board has no plain red
 *   LED (PIN_LED_RED is -1), so the LED calls do nothing.
 *
 * Expected serial output (115200 baud):
 *   [ghosty] board up, PSRAM 8xxxxxx bytes free
 *   [01_Blink] hello from Ghosty
 *   heartbeat 1
 *   heartbeat 2
 *   ...
 *
 * What to check:
 *   - PSRAM is about 8 MB (Tools > PSRAM: OPI PSRAM). If it is 0, later sketches fail.
 *   - If nothing prints: use the COM USB-C port with USB CDC On Boot: Disabled,
 *     and press RST after upload.
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

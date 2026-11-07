/*
 * 08_DabaoBridge - USB serial <-> Dabao UART bridge, for testing the signer.
 *
 * Purpose: lets a computer talk to the Dabao signer through the ESP32. Every
 *   byte from USB goes to the Dabao and every byte from the Dabao goes to USB,
 *   unchanged. Use it to read the Dabao address or send test frames
 *   (server/src/scripts/dabaoCheck.ts).
 *
 * Wiring: GPIO17 (TX) -> 1k -> Dabao PB13, Dabao PB14 -> 1k -> GPIO18 (RX), GND.
 * Both ports run at 115200 8N1. Nothing else is printed, so frames stay clean.
 */
#include <Arduino.h>
#include <pins.h>

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200, SERIAL_8N1, PIN_DABAO_RX, PIN_DABAO_TX);
}

void loop() {
  while (Serial.available()) Serial1.write(Serial.read());
  while (Serial1.available()) Serial.write(Serial1.read());
}

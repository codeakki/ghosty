// pins.h - Ghosty pod pin map (AI Thinker ESP32-CAM).
// Full wiring and power notes: hardware/wiring.md
//
// BOOT WARNINGS (read before wiring):
//  - GPIO12 is a strapping pin (flash voltage). If it is HIGH at reset the
//    board boot-loops with "flash read err". Only the amp DIN (an input) may
//    sit on GPIO12. Never put the mic SD output on GPIO12.
//  - GPIO2 is a strapping pin for download mode. The button goes GPIO2 -> GND
//    and uses INPUT_PULLUP. Never tie GPIO2 to 3V3.
//  - GPIO2/4/12/13/14/15 are the SD card pins: never call SD_MMC.begin().
//  - GPIO16/17 are used by PSRAM: do not use them.
#pragma once

// I2S, one port in full duplex. Mic and amp share BCLK and WS.
#ifndef PIN_I2S_BCLK
#define PIN_I2S_BCLK 14   // INMP441 SCK + MAX98357A BCLK
#endif
#ifndef PIN_I2S_WS
#define PIN_I2S_WS 15     // INMP441 WS + MAX98357A LRC
#endif
#ifndef PIN_I2S_DOUT
#define PIN_I2S_DOUT 12   // ESP32 -> MAX98357A DIN (strapping pin, see above)
#endif
#ifndef PIN_I2S_DIN
#define PIN_I2S_DIN 13    // INMP441 SD -> ESP32 (L/R tied to GND = left slot)
#endif

// User I/O
#ifndef PIN_BUTTON
#define PIN_BUTTON 2      // to GND, INPUT_PULLUP, pressed = LOW
#endif
#ifndef PIN_LED_RED
#define PIN_LED_RED 33    // small red LED, active LOW (board has no LED_BUILTIN)
#endif
#ifndef PIN_FLASH_LED
#define PIN_FLASH_LED 4   // very bright flash LED, keep LOW
#endif
#ifndef PIN_CAM_PWDN
#define PIN_CAM_PWDN 32   // camera power-down, HIGH = sensor off
#endif

// Audio format used everywhere (device and server): s16le, mono, 16 kHz.
#ifndef SAMPLE_RATE
#define SAMPLE_RATE 16000
#endif

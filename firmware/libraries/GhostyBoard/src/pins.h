// pins.h - Ghosty pod pin map (ESP32-S3 N16R8, DevKitC-style board).
// Build with esp32:esp32:esp32s3, Flash Size 16MB, PSRAM "OPI PSRAM".
// Full wiring and power notes: hardware/wiring.md
// Any pin can be overridden with a -D build flag. -1 = not present.
//
// PIN WARNINGS (read before wiring):
//  - GPIO0, GPIO3, GPIO45, GPIO46 are strapping pins: do not use them.
//  - GPIO19/20 are the native USB port. GPIO26-37 are flash and octal PSRAM.
//  - GPIO17/18 are kept free for the Dabao UART link (TX/RX).
//  - On many N16R8 clones the 5V pin outputs nothing while the board runs from
//    USB (a diode blocks it). Feed the amp VIN from 3V3, or bridge the IN-OUT pad.
#pragma once

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error "Ghosty pins are for the ESP32-S3. Select ESP32S3 Dev Module (esp32:esp32:esp32s3)."
#endif

// I2S, one port in full duplex. Mic and amp share BCLK and WS.
#ifndef PIN_I2S_BCLK
#define PIN_I2S_BCLK 4    // INMP441 SCK + MAX98357A BCLK
#endif
#ifndef PIN_I2S_WS
#define PIN_I2S_WS 5      // INMP441 WS + MAX98357A LRC
#endif
#ifndef PIN_I2S_DOUT
#define PIN_I2S_DOUT 7    // ESP32 -> MAX98357A DIN
#endif
#ifndef PIN_I2S_DIN
#define PIN_I2S_DIN 6     // INMP441 SD -> ESP32 (L/R tied to GND = left slot)
#endif

// User I/O
#ifndef PIN_BUTTON
#define PIN_BUTTON 15     // to GND, INPUT_PULLUP, pressed = LOW
#endif
#ifndef PIN_LED_RED
#define PIN_LED_RED -1    // no plain red LED on this board
#endif
#ifndef PIN_FLASH_LED
#define PIN_FLASH_LED -1  // no flash LED
#endif
#ifndef PIN_CAM_PWDN
#define PIN_CAM_PWDN -1   // no camera
#endif

// Audio format used everywhere (device and server): s16le, mono, 16 kHz.
#ifndef SAMPLE_RATE
#define SAMPLE_RATE 16000
#endif

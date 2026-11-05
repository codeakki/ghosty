// GhostyBoard.h - shared helpers for every Ghosty sketch.
//
// Audio runs on ONE I2S port in full duplex: the INMP441 mic (RX) and the
// MAX98357A amp (TX) share BCLK/WS, so both directions use the same format:
// 16 kHz, 32-bit slots, mono, left slot. Helpers convert to/from int16.
#pragma once

#include <Arduino.h>
#include <ESP_I2S.h>
#include "pins.h"

constexpr size_t WAV_HEADER_BYTES = 44;

// Serial 115200, red LED off, flash LED LOW, button INPUT_PULLUP,
// optionally powers the camera sensor down (PWDN HIGH).
void ghostyBoardInit(bool powerDownCamera = true);

// Starts the shared full-duplex I2S port. Returns false on failure.
bool ghostyI2SBegin(I2SClass &i2s);

// Blocks until `samples` mic samples are read (or the port times out).
// Returns the number of int16 samples written to `out`.
size_t readMic(I2SClass &i2s, int16_t *out, size_t samples);

// Plays int16 mono PCM at SAMPLE_RATE. Blocks until queued in DMA.
void playPcm16(I2SClass &i2s, const int16_t *pcm, size_t samples);

// True while the button is held (GPIO2 pulled to GND).
bool buttonPressed();

// Red LED helpers (handles the active-LOW wiring).
void setRedLed(bool on);
void blinkRed(uint8_t times, uint16_t onMs = 100, uint16_t offMs = 100);

// Writes a 44-byte RIFF/WAVE header for 16-bit mono PCM into dst.
void writeWavHeader(uint8_t *dst, uint32_t pcmBytes, uint32_t rate = SAMPLE_RATE);

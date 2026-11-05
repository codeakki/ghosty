# Wiring guide

Board: ESP32-CAM (AI Thinker). Parts: [BOM.md](BOM.md). Pin constants live in `firmware/libraries/GhostyBoard/src/pins.h`.

## Pin table

| Module | Module pin | ESP32-CAM pin | `pins.h` name |
|---|---|---|---|
| INMP441 mic | VDD | 3V3 | |
| INMP441 mic | GND | GND | |
| INMP441 mic | L/R | GND (left slot) | |
| INMP441 mic | SCK | GPIO14 | `PIN_I2S_BCLK` |
| INMP441 mic | WS | GPIO15 | `PIN_I2S_WS` |
| INMP441 mic | SD | GPIO13 | `PIN_I2S_DIN` |
| MAX98357A amp | VIN | 5V (from boost) | |
| MAX98357A amp | GND | GND | |
| MAX98357A amp | BCLK | GPIO14 | `PIN_I2S_BCLK` |
| MAX98357A amp | LRC | GPIO15 | `PIN_I2S_WS` |
| MAX98357A amp | DIN | GPIO12 | `PIN_I2S_DOUT` |
| MAX98357A amp | GAIN | not connected (9 dB) | |
| Speaker | + / − | Amp + / − | |
| Push button | leg 1 / leg 2 | GPIO2 / GND | `PIN_BUTTON` |
| Onboard red LED | — | GPIO33 (on when LOW) | `PIN_LED_RED` |
| Onboard flash LED | — | GPIO4 (very bright; keep LOW) | `PIN_FLASH_LED` |
| Camera power-down | — | GPIO32 (HIGH = sensor off) | `PIN_CAM_PWDN` |

Sample rate: 16 kHz (`SAMPLE_RATE 16000`).

## I2S: one port, full duplex, shared clocks

- Mic and amp sit on **one** I2S port. BCLK (GPIO14) and WS (GPIO15) are shared; data goes out on GPIO12 and comes in on GPIO13.
- `ESP_I2S`: `i2s.setPins(14, 15, 12, 13)` creates TX and RX together. Both directions must use the same sample rate, bit width, and slot config.
- The INMP441 needs 64 SCK per frame and outputs 24-bit data, so run both directions at **16 kHz with 32-bit slots**, mono, left slot.
- Speaker: convert int16 → int32 with `<< 16`. Mic: int32 → int16 with `>> 14` (about 4x gain).
- L/R on the mic goes to GND (left slot). If the mic reads silence, try `I2S_STD_SLOT_RIGHT`.
- Use `ESP_I2S.h` only. The legacy `driver/i2s.h` is deprecated and cannot coexist with it.

## Strapping pins and boot warnings

> **GPIO12 (amp DIN)** sets the flash voltage at reset. If anything pulls it HIGH at reset, the board boot-loops with `flash read err`. The amp's DIN is an input, so it is safe. **Never put the mic's SD output on GPIO12.** Last-resort fix: `espefuse set-flash-voltage 3.3V` (irreversible).

> **GPIO2 (button)** must be LOW or floating to enter download mode. Wire the button between GPIO2 and GND and use `INPUT_PULLUP`. **Never tie GPIO2 to 3V3.**

> **SD card pins:** GPIO2, 4, 12, 13, 14, 15 are wired to the microSD slot. **Never call `SD_MMC.begin()`** and leave the slot empty.

Other notes:

- GPIO15 only affects the boot log output.
- GPIO14 may toggle at boot, which can cause a click from the speaker (unverified).
- GPIO16 / GPIO17 are used by PSRAM. Do not use them.

## Power

```
LiPo 3.7 V ──► TP4056 B+/B−
               TP4056 OUT+/OUT− ──► [slide switch] ──► 5 V boost IN
                                                      5 V boost OUT ──┬─► ESP32-CAM 5V / GND
                                                                      ├─► MAX98357A VIN / GND
                                                                      └─► 470–1000 µF cap across 5V/GND
```

- Do not feed the LiPo straight into the 5V pin. The onboard AMS1117 regulator needs about 1.1 V of headroom, so 3.0–4.2 V browns out under WiFi plus audio and the board resets.
- Feed the amp VIN from the boost output, not from 3V3.
- Put the 470–1000 µF capacitor close to the board's 5V / GND pins. Check polarity.
- Charge the LiPo through the TP4056 micro-USB port. Do not charge and flash at the same time until the power path is verified with a multimeter.
- INMP441 VDD stays on 3V3 (from the onboard regulator).

## Flashing

- Easiest: seat the ESP32-CAM on the **ESP32-CAM-MB** base board and use the micro-USB port. Select **AI Thinker ESP32-CAM** in Arduino IDE.
- Without the MB board: connect a USB-serial adapter, pull **GPIO0 to GND**, press reset, upload, then release GPIO0 and reset again.
- If upload fails, unplug the button and the amp (GPIO2 and GPIO12) and retry. That isolates strapping-pin problems.
- Windows may need the CH340 driver for the MB board.

## Test order

Do these in order. Do not move on until the current step passes.

| Step | Sketch / check | Pass condition |
|---|---|---|
| 1. Blink | `01_Blink` | Red LED on GPIO33 blinks |
| 2. WiFi | `02_WiFiTest` | Serial shows IP and RSSI |
| 3. Mic | `03_MicTest` | RMS value jumps when you speak |
| 4. Speaker | `04_SpeakerTest` | Clean tone, no reset |
| 5. Record / playback | `05_RecordPlayback` | Your 5 s recording plays back |
| 6. Cloud | `06_CloudVoice` | Hold button, speak, hear the server reply |
| 7. Battery | All of the above on LiPo + boost | No brownout during WiFi + audio; 5V rail stays above 4.8 V |
| 8. Shell | Assemble into enclosure | Button reachable, speaker unobstructed, still passes step 6 |

Photos of each stage go in [photos/](photos/).

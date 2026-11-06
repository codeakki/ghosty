# Wiring guide

Board: ESP32-S3 N16R8 (DevKitC-style, two USB-C ports labelled COM and USB). Parts: [BOM.md](BOM.md). Pin constants live in `firmware/libraries/GhostyBoard/src/pins.h`. What we measured on the real hardware, and the fixes: [bringup-esp32s3.md](bringup-esp32s3.md).

## Pin table

Header positions count from the antenna end, USB ports at the bottom. Left row: 3V3, 3V3, RST, GPIO4, GPIO5, GPIO6, GPIO7, GPIO15, GPIO16, GPIO17, GPIO18, … 5V, GND. Right row: GND, TX, RX, … GND, GND. Clone boards vary: always check the printed label.

| Module | Module pin | ESP32-S3 pin | Header position | `pins.h` name |
|---|---|---|---|---|
| INMP441 mic | VDD | 3V3 | left 1 | |
| INMP441 mic | GND | GND | right 1 | |
| INMP441 mic | L/R | GND (left slot) | right 22 | |
| INMP441 mic | SCK | GPIO4 | left 4 | `PIN_I2S_BCLK` |
| INMP441 mic | WS | GPIO5 | left 5 | `PIN_I2S_WS` |
| INMP441 mic | SD | GPIO6 | left 6 | `PIN_I2S_DIN` |
| MAX98357A amp | VIN | 3V3 (see [Power](#power)) | left 2 | |
| MAX98357A amp | GND | GND | left 22 | |
| MAX98357A amp | BCLK | GPIO4 (shared with mic SCK) | left 4 | `PIN_I2S_BCLK` |
| MAX98357A amp | LRC | GPIO5 (shared with mic WS) | left 5 | `PIN_I2S_WS` |
| MAX98357A amp | DIN | GPIO7 | left 7 | `PIN_I2S_DOUT` |
| MAX98357A amp | GAIN, SD | not connected (9 dB, always on) | | |
| Speaker | + / − | Amp + / − (never to GND) | | |
| Push button | leg 1 / leg 2 | GPIO15 / GND | left 8 | `PIN_BUTTON` |
| Dabao (optional) | PB13 UART2 RX | GPIO17 (TX), 1 kΩ in series | left 10 | |
| Dabao (optional) | PB14 UART2 TX | GPIO18 (RX), 1 kΩ in series | left 11 | |
| Dabao (optional) | GND | GND | right 21 | |

The board has no plain red LED, flash LED, or camera, so `PIN_LED_RED`, `PIN_FLASH_LED` and `PIN_CAM_PWDN` are `-1` and the library skips them.

Sample rate: 16 kHz (`SAMPLE_RATE 16000`).

## I2S: one port, full duplex, shared clocks

- Mic and amp sit on **one** I2S port. BCLK (GPIO4) and WS (GPIO5) are shared; data goes out on GPIO7 and comes in on GPIO6.
- Split GPIO4 and GPIO5 to the mic and the amp through one breadboard row each. Never put both signals in the same row.
- `ESP_I2S`: `i2s.setPins(4, 5, 7, 6)` creates TX and RX together. Both directions must use the same sample rate, bit width, and slot config.
- The INMP441 needs 64 SCK per frame and outputs 24-bit data, so run both directions at **16 kHz with 32-bit slots**, mono, left slot.
- Speaker: convert int16 → int32 with `<< 16`. Mic: int32 → int16 with `>> 14` (about 4x gain).
- L/R on the mic goes to GND (left slot). If the mic reads silence, try `I2S_STD_SLOT_RIGHT`.
- Use `ESP_I2S.h` only. The legacy `driver/i2s.h` is deprecated and cannot coexist with it.

## Pins to avoid

- **GPIO0, GPIO3, GPIO45, GPIO46** are strapping pins. Leave them free.
- **GPIO19 / GPIO20** are the native USB port.
- **GPIO26–37** are used by the 16 MB flash and the octal PSRAM. Do not use them.
- **GPIO17 / GPIO18** are kept free for the Dabao UART link.

## Power

```
LiPo 3.7 V ──► TP4056 B+/B−
               TP4056 OUT+/OUT− ──► [slide switch] ──► 5 V boost IN
                                                      5 V boost OUT ──┬─► ESP32-S3 5V / GND (input)
                                                                      ├─► MAX98357A VIN / GND
                                                                      └─► 470–1000 µF cap across 5V/GND
```

- **The 5V pin is dead on many N16R8 clones while the board runs from USB.** A diode blocks USB power from reaching it, so it reads about 0 V. On USB power, feed the amp VIN from 3V3 (quieter, but it works), or bridge the **IN-OUT** solder pad to get 5 V on that pin.
- The same diode still lets an external 5 V supply power the board through the 5V pin, so the battery path above works.
- Do not feed the LiPo straight into the 5V or 3V3 pin. A full LiPo is 4.2 V.
- Put the 470–1000 µF capacitor close to the board's 5V / GND pins. Check polarity.
- Charge the LiPo through the TP4056 USB port. Do not charge and flash at the same time until the power path is verified with a multimeter.
- INMP441 VDD stays on 3V3 (from the onboard regulator).

## Flashing

- Use the **COM** USB-C port (USB-to-serial bridge). It resets the board into download mode by itself, so no buttons are needed.
- Arduino IDE: **ESP32S3 Dev Module**, Flash Size **16MB**, PSRAM **OPI PSRAM**, **USB CDC On Boot: Disabled** (so `Serial` goes to the COM port).
- On the **USB** port instead, set USB CDC On Boot to Enabled, and if the upload cannot connect: hold **BOOT**, tap **RST**, release BOOT, upload, then tap RST.
- Windows may need the CH343 / CH340 driver for the COM port.

## Test order

Do these in order. Do not move on until the current step passes.

| Step | Sketch / check | Pass condition |
|---|---|---|
| 1. Blink | `01_Blink` | Heartbeat prints, PSRAM about 8 MB |
| 2. WiFi | `02_WiFiTest` | Serial shows IP and RSSI |
| 3. Mic | `03_MicTest` | RMS value jumps when you speak |
| 4. Speaker | `04_SpeakerTest` | Clean tone, no reset |
| 5. Record / playback | `05_RecordPlayback` | Your 5 s recording plays back |
| 6. Cloud | `06_CloudVoice` | Hold button, speak, hear the server reply |
| 7. Battery | All of the above on LiPo + boost | No brownout during WiFi + audio; 5V rail stays above 4.8 V |
| 8. Shell | Assemble into enclosure | Button reachable, speaker unobstructed, still passes step 6 |

Photos of each stage go in [photos/](photos/).

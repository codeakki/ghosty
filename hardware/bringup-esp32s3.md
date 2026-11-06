# ESP32-S3 bring-up log (2026-11-06)

What we wired, what we measured, what broke and how we fixed it, on the real hardware. Pin constants: `firmware/libraries/GhostyBoard/src/pins.h`. Wiring table: [wiring.md](wiring.md).

## Status

| Part | Status | Proof |
|---|---|---|
| ESP32-S3 N16R8 board, upload, PSRAM | Working | `Free PSRAM: 8386096 bytes` on serial |
| INMP441 mic | Working | 10 s recordings with 0 % dropouts; Whisper transcribed "Hello, hi, how are you?" |
| MAX98357A amp + 40 mm speaker | Working (amp VIN on 3V3) | 440 Hz tone, speech ("Hello, how are you?") and a streamed MP3 played |
| Dabao (Baochip-1x) UART link | Planned, not wired | Pins and voltage checked against the Dabao schematic |
| Ghost enclosure | Designed, not printed | STL files in [enclosure/](enclosure/) |

## Toolchain

- `arduino-cli` (Homebrew) with core **esp32:esp32 3.3.12**. The core is about 1.4 GB to download and 3–5 GB installed. The first `core install` stopped with `context canceled`; running it again resumed from the cache.
- FQBN: `esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB`, plus `CDCOnBoot=default` on the COM port or `CDCOnBoot=cdc` on the native USB port.

```bash
FQBN="esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,CDCOnBoot=default,PartitionScheme=app3M_fat9M_16MB"
arduino-cli compile -b "$FQBN" --library firmware/libraries/GhostyBoard firmware/sketches/03_MicTest
arduino-cli upload  -b "$FQBN" -p /dev/cu.usbmodemXXXX firmware/sketches/03_MicTest
```

## Board and USB

- The board has two USB-C ports. **COM** = CH343 USB-serial bridge (macOS: `/dev/cu.usbmodem5C4C…`). **USB** = native USB (macOS: `/dev/cu.usbmodem1…`).
- First cable was charge-only: no USB device at all in `ioreg`. A data cable fixed it.
- On the **USB** port the factory firmware ran TinyUSB CDC (USB PID `0x4001`). `esptool` could not reset it into download mode (`No serial data received`). Manual BOOT + RST worked: the board then showed as `USB JTAG_serial debug unit` (PID `0x1001`). After upload it waits in download mode until you press RST.
- On the **COM** port uploads reset the board by themselves. **Use COM** with `USB CDC On Boot: Disabled`.

## Microphone (INMP441)

Wiring: VDD → 3V3 (left 1), GND → GND (right 1), L/R → GND (right 22), SCK → GPIO4, WS → GPIO5, SD → GPIO6.

| Problem | How we found it | Fix |
|---|---|---|
| All samples `0` on both I2S slots | Stereo read showed `L: 0 R: 0 raw: 00000000 00000000`. GPIO6 read `1` with pull-up and `0` with pull-down, so nothing drove SD. A scan that drove clocks on GPIO4/5 with LEDC and watched every free GPIO found no activity, also with SCK/WS swapped. | The mic was on a breadboard with the jumper housings in the wrong rows and header pins not soldered. Female jumpers straight onto the mic pins gave data. |
| Data came and went (52–95 % zero samples) | Per-second zero count on 10 s recordings | Loose pin contact. Firm, soldered connections gave 0 % dropouts. |
| Recording clipped (45 % of samples at full scale; Whisper heard `[MUSIC PLAYING]`) | Per-second RMS and clip count | Gain too high with `raw >> 13`. `raw >> 16` gave clean audio: speech RMS 400–2200, peaks 4 k–14 k, 32 766 only right next to the mouth. |

Note: `GhostyBoard.cpp` uses `raw >> 14` (4x the gain of `>> 16`). Expect clipping when you speak close to the mic; lower the gain if `03_MicTest` shows peaks pinned at 32767.

The L/R → GND wiring puts the mic on the **left** slot on the ESP32-S3 (confirmed: data on L, R always 0).

## Amplifier and speaker (MAX98357A)

Wiring: VIN → **3V3** (left 2), GND → GND (left 22), BCLK → GPIO4 (shared with mic SCK), LRC → GPIO5 (shared with mic WS), DIN → GPIO7, GAIN and SD not connected, speaker on the amp's + / − holes (dot on the speaker = +). The amp board has no LED.

| Problem | How we found it | Fix |
|---|---|---|
| No sound | Play-and-listen test: play 440 Hz while recording with the mic and measure 440 Hz with a Goertzel filter. Tone and silence read the same (about 60), so the speaker was really silent. | Next row. |
| Amp VIN to GND read **−0.3 V** | Multimeter. The board's own 5V pin to GND also read −0.32 V. | On this clone a diode blocks USB power from the 5V pin, so the pin is dead on USB power. Moved amp VIN to the second 3V3 pin. Sound worked at once. Bridging the **IN-OUT** pad should give 5 V (not tried). |

Results on 3V3: 440 Hz tone, a scale and a siren sweep, speech made with macOS `say` (peak at 70 % of full scale, no resets), and an MP3 streamed from the laptop over the COM port at 921 600 baud (16 kHz mono s16le = 32 kB/s). Full volume on 3V3 played, but we did not watch for resets during loud passages.

Mic and amp run on one I2S port in full duplex (`setPins(4, 5, 7, 6)`): recording and playing worked at the same time.

## Voice check on the laptop

Recordings were sent to the laptop over serial (raw 16 kHz s16le) and transcribed with `whisper.cpp` (`brew install whisper-cpp`, model `ggml-base.en`, 141 MB). English worked; Hindi needs the multilingual `ggml-base` model. On quiet audio the model can repeat the last word ("Bye. Bye. Bye."); this is a model artefact, not a mic fault.

## Dabao (Baochip-1x) link: plan

- UART B is the only UART on the Dabao header: **PB13 = UART2 RX**, **PB14 = UART2 TX** (Dabao schematic `dabao_v3c.pdf`). PA03/PA04 (UART A) are not on the header.
- Bank B I/O: on the schematic, VDDIO (balls B7, C7) is tied to **+3.3V** from the MT3406 regulator, so the link is 3.3 V on both sides.
- Wiring: ESP32 GPIO17 (TX) → 1 kΩ → PB13; PB14 → 1 kΩ → ESP32 GPIO18 (RX); GND ↔ GND (right 21). Each board on its own USB cable. The 1 kΩ resistors only protect a board that is powered off.
- PB13–PB15 are also BIO pins: an active BIO program takes them over.

## Enclosure

A white single-colour ghost: body 100 mm diameter × 100 mm tall, 2.5 mm wall, eyes (mic behind one eye), mouth grille with a 40 mm speaker ring, USB opening at the back, and a 104 mm base plate. Files and print settings: [enclosure/README.md](enclosure/README.md).

## Wire count on the ESP32-S3

| Device | ESP32-S3 pins |
|---|---|
| Mic (6) | 3V3 (left 1), GPIO4, GPIO5, GPIO6, GND (right 1), GND (right 22) |
| Amp (5) | 3V3 (left 2), GPIO4, GPIO5, GPIO7, GND (left 22) |
| Dabao (3, planned) | GPIO17 (left 10), GPIO18 (left 11), GND (right 21) |

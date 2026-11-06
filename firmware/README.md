# Ghosty firmware

Arduino IDE sketches for the Ghosty pod (ESP32-S3 N16R8, arduino-esp32 core 3.3.x).
Install steps for the IDE and board core are in [../docs/setup-arduino.md](../docs/setup-arduino.md).
Wiring and power are in [../hardware/wiring.md](../hardware/wiring.md).

## Layout

```
firmware/
├─ libraries/GhostyBoard/      shared Arduino library (pins, I2S, button, LED, WAV header)
│  ├─ library.properties
│  └─ src/
│     ├─ GhostyBoard.h/.cpp
│     ├─ pins.h
│     └─ secrets.h.example     copy to secrets.h (gitignored)
├─ sketches/01_Blink … 06_CloudVoice
└─ scripts/link-lib.sh         symlinks the library into your sketchbook
```

Sketches can't include `../shared/pins.h` because the IDE copies each sketch to a temp folder,
so shared code lives in a local library. Every sketch starts with `#include <GhostyBoard.h>`.

## Setup

```sh
firmware/scripts/link-lib.sh      # links into ~/Documents/Arduino/libraries (override with ARDUINO_LIBS)
cp firmware/libraries/GhostyBoard/src/secrets.h.example \
   firmware/libraries/GhostyBoard/src/secrets.h   # then fill in WiFi, server URL, token
```

Restart the IDE. Board: **ESP32S3 Dev Module** with Flash Size **16MB** and PSRAM **OPI PSRAM**
(`esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi`). Any other board stops the build with an error.
Flash through the **COM** USB-C port with **USB CDC On Boot: Disabled**; no BOOT/RST buttons needed.

## Sketches, in order

| # | Sketch | Proves | Pass when |
|---|---|---|---|
| 1 | `01_Blink` | toolchain, upload, library | heartbeat prints, PSRAM > 0 (no red LED on the S3) |
| 2 | `02_WiFiTest` | WiFi + server reachable | IP and RSSI print, `GET /health` → 200 |
| 3 | `03_MicTest` | INMP441 on full-duplex I2S | RMS bar moves when you talk |
| 4 | `04_SpeakerTest` | MAX98357A + power | clean 440 Hz tone, no reset |
| 5 | `05_RecordPlayback` | mic + PSRAM + amp + button | you hear your own 5 s recording |
| 6 | `06_CloudVoice` | full voice loop (skeleton) | hold button, talk, server reply plays |

Each sketch's header comment lists the expected serial output and what to check if it fails.

## Pin recap

| Signal | GPIO | Notes |
|---|---|---|
| I2S BCLK (mic SCK, amp BCLK) | 4 | shared |
| I2S WS (mic WS, amp LRC) | 5 | shared |
| I2S DOUT → amp DIN | 7 | |
| I2S DIN ← mic SD | 6 | mic L/R to GND (left slot) |
| Button | 15 | to GND, `INPUT_PULLUP` |
| Red LED, flash LED, camera | -1 | not present; helpers skip them |
| Dabao UART (reserved) | 17 TX / 18 RX | to Dabao PB13 RX / PB14 TX |

Audio is one I2S port in full duplex: 16 kHz, 32-bit slots, mono. Avoid GPIO0/3/45/46
(strapping), GPIO19/20 (native USB) and GPIO26–37 (flash and octal PSRAM).

## CI

`.github/workflows/firmware.yml` compiles every sketch for `esp32:esp32:esp32s3` (16 MB flash,
OPI PSRAM) with core 3.3.12, using a stub `secrets.h` copied from the example.

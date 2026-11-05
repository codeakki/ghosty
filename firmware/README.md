# Ghosty firmware

Arduino IDE sketches for the Ghosty pod (AI Thinker ESP32-CAM, arduino-esp32 core 3.3.x).
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

Restart the IDE. Board: **AI Thinker ESP32-CAM** (`esp32:esp32:esp32cam`), PSRAM enabled.
Flash with the ESP32-CAM-MB base board, or with GPIO0 tied to GND during upload.

## Sketches, in order

| # | Sketch | Proves | Pass when |
|---|---|---|---|
| 1 | `01_Blink` | toolchain, upload, library | red LED blinks, heartbeat prints, PSRAM > 0 |
| 2 | `02_WiFiTest` | WiFi + server reachable | IP and RSSI print, `GET /health` → 200 |
| 3 | `03_MicTest` | INMP441 on full-duplex I2S | RMS bar moves when you talk |
| 4 | `04_SpeakerTest` | MAX98357A + power | clean 440 Hz tone, no reset |
| 5 | `05_RecordPlayback` | mic + PSRAM + amp + button | you hear your own 5 s recording |
| 6 | `06_CloudVoice` | full voice loop (skeleton) | hold button, talk, server reply plays |

Each sketch's header comment lists the expected serial output and what to check if it fails.

## Pin recap

| Signal | GPIO | Notes |
|---|---|---|
| I2S BCLK (mic SCK, amp BCLK) | 14 | shared |
| I2S WS (mic WS, amp LRC) | 15 | shared |
| I2S DOUT → amp DIN | 12 | strapping pin: must not be HIGH at reset |
| I2S DIN ← mic SD | 13 | mic L/R to GND (left slot) |
| Button | 2 | to GND, `INPUT_PULLUP`; never tie to 3V3 |
| Red LED | 33 | active LOW |
| Flash LED | 4 | kept LOW |
| Camera PWDN | 32 | HIGH = camera off |

Audio is one I2S port in full duplex: 16 kHz, 32-bit slots, mono. Never call `SD_MMC.begin()`;
the SD pins overlap the audio and button pins.

## CI

`.github/workflows/firmware.yml` compiles every sketch for `esp32:esp32:esp32cam` with core 3.3.12,
using a stub `secrets.h` copied from the example.

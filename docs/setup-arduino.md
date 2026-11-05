# Arduino setup (ESP32-CAM)

From zero to a flashed pod. Works on macOS, Windows and Linux. No PlatformIO; Arduino IDE 2.x only.

## 1. Install the IDE and the ESP32 core

1. Install **Arduino IDE 2.x**.
2. Open **File → Preferences** (macOS: **Arduino IDE → Settings**).
3. In **Additional boards manager URLs** add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Open **Tools → Board → Boards Manager**, search `esp32`, install **esp32 by Espressif Systems**, version **3.3.x** (CI pins 3.3.12, ESP-IDF 5.5).
5. Select **Tools → Board → esp32 → AI Thinker ESP32-CAM** (FQBN `esp32:esp32:esp32cam`).

Defaults for this board are fine: PSRAM enabled (4 MB), partition scheme "Huge APP".

> CI uses `https://espressif.github.io/arduino-esp32/package_esp32_index.json` as the index URL. Both point to the same Espressif package index.

## 2. USB-serial driver

| OS | What to do |
|---|---|
| Windows | Install the **CH340** driver from WCH (the ESP32-CAM-MB base board and most cheap USB-TTL adapters use a CH340). Then check Device Manager → Ports for a new COM port. |
| macOS | Recent macOS usually has a CH340 driver built in. If no `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial*` appears, install the WCH driver. |
| Linux | Built in (`ch341` module). Add yourself to the `dialout` group if the port is permission-denied. |

Use a data USB cable. Charge-only cables are the most common reason no port shows up.

## 3. Link the shared library

Sketches cannot `#include "../shared/pins.h"` (the IDE copies each sketch to a temp folder before compiling). Shared code lives in a local Arduino library, `firmware/libraries/GhostyBoard`, that you symlink into your sketchbook:

```bash
cd ghosty
./firmware/scripts/link-lib.sh
# creates ~/Documents/Arduino/libraries/GhostyBoard -> <repo>/firmware/libraries/GhostyBoard
```

Restart the IDE after linking. Sketches then use `#include <GhostyBoard.h>`.

Windows without a bash shell: copy or junction the folder manually into `Documents\Arduino\libraries\GhostyBoard`.

## 4. Secrets

```bash
cp firmware/libraries/GhostyBoard/src/secrets.h.example \
   firmware/libraries/GhostyBoard/src/secrets.h
```

Fill in WiFi SSID and password (2.4 GHz network), the server URL (LAN IP of your laptop, e.g. `http://192.168.1.50:3000`) and the device token. `secrets.h` is gitignored. Never commit it.

## 5. Flashing

The ESP32-CAM has no USB port of its own. Two ways to flash:

| Method | Steps |
|---|---|
| **ESP32-CAM-MB** base board (recommended) | Seat the CAM on the MB board, plug USB, pick the port, click Upload. If upload stalls at "Connecting...", hold **IO0** on the MB board, tap **RST**, release IO0. |
| **USB-TTL adapter** | Wire 5V→5V, GND→GND, TX→U0R (GPIO3), RX→U0T (GPIO1). Jumper **GPIO0 → GND**, press RST, click Upload. After upload, remove the jumper and press RST to run. |

Rules that keep download mode working:

- **GPIO2** (our button) must be LOW or floating at reset. The button goes GPIO2 ↔ GND with `INPUT_PULLUP`; never tie GPIO2 to 3V3.
- **GPIO12** must not be HIGH at reset. Only the amp's DIN (an input) is on GPIO12.

## 6. Serial monitor

**Tools → Serial Monitor**, baud **115200**, line ending "Both NL & CR". Press RST on the board to see the boot log.

## 7. Test order

Flash and pass each sketch before moving on. Each one isolates one subsystem.

| # | Sketch | Pass when |
|---|---|---|
| 1 | `01_Blink` | Red LED on GPIO33 blinks (it is active LOW; the board has no `LED_BUILTIN`). |
| 2 | `02_WiFiTest` | Serial prints an IP address and RSSI. |
| 3 | `03_MicTest` | RMS meter on serial rises when you talk, stays low when quiet. |
| 4 | `04_SpeakerTest` | Clean sine tone from the speaker. |
| 5 | `05_RecordPlayback` | 5 s recording (160 KB in PSRAM) plays back recognisably. |
| 6 | `06_CloudVoice` | Hold button, speak, release; server logs a request; reply audio plays. Start the server first (`cd server && npm run dev`). |

Run the power test (5V boost, WiFi + audio at once, no resets) between steps 5 and 6. See [troubleshooting.md](troubleshooting.md).

## CI

GitHub Actions compiles every sketch for `esp32:esp32:esp32cam` on core 3.3.12 with a stub `secrets.h` copied from the example. A green firmware workflow means the sketches compile; it does not mean they work on hardware.

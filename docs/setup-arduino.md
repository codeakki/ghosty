# Arduino setup (ESP32-S3 N16R8)

From zero to a flashed pod. Works on macOS, Windows and Linux. No PlatformIO; Arduino IDE 2.x only.

## 1. Install the IDE and the ESP32 core

1. Install **Arduino IDE 2.x**.
2. Open **File → Preferences** (macOS: **Arduino IDE → Settings**).
3. In **Additional boards manager URLs** add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Open **Tools → Board → Boards Manager**, search `esp32`, install **esp32 by Espressif Systems**, version **3.3.x** (CI pins 3.3.12, ESP-IDF 5.5).
5. Select **Tools → Board → esp32 → ESP32S3 Dev Module** and set:
   - Flash Size: **16MB (128Mb)**
   - PSRAM: **OPI PSRAM** (the "R8" in N16R8 is 8 MB of octal PSRAM)
   - Partition Scheme: **16M Flash (3MB APP/9.9MB FATFS)**
   - USB CDC On Boot: **Disabled** when you use the COM port (recommended)

   FQBN: `esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB`. Any other board stops the build with an error from `pins.h`.

> CI uses `https://espressif.github.io/arduino-esp32/package_esp32_index.json` as the index URL. Both point to the same Espressif package index.

## 2. USB-serial driver

| OS | What to do |
|---|---|
| Windows | Install the **CH343 / CH340** driver from WCH (the COM port's USB-serial bridge). Then check Device Manager → Ports for a new COM port. |
| macOS | Usually works without a driver. Look for `/dev/cu.usbmodem*`, `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial*`; install the WCH driver if none appears. |
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

The board has two USB-C ports:

| Port | Steps |
|---|---|
| **COM** (recommended) | Plug in, pick the port, click Upload. The USB-serial bridge resets the board into download mode by itself. Keep USB CDC On Boot **Disabled** so `Serial` appears on this port. |
| **USB** (native) | Set USB CDC On Boot **Enabled**. If upload stalls at "Connecting...", hold **BOOT**, tap **RST**, release BOOT, upload, then tap RST to run. |

Rules that keep download mode working:

- Leave the strapping pins **GPIO0, GPIO3, GPIO45, GPIO46** unconnected.
- Do not use **GPIO26–37** (flash and octal PSRAM) or **GPIO19/20** (native USB).

## 6. Serial monitor

**Tools → Serial Monitor**, baud **115200**, line ending "Both NL & CR". Press RST on the board to see the boot log.

## 7. Test order

Flash and pass each sketch before moving on. Each one isolates one subsystem.

| # | Sketch | Pass when |
|---|---|---|
| 1 | `01_Blink` | Heartbeat prints every second and PSRAM shows about 8 MB free. |
| 2 | `02_WiFiTest` | Serial prints an IP address and RSSI. |
| 3 | `03_MicTest` | RMS meter on serial rises when you talk, stays low when quiet. |
| 4 | `04_SpeakerTest` | Clean sine tone from the speaker. |
| 5 | `05_RecordPlayback` | 5 s recording (160 KB in PSRAM) plays back recognisably. |
| 6 | `06_CloudVoice` | Hold button, speak, release; server logs a request; reply audio plays. Start the server first (`cd server && npm run dev`). |

Run the power test (5V boost, WiFi + audio at once, no resets) between steps 5 and 6. See [troubleshooting.md](troubleshooting.md).

## CI

GitHub Actions compiles every sketch for `esp32:esp32:esp32s3` (16 MB flash, OPI PSRAM) on core 3.3.12 with a stub `secrets.h` copied from the example. A green firmware workflow means the sketches compile; it does not mean they work on hardware.

# Troubleshooting

Symptom → cause → fix. Hardware first, then network, then chains.

## Quick index

| Symptom | Jump to |
|---|---|
| Resets when WiFi or audio starts, `Brownout detector was triggered` | [Brownout](#brownout--reset-under-wifi) |
| Endless `flash read err, 1000` on boot | [GPIO12 boot loop](#flash-read-err-boot-loop-gpio12) |
| Upload stuck at `Connecting...` | [Download mode](#cant-enter-download-mode-gpio2--gpio0) |
| Mic RMS is zero or constant | [Silent mic](#silent-mic) |
| Speaker hiss, buzz, click or pop | [Speaker noise](#speaker-buzz-or-pop) |
| Mic/speaker die after some library call | [SD_MMC conflict](#sd_mmc-conflict) |
| No serial port | [No COM port](#no-com-port) |
| `ps_malloc` returns NULL | [PSRAM](#psram-allocation-fails) |
| WiFi never connects | [WiFi](#wifi-wont-connect) |
| HTTPS handshake fails | [HTTPS certs](#https-certificate-errors) |
| Out of 0G testnet tokens | [0G faucet](#0g-faucet-limits) |
| Hyperliquid testnet faucet refuses | [Hyperliquid faucet](#hyperliquid-testnet-faucet-requires-a-mainnet-deposit) |

---

## Brownout / reset under WiFi

**Symptom:** board resets when WiFi connects or when the amp plays; serial shows `Brownout detector was triggered`.

**Cause:** the 5V pin feeds an AMS1117 regulator that needs about 1.1 V of headroom. A LiPo (3.0–4.2 V) wired straight to 5V sags under WiFi TX bursts plus the amp.

**Fix:**
- Power path: LiPo → TP4056 (charger/protection) → **5V boost converter** → ESP32-CAM 5V pin.
- Feed the MAX98357A VIN from the boost output too, not from 3V3.
- Add a **470–1000 µF** electrolytic across 5V/GND close to the board, plus a 100 nF ceramic if you have one.
- Short, thick power wires. Dupont jumpers on a breadboard drop voltage.
- On USB power, use a port or hub that can deliver 500 mA+.
- Do not disable the brownout detector as a fix. It hides the problem and corrupts flash writes.

## `flash read err` boot loop (GPIO12)

**Symptom:** after reset the serial log repeats `flash read err, 1000` and never reaches `setup()`.

**Cause:** GPIO12 is a strapping pin that selects flash voltage. If it is HIGH at reset the chip picks 1.8 V flash and cannot read the 3.3 V flash.

**Fix:**
- Make sure nothing drives GPIO12 HIGH at reset. In our wiring only the amp DIN (an input) is on GPIO12, which is safe.
- Never put the mic SD output on GPIO12.
- Disconnect the GPIO12 wire, reset, confirm it boots, then reconnect and find what pulls it up.
- Last resort, irreversible: `espefuse set-flash-voltage 3.3V` burns an eFuse so the strap is ignored. Do this only on a board you are sure about.

## Can't enter download mode (GPIO2 / GPIO0)

**Symptom:** upload hangs at `Connecting.....` or fails with "Wrong boot mode".

**Fix:**
- GPIO0 must be LOW at reset: jumper GPIO0 → GND (USB-TTL) or hold IO0 and tap RST (ESP32-CAM-MB).
- **GPIO2** must be LOW or floating at reset. Our button goes GPIO2 ↔ GND with `INPUT_PULLUP`; never wire GPIO2 to 3V3. If you added an external pull-up, remove it.
- Do not hold the push-to-talk button while resetting.
- Lower upload speed (Tools → Upload Speed → 115200) on long or flaky cables.
- After flashing via USB-TTL, remove the GPIO0 jumper and press RST, or the board stays in the bootloader.

## Silent mic

**Symptom:** `03_MicTest` RMS stays at 0, or a fixed value, or only noise.

**Checklist:**
1. **L/R pin to GND.** The INMP441 needs L/R tied to GND for the left slot. Floating L/R gives random silence.
2. **Try the right slot.** On the original ESP32 the INMP441 sometimes appears in the other slot. Change `I2S_STD_SLOT_LEFT` to `I2S_STD_SLOT_RIGHT` in `i2s.begin(...)`.
3. **32-bit slots.** INMP441 needs 64 SCK per frame and outputs 24-bit data. Run I2S at 16 kHz with `I2S_DATA_BIT_WIDTH_32BIT`, then shift `raw >> 14` to get int16. 16-bit slots read garbage or zeros.
4. **One driver only.** Use `ESP_I2S.h`. The legacy `driver/i2s.h` is deprecated and cannot coexist with the new driver.
5. **Wiring:** VDD 3V3, GND, SCK→GPIO14, WS→GPIO15, SD→GPIO13. Mic SD must not be on GPIO12.
6. Speak close to the port hole; the INMP441 is bottom-ported on most breakouts.

## Speaker buzz or pop

**Symptom:** constant hiss/buzz, click when audio starts or stops, pop at boot.

**Fixes:**
- **Buzz:** amp VIN from the 5V boost with the bulk cap; share a solid ground between ESP32, amp and mic; keep speaker wires away from the antenna.
- **Click at start/stop:** the TX channel uses `auto_clear=true` so it sends silence when idle. Ramp volume in and out over a few ms instead of starting at full scale.
- **Too loud / clipping:** GAIN floating is 9 dB. Scale samples down in software before `<<16`.
- **Pop at boot:** GPIO14 (BCLK) may emit a PWM burst at boot (UNVERIFIED). If it bothers you, hold the amp SD/shutdown pin low until `setup()` has started I2S.
- **No sound at all:** speaker on the amp's + and − terminals, not to GND. DIN on GPIO12, BCLK on GPIO14, LRC on GPIO15.

## SD_MMC conflict

GPIO2, 4, 12, 13, 14 and 15 are the SD card pins. **Never call `SD_MMC.begin()`.** It reconfigures our I2S, button and LED pins. If an example sketch or library pulls in SD_MMC, remove it. GPIO16/17 are PSRAM pins; do not use them either.

## No COM port

- Use a **data** USB cable.
- Windows: install the **CH340** driver from WCH, then look in Device Manager → Ports.
- macOS: look for `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial*`; install the WCH driver if neither appears.
- Linux: `ls /dev/ttyUSB*`; add yourself to `dialout`.
- Close any other serial monitor (only one program can hold the port).
- ESP32-CAM-MB boards occasionally ship bad; try another board or a USB-TTL adapter.

## PSRAM allocation fails

**Symptom:** `ps_malloc()` returns `NULL`, or recording crashes.

- Board must be **AI Thinker ESP32-CAM**; PSRAM is on by default for it. Check **Tools → PSRAM: Enabled**.
- Print `ESP.getPsramSize()` and `ESP.getFreePsram()` in `setup()`. Zero means PSRAM is not detected (wrong board selected or a board without PSRAM).
- 5 s at 16 kHz 16-bit mono is 160 KB. Allocate once in `setup()`, reuse it; do not allocate per recording.
- Brownouts can also make PSRAM flaky. Fix power first.

## WiFi won't connect

- ESP32 supports **2.4 GHz only**. 5 GHz-only networks and many "band steering" mesh networks will not work. Use a phone hotspot set to 2.4 GHz (on iPhone enable "Maximise Compatibility").
- Captive-portal WiFi (venue WiFi with a login page) will not work. Use a hotspot.
- SSID and password are case-sensitive; check `secrets.h`.
- Print `WiFi.status()` codes while connecting. Weak signal: the ESP32-CAM PCB antenna is poor; move closer or use the IPEX connector with an external antenna (requires moving the 0 Ω resistor).
- Server unreachable while WiFi is up: phone and laptop must be on the same network; check the laptop firewall allows inbound on port 3000.

## HTTPS certificate errors

- For the demo, keep the server on plain `http://` on the LAN.
- If the server is off-LAN behind HTTPS, use `WiFiClientSecure` with `client.setInsecure()`. This skips certificate validation: acceptable for a hackathon demo, not for anything real. Pair it with the `X-Device-Token` header.
- Production fix: pin the root CA with `client.setCACert(...)`.
- TLS handshakes need RAM and a correct clock. If handshakes fail randomly, check free heap.

## 0G faucet limits

- The faucet at https://faucet.0g.ai gives **0.1 0G per wallet per day**.
- Direct 0G Compute (broker SDK) needs a **3 0G** ledger deposit, which the faucet cannot cover in time.
- Fixes: ask the 0G booth or Discord for testnet tokens early (day 1 morning); use the 0G **Router** (OpenAI-compatible, API key from pc.0g.ai / pc.testnet.0g.ai) which avoids the ledger deposit; keep Storage uploads small (episode records are a few KB).

## Hyperliquid testnet faucet requires a mainnet deposit

- The testnet faucet (`app.hyperliquid-testnet.xyz` → `/drip`) gives 1,000 mock USDC **only to an address that has already deposited on Hyperliquid mainnet**.
- Do this before the event: deposit a small amount on mainnet from the agent's **master** address, then claim on testnet with the same address.
- The API (agent) wallet does not need funds; it signs for the master account.
- Whether `xyz` stock/gold markets exist on testnet is **UNVERIFIED**. Run `perpDexs` and `meta` with `dex:"xyz"` against testnet. If they are missing, demo with BTC perp on testnet, or with small size on mainnet. See [research/hyperliquid.md](research/hyperliquid.md).

## Still stuck

Open an issue with the `bug` template. Include the board, core version (Tools → Board → Boards Manager), the full serial log from reset, and a photo of the wiring.

# Bill of materials

Wiring: [wiring.md](wiring.md).

## Electronics

| Part | Qty | Purpose | Status | Notes |
|---|---|---|---|---|
| ESP32-CAM (AI Thinker) | 1 | Main MCU, WiFi, 4 MB PSRAM | Bought | No `LED_BUILTIN`; red LED on GPIO33 (on when LOW). Camera unused. |
| ESP32-CAM-MB base board | 1 | USB flashing and serial monitor | Bought | CH340 USB-serial; Windows may need the CH340 driver. |
| INMP441 I2S MEMS mic | 1 | Voice input | Bought | 3V3 only. L/R → GND selects left slot. |
| MAX98357A I2S amp | 1 | Speaker driver | Bought | VIN from 5 V. GAIN floating = 9 dB. |
| Mini speaker | 1 | Voice output | Bought | Wire to amp + / −. |
| 3.7 V 500 mAh LiPo | 1 | Battery | Bought | 3.0–4.2 V; too low to feed the 5V pin directly. |
| TP4056 charger module | 1 | LiPo charging and protection | Bought | Use the variant with protection (OUT+ / OUT− pads). |
| Push button | 1 | Push-to-talk and trade confirm | Bought | GPIO2 ↔ GND, `INPUT_PULLUP`. |
| 5 V boost converter | 1 | LiPo → 5 V for board and amp | To buy | Required for battery operation without brownouts. Pick ≥ 1 A output. |
| 470–1000 µF electrolytic capacitor | 1 | Buffer WiFi TX and audio current spikes | To buy | Across 5V / GND near the board; mind polarity. |
| Vibration motor | 1 | Haptic alert | To buy (optional) | Driven through the transistor below. |
| 2N2222 NPN transistor | 1 | Motor switch | To buy (optional) | |
| 1 kΩ resistor | 1 | Transistor base resistor | To buy (optional) | |
| 1N4148 diode | 1 | Flyback diode across motor | To buy (optional) | |
| Slide switch | 1 | Power on/off | To buy (optional) | Between TP4056 OUT+ and boost input. |

## Wiring and tools

| Part | Qty | Purpose | Status | Notes |
|---|---|---|---|---|
| 10-core wire | 1 | Hookup wire | Bought | |
| Breadboard | 1 | Bring-up before soldering | Bought | |
| Micro-USB cable | 1 | Flashing via MB board, charging via TP4056 | Bought | Must be a data cable, not charge-only. |
| 25 W soldering iron | 1 | Assembly | Bought | |
| Solder + flux | 1 | Assembly | Bought | |
| Multimeter | 1 | Check 5 V rail and continuity | To buy (optional) | Strongly recommended for the power test. |
| Hot glue | 1 | Strain relief and shell mounting | To buy (optional) | |

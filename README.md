# homebridge-toshiba-ac

A [Homebridge](https://homebridge.io) plugin for Toshiba air conditioners with WiFi modules, controlled through the **Toshiba Home AC Control** cloud (the same backend as the official mobile app).

Every AC unit registered to your account appears in HomeKit as a **Heater Cooler** accessory with:

- Power on/off
- Auto / Heat / Cool modes (constrained to what your unit supports)
- Target temperature (17–30 °C)
- Current (indoor) temperature
- Fan speed (all 7 Toshiba levels via the rotation speed slider)
- Swing on/off
- Optional outdoor temperature sensor

State changes made from the Toshiba app, the IR remote, or Home Assistant are pushed to HomeKit in real time — the plugin keeps a live connection to Toshiba's cloud and does not poll for updates (a slow HTTP refresh runs as a fallback only).

## Requirements

- Your AC units must be set up in the **Toshiba Home AC Control** app (Android/iOS) and working there.
- Homebridge v1.6+ and Node.js 18+.

## Installation

Install through the Homebridge UI (search for `homebridge-toshiba-ac`) or manually:

```sh
npm install -g homebridge-toshiba-ac
```

## Configuration

Via the Homebridge UI, or manually in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "ToshibaAC",
      "name": "Toshiba AC",
      "username": "your@email.com",
      "password": "your-password",
      "refreshIntervalMinutes": 30,
      "swingModeType": "vertical",
      "exposeOutdoorTemperature": false
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `username` | — | Toshiba Home AC Control account username (usually your e-mail). **Required.** |
| `password` | — | Account password. **Required.** |
| `refreshIntervalMinutes` | `30` | Fallback HTTP state refresh interval (5–1440). Real-time push updates arrive independently of this. |
| `swingModeType` | `"vertical"` | Physical swing activated by HomeKit's oscillate switch: `vertical`, `horizontal`, or `both`. Falls back to vertical if unsupported by the unit. |
| `exposeOutdoorTemperature` | `false` | Adds a temperature sensor per unit reporting the outdoor unit's temperature. |

## HomeKit mapping notes

- **Fan speed slider**: Toshiba has 7 fan settings. They map to slider positions Quiet ≈ 15 %, Low ≈ 29 %, Medium-Low ≈ 43 %, Medium ≈ 57 %, Medium-High ≈ 72 %, High ≈ 86 %, and **Auto = 100 %**.
- **Dry and Fan modes** have no HeaterCooler equivalent in HomeKit. If the unit is in one of those modes (set via the Toshiba app or remote), HomeKit shows it as *Auto*; selecting a mode in HomeKit switches the unit to that mode.
- **Auto mode** shows HomeKit's two-handle temperature range, but Toshiba units have a single setpoint — moving either handle sets that setpoint.
- **8 °C heating mode**: if enabled from the Toshiba app, the plugin leaves the setpoint alone (HomeKit can't go below 17 °C); control it from the app.
- Special functions (Eco/Hi-Power, air purifier, power selection, fireplace mode, energy reports) are not exposed in HomeKit.

## Coexistence with Home Assistant

The plugin registers itself with Toshiba's cloud as its own "mobile device" (with a random, persisted id), so it does **not** kick the official app or the Home Assistant `toshiba_ac` integration off their connections. Running both alongside is fine.

## How it works

There is no local API — Toshiba's WiFi modules only talk to the vendor cloud:

1. HTTPS login to `mobileapi.toshibahomeaccontrols.com` retrieves the account's AC units and an Azure IoT Hub SAS token.
2. The plugin connects to Toshiba's Azure IoT Hub over MQTT as a device. State updates are pushed instantly; commands are sent as device-to-cloud messages.
3. The AC state travels as a compact 19-byte hex record; the codec in `src/toshiba/` is a byte-exact port of the Python implementation (verified differentially against it).

## Credits

The Toshiba cloud protocol was reverse engineered by [Kamil Sroka (KaSroka)](https://github.com/KaSroka/Toshiba-AC-control) for the excellent Python `toshiba-ac` library that powers the Home Assistant integration. This plugin is an independent TypeScript port of that protocol layer. Licensed under Apache-2.0, like the original.

## Disclaimer

This project is not affiliated with or endorsed by Toshiba. It talks to an undocumented vendor API which may change at any time.

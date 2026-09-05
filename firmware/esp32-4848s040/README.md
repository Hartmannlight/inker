# Inker client for JCZN ESP32-4848S040

PlatformIO firmware for the 4-inch 480x480 ESP32-S3 N16R8 module with ST7701
RGB display and GT911 touch controller.

The module manufacturer's matching Arduino_GFX 1.2.9 and adjusted GT911 driver
are vendored under `lib/`. This keeps the proven RGB timings and the board's
unconnected touch INT/RST handling reproducible; newer Arduino_GFX releases use
a different RGB-panel API.

## Provisioning and pairing

On first boot the device creates an access point named `Inker-Setup-XXXXXX`.
Connect a phone or laptop to it, open `http://192.168.4.1`, and enter:

- the WLAN credentials;
- the Inker base URL, for example `http://192.168.1.20:3000`;
- the 10-character pairing code created in Inker for the
  `JCZN ESP32-4848S040 4-inch touch` profile.

Hold the **bottom-right** corner of the display for four seconds to reopen setup.
When the device is already connected to Wi-Fi, this opens a five-minute local
recovery page instead of an access point: the display shows its LAN IP and a
one-time code. Open that IP in a browser, enter the displayed code, a new Inker
URL and a fresh pairing code. This allows recovery when an AP cannot be created.
A new URL or pairing code invalidates the old device credential. Credentials are
kept in ESP32 NVS and are never written to serial logs. The last verified PNG is
kept in LittleFS for offline startup.

Pairing over plain HTTP must be explicitly enabled on the Inker server with
`PAIRING_ALLOW_INSECURE_HTTP=true`. For HTTPS, place the server's root CA PEM in
`include/inker_ca.h`; the client does not disable certificate validation.

## Build and flash

```powershell
pio run
pio run --target upload --upload-port COM3
pio device monitor --port COM3 --baud 115200
```

The first implementation uses Inker's authenticated HTTP pull manifest with
ETags, SHA-256 verification, PNG rendering and last-good caching. WebSocket push
and generic touch-action hit maps remain future extensions; touch is currently
used for local setup recovery.

Firmware 0.3.2 also reads `metadata.displayControl.brightness` from the pull
manifest and drives GPIO 38 with PWM. Inker can therefore set brightness directly
through the device API or resolve a timezone-aware dimming schedule on the server.
After a firmware upgrade it forces one complete manifest response so newly
supported control fields cannot be hidden behind an ETag produced by older firmware.
The board's backlight-driver dead zone is calibrated in firmware: `0%` remains
fully off, while `1–100%` is mapped linearly across the usable PWM range.

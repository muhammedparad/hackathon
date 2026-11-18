# RoomTraceLD2450

Real-data firmware: LD2450 radar -> ESP32-S3 -> Wi-Fi -> HTTPS -> RoomTrace server on Render.
No simulation, no RD-6x, no vitals. See `docs/DEPLOY_RENDER.md` for the server side.

## Setup
1. Copy `credentials_template.h` to `credentials.h` and fill it in (it is git-ignored).
   - Wi-Fi must be **2.4 GHz**.
   - `ROOMTRACE_SERVER_HOST` is your Render host, for example `roomtrace.onrender.com`.
   - Device id and key come from the website: **Devices** > add device > copy the one-time secret.
2. Arduino IDE: board **ESP32S3 Dev Module**, USB CDC On Boot **Enabled**, Serial Monitor **115200** baud.
3. Wiring: LD2450 TX -> GPIO18, RX -> GPIO17, 5 V, GND.

## What it sends
- `POST /api/public/device/telemetry` with up to 3 targets (`target_id`, `x_mm`, `y_mm`, `speed_cms`),
  millisecond timestamp once the clock is synced over NTP. At most 2 posts/s with people in view, one every
  10 s when the room is empty.
- `POST /api/public/device/heartbeat` every 15 s (IP, RSSI, free heap, sensor online/disconnected).
- If the LD2450 is silent for 3 s the firmware stops sending telemetry and the heartbeat reports the
  sensor as `disconnected`. It never sends invented targets.

## Reading the Serial Monitor
`status` lines every 5 s: `wifi`, `time_synced`, `ld_online`, `ld_fps` (about 30 when healthy),
`post_ok` / `post_fail`, `last_http`.

| Symptom | Likely cause |
|---|---|
| `ld_online:false`, warn line | LD2450 wiring or power |
| `wifi:false` | Wrong SSID/password, or a 5 GHz network |
| `http_error` code 401/403 | Wrong device id/key, or device not registered |
| `http_error` code -1 / negative | No internet, TLS problem, or Render service asleep/starting |
| `http_error` code 400 | Server rejected the payload (send me the line) |

## Security note
`ROOMTRACE_TLS_INSECURE 1` skips certificate checking. Use it for first tests only: someone on your
network could read the device key. Add a CA certificate and set it to `0` before real use.

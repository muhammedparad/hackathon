# RoomTraceLD2450

Real-data firmware: LD2450 radar -> ESP32-S3 -> Wi-Fi -> WebSocket (HTTPS fallback) -> RoomTrace server on Render.
Real data only, no RD-6x, no vitals. See `docs/DEPLOY_RENDER.md` for the server side.

## Setup
1. Copy `credentials_template.h` to `credentials.h` and fill it in (it is git-ignored).
   - Wi-Fi must be **2.4 GHz**.
   - `ROOMTRACE_SERVER_HOST` is your Render host, for example `roomtrace.onrender.com`.
   - Device id and key come from the website: **Devices** > add device > copy the one-time secret.
2. Install the library **WebSockets by Markus Sattler** (Arduino Library Manager). Skip it only if you set
   `ROOMTRACE_USE_WS 0` in `credentials.h` to use plain HTTPS.
3. Arduino IDE: board **ESP32S3 Dev Module**, USB CDC On Boot **Enabled**, Serial Monitor **115200** baud.
4. Wiring: LD2450 TX -> GPIO18, RX -> GPIO17, 5 V, GND.

## How it connects
After Wi-Fi is up the device opens one WebSocket to `wss://<host>/device-ws`, sends its id and key once, and
the server answers `ready`. From then on every frame and heartbeat is a small message on that open
connection, so there is no TLS handshake or HTTP request per frame. With the socket ready the device sends
about 6 frames/s; the server shows each one live and stores history about once per second (immediately when
the number of people changes).

If the socket is not ready (still connecting, dropped, library not installed, server not on an always-on
Node host) the device sends the same data by HTTPS POST as before, 2 frames/s, and reconnects the socket
every 5 s in the background. A socket problem therefore never silences the device.

## What it sends
Over HTTPS (fallback) it uses:
- `POST /api/public/device/telemetry` with up to 3 targets (`target_id`, `x_mm`, `y_mm`, `speed_cms`),
  millisecond timestamp once the clock is synced over NTP. At most 2 posts/s with people in view, one every
  10 s when the room is empty.
- `POST /api/public/device/heartbeat` every 15 s (IP, RSSI, free heap, sensor online/disconnected).
- If the LD2450 is silent for 3 s the firmware stops sending telemetry and the heartbeat reports the
  sensor as `disconnected`. It never sends invented targets.

## Reading the Serial Monitor
`status` lines every 5 s: `wifi`, `time_synced`, `ld_online`, `ld_fps` (about 30 when healthy),
`post_ok` / `post_fail`, `last_http`, `post_ms_avg` (HTTPS round trip), and the socket fields
`ws_ready` (true = fast path active), `ws_sent`, `ws_drops` (times the socket was lost), `http_fallbacks`
(messages that had to go by HTTPS because the socket was not ready).

| Symptom | Likely cause |
|---|---|
| `ld_online:false`, warn line | LD2450 wiring or power |
| `wifi:false` | Wrong SSID/password, or a 5 GHz network |
| `http_error` code 401/403 | Wrong device id/key, or device not registered |
| `http_error` code -1 / negative | No internet, TLS problem, or Render service asleep/starting |
| `ws_ready:false` for long, `ws_error` unauthorized | Wrong device id/key (same check as HTTPS) |
| `ws_ready:false`, no `ws` lines at all | Library missing/old, or the server is not the Node build on Render |
| `http_error` code 400 | Server rejected the payload (send me the line) |

## Security note
`ROOMTRACE_TLS_INSECURE 1` skips certificate checking. Use it for first tests only: someone on your
network could read the device key. For real use set it to `0` and add the server's root CA certificate
(PEM text) to `credentials.h` as `ROOMTRACE_CA_CERT`; both the WebSocket and HTTPS then verify the server.

## Not verified yet
The WebSocket code has not been compiled or run on hardware. It was written against the WebSockets
library API (`beginSSL`, `beginSslWithCA`, `onEvent`, `enableHeartbeat`, `sendTXT`); if your library version
names something differently the compiler will say exactly where. The server side is tested.

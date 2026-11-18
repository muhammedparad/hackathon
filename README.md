# RoomTrace — camera-free room awareness

See the room. Understand the movement. Without cameras.

RoomTrace visualises people and movement from mmWave radar:

- **HLK-LD2450 (24 GHz)** — up to 3 tracked targets with x/y (mm) and speed (cm/s).
- **Ai-Thinker RD-61 (60 GHz, via RD-60-Kit)** — raw point cloud (x, y, z, doppler, SNR). Not integrated yet.

The two outputs are processed and shown separately.

## Data flow

```
LD2450 → ESP32-S3 → Wi-Fi → WebSocket /device-ws  (or HTTPS POST /api/public/device/*, automatic fallback)
                              Node server on Render
                                      ├─ live WebSocket (/live-ws) → dashboard, instantly
                                      └─ Firestore (telemetry, events)
```

Everything shown comes from real devices registered to your account. There is no built-in
account and no built-in sample data. A device is shown as _Connected_ only after the server received an
authenticated heartbeat or telemetry call from it in the last 60 s.

## Device API

Register a device on the **Devices** page to get a device ID and a one-time secret (stored hashed). The
device belongs to the signed-in user; assign it to a room so its frames can be drawn.

```bash
# heartbeat
curl -X POST $APP/api/public/device/heartbeat -H "X-Device-Id: YOUR_DEVICE_ID" -H "X-Device-Key: rt_..." \
  -H "Content-Type: application/json" -d '{"firmware_version":"0.1.0","ip_address":"192.168.1.40"}'

# LD2450 frame
curl -X POST $APP/api/public/device/telemetry -H "X-Device-Id: YOUR_DEVICE_ID" -H "X-Device-Key: rt_..." \
  -H "Content-Type: application/json" \
  -d '{"data":{"sensor_type":"ld2450","targets":[{"target_id":1,"x_mm":-250,"y_mm":1800,"speed_cms":12}]}}'
```

Payloads are validated (max 3 LD2450 targets, bounded coordinates). Valid telemetry is pushed to the owner's
open dashboards over the WebSocket, stored in Firestore, and occupancy events are derived from LD2450 frames.

## Use it on your phone

The website is a responsive web app: on a phone it switches to a bottom tab bar (Dashboard, Live Radar,
Floor Plan, Devices, More) and a single-column layout. It can be installed like an app:

- **Android (Chrome):** open your RoomTrace address, menu (three dots), **Install app** / **Add to Home screen**.
- **iPhone (Safari):** Share, **Add to Home Screen**.

It needs an internet connection (the live view is a real-time feed); there is no offline mode.
Regenerate the home-screen icons with `python scripts/make_icons.py`.

## Firmware

- `firmware/RoomTraceLD2450` — the LD2450 → Wi-Fi → server firmware.
- `firmware/RoomTraceDebug` — serial debug sketch for the LD2450 and the Ai-Thinker RD-6x, plus
  `scripts/log_serial.py` to save its output as CSV.

## Deploy

See [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md). Requires a Firebase project (Auth + Firestore) and a
service-account key on the server.

## Run locally

```bash
cp .env.example .env   # fill in your Firebase values
npm ci
npm run dev            # http://localhost:8080   (no live WebSocket in dev, see the deploy doc)
npx vitest run         # tests
```

## Status

The LD2450 path is built end to end and tested in software. The RD-61 decoder and fall detection are not
integrated yet.

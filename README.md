# RoomTrace — camera-free room awareness

See the room. Understand the movement. Without cameras.

RoomTrace visualises people and movement from mmWave radar:

- **HLK-LD2450 (24 GHz)** — up to 3 tracked targets with x/y (mm) and speed (cm/s).
- **Ai-Thinker RD-61 (60 GHz, via RD-60-Kit)** — raw point cloud (x, y, z, doppler, SNR).

The two outputs are processed and shown separately.

## Data flow

```
Radar → ESP32-S3 → Wi-Fi/HTTPS → /api/public/device/* → Database → Realtime → Dashboard
```

## Modes

- **Simulation** (default) — a browser-side engine (`src/lib/radar/simulation.ts`) generates LD2450 frames and RD-61 point clouds with scenarios (empty, single, multiple, stationary, moving, entering, leaving, disconnect). Everything is labelled **SIMULATED**; recorded events are flagged `simulated = true`.
- **Hardware** — shows only telemetry stored from authenticated devices. Devices appear as _Connected_ only after a heartbeat/telemetry in the last 60 s. Nothing is fabricated.

Both modes feed the same frame types (`src/lib/radar/types.ts`), so the UI is unchanged when real hardware arrives.

## Device API

Register a device under **Devices & Sensors** to get a device ID and a one-time secret (stored hashed).

```bash
# heartbeat
curl -X POST $APP/api/public/device/heartbeat -H "X-Device-Id: esp32-lab-01" -H "X-Device-Key: rt_..." \
  -H "Content-Type: application/json" -d '{"firmware_version":"0.1.0","ip_address":"192.168.1.40"}'

# LD2450 frame
curl -X POST $APP/api/public/device/telemetry -H "X-Device-Id: esp32-lab-01" -H "X-Device-Key: rt_..." \
  -H "Content-Type: application/json" \
  -d '{"data":{"sensor_type":"ld2450","targets":[{"target_id":1,"x_mm":-250,"y_mm":1800,"speed_cms":12}]}}'

# RD-61 frame
-d '{"data":{"sensor_type":"rd61","points":[{"x_mm":100,"y_mm":2000,"z_mm":900,"doppler":0.4,"snr":14}]}}'
```

Payloads are validated (max 3 LD2450 targets, 512 RD-61 points, bounded coordinates). Valid telemetry is stored, the device is marked connected, occupancy events are derived from LD2450 frames and pushed to dashboards in real time.

App data (rooms, devices, sensors, events) is read/written directly through row-level-secured queries, so each user only sees their own data.

## Run locally (Ubuntu)

```bash
curl -fsSL https://bun.sh/install | bash
cp .env.example .env   # fill in your backend values
bun install
bun run dev            # http://localhost:8080
bunx vitest run        # tests
```

## Status

Hardware integration is designed but **not yet tested with physical sensors**.

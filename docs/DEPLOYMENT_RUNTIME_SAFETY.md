# RoomTrace — Deployment Runtime & State Safety Specification

## 1. Executive Summary & Runtime Architecture

RoomTrace processes real-time radar telemetry from ESP32-S3 microcontrollers (monitoring HLK-LD2450 and RD-61 sensors). State tracking in `AlertEngine` requires temporal continuity across consecutive frames (e.g., tracking dwell time, velocity spikes, motion direction vectors, and stale target timeouts).

### Target Environments

| Environment               | Platform / Preset               | Runtime Type                        | In-Memory State Behavior                                                                                                          |
| :------------------------ | :------------------------------ | :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| **Local / Bench Testing** | `vite dev` / Bun / Node         | Single Long-Lived Process           | **Safe & Stateful**: In-memory `Map`s (`roomAlertEngines`, `deviceLastFrame`, `lastOccupancyState`) persist across frames.        |
| **Edge Serverless**       | Nitro `cloudflare-module`       | Distributed V8 Isolates (`workerd`) | **Stateless / Ephemeral**: Memory is isolated per worker instance; requests from the same room route across arbitrary edge nodes. |
| **Dedicated Production**  | Nitro `node-server` (Container) | Long-Lived Node/Bun Container       | **Safe & Stateful**: Single instance or sticky session routing preserves engine continuity.                                       |

---

## 2. In-Memory AlertEngine & Edge Isolate Failure Modes

In `src/routes/api/public/device/telemetry.ts`, the backend tracks target dynamics using in-memory state:

1. `roomAlertEngines`: Stateful `AlertEngine` holding target tracks, motion history (last 6 seconds), active zone dwell timers, and candidate fall velocity spikes.
2. `deviceLastFrame`: 60-second TTL frame deduplication cache preventing retransmission spam.
3. `lastOccupancyState`: Room vacancy/occupancy transition cache.

### Why Serverless Edge Isolates Fail Without Coordination

When deployed to multi-isolate serverless edge runtimes (e.g., Cloudflare Workers):

- **Anycast Routing & State Fracturing**: Successive HTTP POST telemetry frames from an ESP32 are routed to different edge isolates around the world. Isolate B has no visibility into the tracking state created by Isolate A.
- **Lost Dwell & Temporal Windows**: Dwell thresholds (e.g. 15-second hazard dwell, 10-minute room presence) reset every time a frame hits a fresh isolate.
- **Candidate Fall & Velocity Spike Failure**: Fall detection requires capturing an initial velocity spike (> 110 cm/s) followed by 3 seconds of sustained stillness (< 8 cm/s). If the stillness frames route to a different isolate, the spike history is lost and the fall cannot be detected.
- **Cold Starts & Memory Recycling**: Ephemeral isolates are terminated upon idle, discarding all target coordinates and active alerts mid-event.

---

## 3. Safe Operating Envelopes

### Envelope A: Single-Instance Bench Testing (Current Certified Envelope)

- **Sensor Setup**: 1 physical HLK-LD2450 sensor connected to an ESP32-S3.
- **Backend Host**: Single Node.js or Bun process (`bun run dev` or `node-server` container on Cloud Run / Railway / Fly.io / VPS).
- **Concurrency**: 1 process handling all ingress for the test facility.
- **Guarantees**: Frame deduplication TTL (60s), target disambiguation (`${deviceId}:${targetId}`), safe idle engine eviction (> 30 min without active tracks), and bounded memory limits are fully operational and verified.

### Envelope B: Distributed Production Requirements

To run reliably across distributed serverless infrastructure:

1. **Cloudflare Durable Objects**:
   - Each `room_id` binds to a unique Durable Object actor.
   - Telemetry frames for a room are consistently routed to the same Durable Object instance.
   - Provides in-memory statefulness, web-socket streaming, and built-in transactional SQLite persistence.
2. **Dedicated Ingestion Worker Container**:
   - Deploy the telemetry ingest service as a persistent containerized service (`node-server` preset).
   - Use sticky routing or a centralized Redis/Valkey queue for telemetry streams.
3. **Decoupled Event Engine**:
   - ESP32 writes directly to Firebase Admin SDK / Cloud Firestore or Pub/Sub.
   - A single backend consumer evaluates the state machine continuously.

---

## 4. Hardware Safety & Protocol Limitations

- **HLK-LD2450**: Verified for multi-target tracking (up to 3 targets), zone boundary analysis, door crossing directionality, and experimental fall candidate screening.
- **RD-61 Point Cloud**: UART cluster protocol is **NOT physically certified**. RD-61 point cloud payloads are ingested strictly for visualization and raw telemetry logging. They are **excluded** from life-safety alert generation until protocol validation is completed.
- **Disclaimer**: RoomTrace candidate fall detection is a screening heuristic and **not** a certified medical alarm, emergency dispatch service, or life-safety monitoring solution.

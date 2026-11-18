# RoomTrace — Offline Resilience & Recovery Specification

**Document Version:** 1.0 (Phase 5 Hardware Integration)  
**System:** RoomTrace Camera-Free Room Awareness Platform  
**Target Controllers:** ESP32-S3 Microcontroller Hub with MicroSD Storage Subsystem  
**Scope:** Architectural Fault Tolerance, Network Disconnection, Power Loss Recovery, and Idempotent Synchronization.

---

## 1. Failure Modes & Recovery Matrix

| Fault / Incident                                      | Detection Mechanism                                | Primary Mitigation on ESP32                                                                           | Ingestion API Response on Recovery                                                          |
| :---------------------------------------------------- | :------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Wi-Fi Loss**                                        | `WiFi.status() != WL_CONNECTED`                    | Non-blocking state machine; exponential backoff (2s → 60s); short-term RAM ring buffer (50 frames).   | Resumes streaming live telemetry; historical gaps visible as unmonitored periods.           |
| **Backend Unavailability** (HTTP 500 / 503 / Timeout) | `HTTPClient` timeout (> 2500ms) or 5xx code        | Backs off network requests; spools uncommitted telemetry to ring buffer; preserves hardware watchdog. | Accepts backlogged chunks in chronological order once operational.                          |
| **ESP32 Power Cycle / Reboot**                        | Reset Reason Register (`esp_reset_reason()`)       | Reloads config from NVS; initiates Wi-Fi; resyncs NTP clock; sends initial heartbeat.                 | Marks device `connected`; emits `sensor_reconnected` occupancy event if previously offline. |
| **Sensor Disconnection** (Cable loose / power loss)   | Silent UART timeout (> 2500ms without valid frame) | Hardware timer triggers `sensor_stale` flag; sends `sensor_disconnected` event to backend.            | Dashboard highlights sensor offline; prevents false-positive "vacant" room inference.       |
| **API Throttling** (HTTP 429 Too Many Requests)       | Response code `429`                                | Throttles streaming rate by 500ms; limits rate to $\le 10\text{ Hz}$.                                 | Enforces 25 requests/second rate limit per authenticated device.                            |
| **Clock Drift**                                       | Monotonic vs NTP comparison                        | Synchronizes with `pool.ntp.org`; fallback to `/api/public/device/heartbeat` server time.             | Validates timestamps against ingest time; flags frames with $> 5\text{ min}$ skew.          |

---

## 2. In-Memory Ring Buffer & MicroSD Spillover Architecture

```text
[ Radar Hardware (UART) ]
           │
           ▼
[ FreeRTOS Core 1 Ingest Task ]
           │
           ▼ (Critical Section)
[ SRAM/PSRAM Ring Buffer (50 frames) ]
     │                            │
     │ (Normal Wi-Fi Connected)    │ (Wi-Fi Disconnected / Backlog Full)
     ▼                            ▼
[ HTTP Client (10 Hz Stream) ]   [ MicroSD File Spooler (Future Phase 6) ]
     │                            │  - 5-minute chunked log files
     ▼                            │  - Ring buffer file rotation
[ RoomTrace Backend API ]         │  - Checksum validation
                                  │
                                  ▼ (On Network Restoration)
                                 [ Chronological Sync Pipeline ]
```

### 2.1 Short-Term Network Jitter (RAM Ring Buffer)

- The ESP32 maintains a pre-allocated circular ring buffer in internal SRAM / PSRAM capable of holding up to 50 complete `LD2450FrameData` structs (5 seconds of full 10 Hz telemetry).
- Network spikes or temporary AP handovers (< 5 seconds) are smoothed out with zero frame loss.

### 2.2 Extended Network Outage (Future MicroSD Queue)

- For outages exceeding 5 seconds, frames spill into 5-minute chunked line-delimited files on the MicroSD card (`/telemetry/YYYY-MM-DD/HH-MM-SS_ld2450.log`).
- **Safety Restriction:** Do not perform destructive flash writes or claim physical MicroSD validation until the physical SPI module and card have been verified on the hardware test bench.

---

## 3. Duplicate Prevention & Idempotent Reconnection

When re-establishing connection after an outage, retransmissions must not cause duplicate alerts or false zone crossing spikes:

1. **Frame Fingerprinting**: The backend maintains a rolling 60-second frame deduplication cache (`deviceLastFrame`). Consecutive frames with identical timestamps and coordinate hashes are skipped with `{ ok: true, duplicate: true }`.
2. **Alert Engine Temporal Continuity**: When backlogged frames arrive, the backend processes them in strict chronological sequence. Stale frame timeouts in `AlertEngine` prevent burst-induced artificial velocity spikes.
3. **Missing Telemetry vs Zero Occupancy**: If telemetry is interrupted, the dashboard marks the room state as `unknown` or `sensor_offline` rather than erroneously claiming the room is `vacant`.

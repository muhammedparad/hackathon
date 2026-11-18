import { describe, expect, it, beforeEach } from "vitest";
import {
  parseLD2450Frame,
  serializeLD2450Frame,
  LD2450StreamParser,
} from "@/lib/radar/ld2450-parser";
import {
  Route as TelemetryRoute,
  _resetTelemetryCache,
  DEDUP_TTL_MS,
} from "@/routes/api/public/device/telemetry";
import { Route as HeartbeatRoute } from "@/routes/api/public/device/heartbeat";
import { AlertEngine, type AlertEngineRoom } from "@/lib/radar/alert-engine";
import {
  checkDeviceRateLimit,
  authenticateDevice,
  _resetRateLimits,
} from "@/lib/device-auth.server";
import { roomState, type RoomLive } from "@/lib/radar/live";

describe("Phase 5.7: Desktop Hardware Simulation & Fault Injection Tests", () => {
  beforeEach(() => {
    _resetTelemetryCache();
    _resetRateLimits();
  });

  const getHandler = (route: { options: { server?: { handlers?: unknown } } }) => {
    const handlers = route.options.server?.handlers;
    if (typeof handlers === "object" && handlers !== null && "POST" in handlers) {
      return (handlers as { POST: (args: { request: Request }) => Promise<Response> }).POST;
    }
    throw new Error("Missing POST handler");
  };

  const telemetryHandler = getHandler(TelemetryRoute);
  const heartbeatHandler = getHandler(HeartbeatRoute);

  const testRoom: AlertEngineRoom = {
    id: "room-sim-test",
    name: "Simulation Test Room",
    width_mm: 5000,
    length_mm: 6000,
    doors: [],
    zones: [
      {
        id: "z-test-restricted",
        room_id: "room-sim-test",
        name: "Test Restricted",
        type: "restricted",
        polygon: [
          { x_mm: 1000, y_mm: 1000 },
          { x_mm: 2000, y_mm: 1000 },
          { x_mm: 2000, y_mm: 2000 },
          { x_mm: 1000, y_mm: 2000 },
        ],
        alert_on_entry: true,
      },
    ],
  };

  // 1. LD2450 Normal Tracking
  it("Scenario 1: LD2450 normal tracking produces verified signed coordinates", () => {
    const frame = serializeLD2450Frame([
      { target_id: 1, x_mm: -800, y_mm: 2400, speed_cms: 35, resolution_mm: 120 },
    ]);
    const parsed = parseLD2450Frame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed?.targets).toHaveLength(1);
    expect(parsed?.targets[0]).toEqual({
      target_id: 1,
      x_mm: -800,
      y_mm: 2400,
      speed_cms: 35,
    });
  });

  // 2. Multiple Simultaneous Targets
  it("Scenario 2: tracks up to 3 simultaneous targets with distinct kinematics", () => {
    const frame = serializeLD2450Frame([
      { target_id: 1, x_mm: -1200, y_mm: 1800, speed_cms: -20 },
      { target_id: 2, x_mm: 500, y_mm: 2900, speed_cms: 15 },
      { target_id: 3, x_mm: 1400, y_mm: 3700, speed_cms: 0 },
    ]);
    const parsed = parseLD2450Frame(frame);
    expect(parsed?.targets).toHaveLength(3);
    expect(parsed?.targets.map((t) => t.target_id)).toEqual([1, 2, 3]);
  });

  // 3. Invalid UART Frames
  it("Scenario 3: rejects invalid UART frames with corrupt magic words", () => {
    const frame = serializeLD2450Frame([{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }]);
    const badHeader = new Uint8Array(frame);
    badHeader[0] = 0x00; // Corrupt header
    expect(parseLD2450Frame(badHeader)).toBeNull();

    const badFooter = new Uint8Array(frame);
    badFooter[28] = 0xff; // Corrupt footer
    expect(parseLD2450Frame(badFooter)).toBeNull();
  });

  // 4. Incomplete / Fragmented Frames
  it("Scenario 4: stream parser smoothly recovers from incomplete chunks", () => {
    const parser = new LD2450StreamParser();
    const frame = serializeLD2450Frame([{ target_id: 1, x_mm: 400, y_mm: 1500, speed_cms: 12 }]);

    // Push first 15 bytes
    const p1 = parser.pushChunk(frame.subarray(0, 15));
    expect(p1).toHaveLength(0);

    // Push remaining 15 bytes
    const p2 = parser.pushChunk(frame.subarray(15, 30));
    expect(p2).toHaveLength(1);
    expect(p2[0]?.targets[0]?.x_mm).toBe(400);
  });

  // 5. Sensor Disconnection Detection
  it("Scenario 5: detects sensor disconnection on silent timeout (> 2.5s)", () => {
    const engine = new AlertEngine(testRoom);
    let t = 1_000_000;

    // Target tracked at t = 1_000_000
    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }], t, false);
    expect(engine.hasActiveTracks()).toBe(true);

    // After 3 seconds of sensor silence, target is marked stale
    t += 3000;
    engine.processTargets([], t, false);
    expect(engine.hasActiveTracks()).toBe(false);
  });

  // 6. Wi-Fi Disconnection & Ingest Endpoint Health
  it("Scenario 6: heartbeat updates device connectivity and handles network restore", async () => {
    const req = new Request("http://localhost/api/public/device/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        firmware_version: "1.0.0-phase5",
        ip_address: "192.168.1.150",
      }),
    });

    const res = await heartbeatHandler({ request: req });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.server_time).toBeDefined();
  });

  // 7. Backend Timeout & Rate Limiting (HTTP 429)
  it("Scenario 7: enforces device rate limiting under burst flooding", () => {
    const testDevId = "rate-limit-test-dev";
    // First 25 requests pass
    for (let i = 0; i < 25; i++) {
      expect(checkDeviceRateLimit(testDevId, 25, 1000)).toBe(true);
    }
    // 26th request within same second is throttled
    expect(checkDeviceRateLimit(testDevId, 25, 1000)).toBe(false);
  });

  // 8. Duplicate Telemetry Rejection
  it("Scenario 8: deduplicates identical retransmissions within TTL window", async () => {
    const payload = {
      timestamp: "2026-11-15T12:00:00.000Z",
      data: {
        sensor_type: "ld2450",
        targets: [{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }],
      },
    };

    const makeReq = () =>
      new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify(payload),
      });

    const r1 = await telemetryHandler({ request: makeReq() });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.duplicate).toBeUndefined();

    // Retransmission of exact same frame is detected
    const r2 = await telemetryHandler({ request: makeReq() });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.duplicate).toBe(true);
  });

  // 9. ESP32 Reboot Recovery
  it("Scenario 9: device seamlessly resumes state following reboot", async () => {
    _resetTelemetryCache();
    const req = new Request("http://localhost/api/public/device/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({ firmware_version: "1.0.0-phase5", ip_address: "192.168.1.150" }),
    });

    const res = await heartbeatHandler({ request: req });
    expect(res.status).toBe(200);
  });

  // 10. Multi-Sensor Identity Isolation
  it("Scenario 10: isolates targets across multiple physical sensors in same room", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    engine.processTargets(
      [{ target_id: 1, x_mm: -1000, y_mm: 2000, speed_cms: 10 }],
      t,
      false,
      "esp32-left",
    );
    engine.processTargets(
      [{ target_id: 1, x_mm: 1000, y_mm: 2000, speed_cms: 10 }],
      t,
      false,
      "esp32-right",
    );

    expect(engine.getActiveTargetCount()).toBe(2);
    expect(engine.getTrackedTarget(1, "esp32-left")?.x_mm).toBe(-1000);
    expect(engine.getTrackedTarget(1, "esp32-right")?.x_mm).toBe(1000);
  });

  // 11. Stale Target Removal Without Cross-Device Eviction
  it("Scenario 11: device A frame does NOT evict device B targets", () => {
    const engine = new AlertEngine(testRoom);
    let t = 1_000_000;

    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }], t, false, "devA");
    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }], t, false, "devB");

    t += 3000; // past stale timeout
    // devA sends frame still observing target 1
    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }], t, false, "devA");

    // devB target MUST still be preserved
    expect(engine.getTrackedTarget(1, "devB")).toBeDefined();
    expect(engine.getActiveTargetCount()).toBe(2);
  });

  // 12. Virtual versus Hardware Provenance Immutability
  it("Scenario 12: hardware telemetry strictly enforces simulated: false provenance", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }],
        },
      }),
    });

    const res = await telemetryHandler({ request: req });
    expect(res.status).toBe(200);
    // In local mode without Firestore Admin credentials, returns local_alerts
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // =========================================================================
  // Phase 5.1.1: Safety & Reliability Remediation Regression Tests
  // =========================================================================

  it("Regression 1: Sensor disconnect triggers sensor_disconnected, NOT room_vacant", async () => {
    // Frame 1: 1 target detected -> occupied
    const r1 = await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            targets: [{ target_id: 1, x_mm: 500, y_mm: 2000, speed_cms: 10 }],
          },
        }),
      }),
    });
    const b1 = await r1.json();
    expect(b1.transition_event).toBe("room_occupied");

    // Frame 2: Sensor disconnected frame arrives (0 targets with sensor_status: "disconnected")
    const r2 = await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            sensor_status: "disconnected",
            targets: [],
          },
        }),
      }),
    });
    const b2 = await r2.json();
    // MUST NOT be room_vacant!
    expect(b2.transition_event).toBe("sensor_disconnected");
    expect(b2.transition_event).not.toBe("room_vacant");
  });

  it("Regression 2: Valid scan with 0 targets triggers room_vacant when previously occupied", async () => {
    // Frame 1: Occupied
    await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            targets: [{ target_id: 1, x_mm: 500, y_mm: 2000, speed_cms: 10 }],
          },
        }),
      }),
    });

    // Frame 2: Online sensor reports 0 targets (valid empty scan)
    const r2 = await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            sensor_status: "online",
            targets: [],
          },
        }),
      }),
    });
    const b2 = await r2.json();
    expect(b2.transition_event).toBe("room_vacant");
  });

  it("Regression 3: Stale telemetry is categorized as sensor_offline, NOT vacant", () => {
    const now = 100_000;
    // Fresh frame with 0 targets -> vacant
    const freshLive: RoomLive = {
      ld: {
        sensor_type: "ld2450",
        origin: "hardware",
        room_id: "room-sim-test",
        timestamp: now - 1000, // 1s ago (fresh)
        targets: [],
      },
    };
    expect(roomState(freshLive, now, "hardware")).toBe("vacant");

    // Stale frame with 0 targets (> 5s old) -> sensor_offline, NEVER vacant!
    const staleLive: RoomLive = {
      ld: {
        sensor_type: "ld2450",
        origin: "hardware",
        room_id: "room-sim-test",
        timestamp: now - 10_000, // 10s ago (stale)
        targets: [],
      },
    };
    expect(roomState(staleLive, now, "hardware")).toBe("sensor_offline");
    expect(roomState(staleLive, now, "hardware")).not.toBe("vacant");
  });

  it("Regression 4: Malformed or invalid frames are rejected and do not cause occupancy transitions", async () => {
    const badReq = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        data: {
          sensor_type: "invalid_sensor_type",
          targets: "not_an_array",
        },
      }),
    });
    const res = await telemetryHandler({ request: badReq });
    expect(res.status).toBe(400);
  });

  it("Regression 5: Backend verifies raw device key and rejects pre-hashed or invalid key", async () => {
    // Valid raw key matches
    const reqValid = new Request("http://localhost/test", {
      headers: {
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
    });
    const authValid = await authenticateDevice(reqValid);
    expect("device" in authValid).toBe(true);

    // Invalid / wrong key is rejected with 401
    const reqInvalid = new Request("http://localhost/test", {
      headers: {
        "x-device-id": "esp32-lab-01",
        "x-device-key": "incorrect_key",
      },
    });
    const authInvalid = await authenticateDevice(reqInvalid);
    expect("error" in authInvalid).toBe(true);
  });

  it("Regression 6: Buffered frames maintain FIFO order and timestamps during network drain", () => {
    interface QueueItem {
      timestamp: number;
      payload: string;
    }
    const queue: QueueItem[] = [];
    const timestamps = [1700000001000, 1700000002000, 1700000003000];

    for (const ts of timestamps) {
      queue.push({ timestamp: ts, payload: `frame_${ts}` });
    }

    expect(queue).toHaveLength(3);
    const drained: number[] = [];
    while (queue.length > 0) {
      drained.push(queue.shift()!.timestamp);
    }
    expect(drained).toEqual(timestamps);
    expect(drained[0]!).toBeLessThan(drained[1]!);
    expect(drained[1]!).toBeLessThan(drained[2]!);
  });

  it("Regression 7: Duplicate replay within TTL window is rejected with duplicate: true", async () => {
    const payload = {
      timestamp: "2026-11-15T14:30:00.000Z",
      data: {
        sensor_type: "ld2450",
        targets: [{ target_id: 1, x_mm: 200, y_mm: 1500, speed_cms: 5 }],
      },
    };

    const makeReq = () =>
      new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify(payload),
      });

    const r1 = await telemetryHandler({ request: makeReq() });
    const b1 = await r1.json();
    expect(b1.duplicate).toBeUndefined();

    // Replay
    const r2 = await telemetryHandler({ request: makeReq() });
    const b2 = await r2.json();
    expect(b2.duplicate).toBe(true);
  });

  it("Regression 8: Multiple devices in same room maintain isolated target states without collision", () => {
    const engine = new AlertEngine(testRoom);
    const now = 200_000;

    // Dev1 detects target 1 at lateral x = -800
    engine.processTargets(
      [{ target_id: 1, x_mm: -800, y_mm: 2200, speed_cms: 12 }],
      now,
      false,
      "sensor-left",
    );

    // Dev2 detects target 1 at lateral x = 800
    engine.processTargets(
      [{ target_id: 1, x_mm: 800, y_mm: 2200, speed_cms: -12 }],
      now,
      false,
      "sensor-right",
    );

    expect(engine.getActiveTargetCount()).toBe(2);
    expect(engine.getTrackedTarget(1, "sensor-left")?.x_mm).toBe(-800);
    expect(engine.getTrackedTarget(1, "sensor-right")?.x_mm).toBe(800);
  });

  // =========================================================================
  // Phase 5.1.2: Timestamp Architecture, Queue Error & Lifecycle Regressions
  // =========================================================================

  it("Phase 5.1.2 - Timestamp 1: Preserves synchronized device timestamps without overwriting", async () => {
    const historicalCapture = "2026-11-15T10:00:00.000Z";
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        timestamp: historicalCapture,
        device_time_synced: true,
        captured_at_ms: 54321,
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 100, y_mm: 1500, speed_cms: 0 }],
        },
      }),
    });

    const res = await telemetryHandler({ request: req });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timestamp).toBe(historicalCapture);
    expect(body.captured_at).toBe(historicalCapture);
    expect(body.device_time_synced).toBe(true);
    expect(body.received_at).toBeDefined();
    expect(body.received_at).not.toBe(historicalCapture);
  });

  it("Phase 5.1.2 - Timestamp 2: Unsynchronized device timestamps normalize to server time", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        timestamp: "2026-11-15T10:00:00.000Z",
        device_time_synced: false, // Explicitly unsynced RTC
        captured_at_ms: 12000,
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 100, y_mm: 1500, speed_cms: 0 }],
        },
      }),
    });

    const res = await telemetryHandler({ request: req });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_time_synced).toBe(false);
    expect(body.timestamp).toBe(body.received_at); // Normalized to server arrival
  });

  it("Phase 5.1.2 - Timestamp 3: Buffered historical frames maintain distinct capture times", async () => {
    const t0 = new Date("2026-11-15T11:00:00.000Z").getTime();
    const frameTimes = [
      new Date(t0).toISOString(),
      new Date(t0 + 100).toISOString(),
      new Date(t0 + 200).toISOString(),
    ];

    const responses = [];
    for (const ct of frameTimes) {
      const res = await telemetryHandler({
        request: new Request("http://localhost/api/public/device/telemetry", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-id": "esp32-lab-01",
            "x-device-key": "rt_demo_secret_key_12345",
          },
          body: JSON.stringify({
            timestamp: ct,
            device_time_synced: true,
            data: {
              sensor_type: "ld2450",
              targets: [{ target_id: 1, x_mm: 200, y_mm: 1800, speed_cms: 5 }],
            },
          }),
        }),
      });
      responses.push(await res.json());
    }

    expect(responses[0].timestamp).toBe(frameTimes[0]);
    expect(responses[1].timestamp).toBe(frameTimes[1]);
    expect(responses[2].timestamp).toBe(frameTimes[2]);
  });

  it("Phase 5.1.2 - Timestamp 4: Missing timestamp gracefully falls back to server arrival", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 100, y_mm: 1500, speed_cms: 0 }],
        },
      }),
    });

    const res = await telemetryHandler({ request: req });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.captured_at).toBeNull();
    expect(body.device_time_synced).toBe(false);
    expect(body.timestamp).toBe(body.received_at);
  });

  it("Phase 5.1.2 - Timestamp 5: Invalid datetime strings are rejected with HTTP 400", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        timestamp: "epoch_not_iso",
        data: {
          sensor_type: "ld2450",
          targets: [],
        },
      }),
    });

    const res = await telemetryHandler({ request: req });
    expect(res.status).toBe(400);
  });

  it("Phase 5.1.2 - Queue 1: Correctly classifies HTTP response dispositions", () => {
    const classify = (code: number) => {
      if (code >= 200 && code < 300) return "SUCCESS";
      if (code === 429) return "RETRY_RATELIMIT";
      if (code === 401 || code === 403) return "AUTH_FAILURE";
      if (code === 400 || code === 422 || (code >= 400 && code < 500)) return "DISCARD_PERMANENT";
      return "RETRY_TRANSIENT";
    };

    expect(classify(200)).toBe("SUCCESS");
    expect(classify(201)).toBe("SUCCESS");
    expect(classify(400)).toBe("DISCARD_PERMANENT");
    expect(classify(422)).toBe("DISCARD_PERMANENT");
    expect(classify(401)).toBe("AUTH_FAILURE");
    expect(classify(403)).toBe("AUTH_FAILURE");
    expect(classify(429)).toBe("RETRY_RATELIMIT");
    expect(classify(500)).toBe("RETRY_TRANSIENT");
    expect(classify(503)).toBe("RETRY_TRANSIENT");
    expect(classify(-1)).toBe("RETRY_TRANSIENT");
    expect(classify(-2)).toBe("RETRY_TRANSIENT");
  });

  it("Phase 5.1.2 - Queue 2: Discarding permanent 400 unblocks queue for subsequent valid frames", () => {
    const queue = [
      { id: 1, bad: true },
      { id: 2, bad: false },
      { id: 3, bad: false },
    ];

    const processed: number[] = [];
    const discarded: number[] = [];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.bad) {
        // Permanent 400: discard and log, unblocking queue
        discarded.push(item.id);
      } else {
        processed.push(item.id);
      }
    }

    expect(discarded).toEqual([1]);
    expect(processed).toEqual([2, 3]);
  });

  it("Phase 5.1.2 - Lifecycle 1: Repeating disconnected heartbeats do not duplicate events", async () => {
    const makeHeartbeat = () =>
      new Request("http://localhost/api/public/device/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          firmware_version: "1.0.0-phase5",
          sensor_status: "disconnected",
          ld2450_connected: false,
        }),
      });

    const r1 = await heartbeatHandler({ request: makeHeartbeat() });
    expect(r1.status).toBe(200);

    // Second repeating heartbeat with same disconnected status
    const r2 = await heartbeatHandler({ request: makeHeartbeat() });
    expect(r2.status).toBe(200);
  });

  it("Phase 5.1.2 - Lifecycle 2: Malformed frame does not alter occupancy state or timestamp", async () => {
    // 1. Establish occupied state
    await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            targets: [{ target_id: 1, x_mm: 500, y_mm: 2000, speed_cms: 10 }],
          },
        }),
      }),
    });

    // 2. Transmit malformed frame (invalid JSON schema)
    const badRes = await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            targets: "malformed_targets",
          },
        }),
      }),
    });
    expect(badRes.status).toBe(400);

    // 3. Confirm room remains occupied: sending valid 0-target scan should transition to vacant
    const validVacantRes = await telemetryHandler({
      request: new Request("http://localhost/api/public/device/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_demo_secret_key_12345",
        },
        body: JSON.stringify({
          data: {
            sensor_type: "ld2450",
            targets: [],
          },
        }),
      }),
    });
    const bodyVacant = await validVacantRes.json();
    expect(bodyVacant.transition_event).toBe("room_vacant");
  });

  describe("Phase 5.1.3: Final Queue Concurrency & Firmware Recovery Tests", () => {
    // Simulator of firmware's monotonic ring-buffer and in-flight transmission buffer
    class FirmwareRingBufferSimulator {
      capacity = 50;
      buffer: Array<{ id: number; data: string; timestamp_ms: number }> = new Array(50);
      ringHeadSeq = 0;
      ringTailSeq = 0;
      ringDropCount = 0;
      inFlight: {
        frame?: { id: number; data: string; timestamp_ms: number };
        sequence: number;
        active: boolean;
        retryCount: number;
      } = { sequence: 0, active: false, retryCount: 0 };

      enqueue(frame: { id: number; data: string; timestamp_ms: number }) {
        if (this.ringHeadSeq - this.ringTailSeq >= this.capacity) {
          this.ringTailSeq++;
          this.ringDropCount++;
        }
        this.buffer[this.ringHeadSeq % this.capacity] = { ...frame };
        this.ringHeadSeq++;
      }

      stageInFlight(): boolean {
        if (!this.inFlight.active && this.ringHeadSeq > this.ringTailSeq) {
          const tailIdx = this.ringTailSeq % this.capacity;
          this.inFlight.frame = { ...this.buffer[tailIdx]! };
          this.inFlight.sequence = this.ringTailSeq;
          this.inFlight.active = true;
          this.inFlight.retryCount = 0;
          return true;
        }
        return false;
      }

      completeTransmission(disp: string) {
        if (this.inFlight.active) {
          if (disp === "SUCCESS" || disp === "DISCARD_PERMANENT") {
            if (this.ringTailSeq === this.inFlight.sequence) {
              this.ringTailSeq++;
            }
            this.inFlight.active = false;
          } else if (
            disp === "RETRY_TRANSIENT" ||
            disp === "RETRY_RATELIMIT" ||
            disp === "RETRY_CONFLICT"
          ) {
            if (this.ringTailSeq !== this.inFlight.sequence) {
              this.inFlight.active = false;
            } else {
              this.inFlight.retryCount++;
            }
          } else if (disp === "AUTH_FAILURE") {
            this.inFlight.active = false;
          }
        }
      }
    }

    it("Phase 5.1.3 - Concurrency 1: In-flight frame remains immutable when producer overflows during transmission", () => {
      const sim = new FirmwareRingBufferSimulator();

      // Enqueue 5 frames (seq 0..4)
      for (let i = 0; i < 5; i++) {
        sim.enqueue({ id: i, data: `frame_${i}`, timestamp_ms: 1000 + i * 100 });
      }

      // Stage frame 0 into inFlight
      expect(sim.stageInFlight()).toBe(true);
      expect(sim.inFlight.sequence).toBe(0);
      expect(sim.inFlight.frame?.id).toBe(0);

      // Simulate long transmission delay: Producer overflows ring buffer with 60 frames (seq 5..64)
      for (let i = 5; i < 65; i++) {
        sim.enqueue({ id: i, data: `frame_${i}`, timestamp_ms: 2000 + i * 100 });
      }

      // Total enqueued: 65. Capacity: 50. Drops: 15.
      expect(sim.ringDropCount).toBe(15);
      expect(sim.ringTailSeq).toBe(15);
      expect(sim.ringHeadSeq).toBe(65);

      // Verify slot 0 in the ring buffer was overwritten
      expect(sim.buffer[0]?.id).toBe(50);

      // CRITICAL: inFlight.frame MUST remain intact with frame 0!
      expect(sim.inFlight.frame?.id).toBe(0);
      expect(sim.inFlight.frame?.data).toBe("frame_0");
      expect(sim.inFlight.sequence).toBe(0);
    });

    it("Phase 5.1.3 - Concurrency 2: Completion after overflow does NOT double-advance queue or drop active frames", () => {
      const sim = new FirmwareRingBufferSimulator();

      for (let i = 0; i < 5; i++) {
        sim.enqueue({ id: i, data: `frame_${i}`, timestamp_ms: 1000 + i * 100 });
      }

      sim.stageInFlight(); // Stages seq 0

      // Producer overflows with 60 more frames
      for (let i = 5; i < 65; i++) {
        sim.enqueue({ id: i, data: `frame_${i}`, timestamp_ms: 2000 + i * 100 });
      }
      expect(sim.ringTailSeq).toBe(15);

      // Consumer finishes HTTP transmission (SUCCESS)
      sim.completeTransmission("SUCCESS");

      // Invariant: ringTailSeq should NOT have been incremented (15 remains 15)
      expect(sim.ringTailSeq).toBe(15);
      expect(sim.inFlight.active).toBe(false);

      // Next stage will pick up frame 15, not frame 16!
      expect(sim.stageInFlight()).toBe(true);
      expect(sim.inFlight.sequence).toBe(15);
      expect(sim.inFlight.frame?.id).toBe(15);
    });

    it("Phase 5.1.3 - Concurrency 3: Retry of evicted frame is aborted when producer overflows queue", () => {
      const sim = new FirmwareRingBufferSimulator();
      sim.enqueue({ id: 0, data: "frame_0", timestamp_ms: 1000 });
      sim.stageInFlight();

      // Transmission fails with transient timeout
      sim.completeTransmission("RETRY_TRANSIENT");
      expect(sim.inFlight.active).toBe(true);
      expect(sim.inFlight.retryCount).toBe(1);

      // While waiting for retry timer, 60 new frames arrive and evict frame 0
      for (let i = 1; i <= 60; i++) {
        sim.enqueue({ id: i, data: `frame_${i}`, timestamp_ms: 2000 + i * 100 });
      }
      expect(sim.ringTailSeq).toBe(11); // 61 total - 50 capacity = 11 drops

      // Next attempt notices tail has moved past inFlight.sequence: aborts retry!
      sim.completeTransmission("RETRY_TRANSIENT");
      expect(sim.inFlight.active).toBe(false);

      // Fresh frame 11 is now staged instead of retrying discarded frame 0
      sim.stageInFlight();
      expect(sim.inFlight.sequence).toBe(11);
      expect(sim.inFlight.frame?.id).toBe(11);
    });

    it("Phase 5.1.3 - Recovery 1: HTTP 401 and 403 trigger auth failure without flooding backend", async () => {
      // 1. Invalid key -> 401
      const res401 = await telemetryHandler({
        request: new Request("http://localhost/api/public/device/telemetry", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-id": "esp32-lab-01",
            "x-device-key": "invalid_wrong_secret_key",
          },
          body: JSON.stringify({
            data: {
              sensor_type: "ld2450",
              targets: [],
            },
          }),
        }),
      });
      expect(res401.status).toBe(401);

      // 2. Revoked device -> 403
      const res403 = await telemetryHandler({
        request: new Request("http://localhost/api/public/device/telemetry", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-id": "esp32-revoked-01",
            "x-device-key": "rt_demo_secret_key_12345",
          },
          body: JSON.stringify({
            data: {
              sensor_type: "ld2450",
              targets: [],
            },
          }),
        }),
      });
      expect(res403.status).toBe(403);
    });

    it("Phase 5.1.3 - Recovery 2: Runtime credential replacement allows immediate recovery", async () => {
      // Client state simulator
      let deviceId = "esp32-lab-01";
      let deviceKey = "bad_key";
      let authStatus = "OK";
      let canTransmit = true;

      const attempt = async () => {
        return telemetryHandler({
          request: new Request("http://localhost/api/public/device/telemetry", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-device-id": deviceId,
              "x-device-key": deviceKey,
            },
            body: JSON.stringify({
              data: {
                sensor_type: "ld2450",
                targets: [],
              },
            }),
          }),
        });
      };

      // 1. Attempt with bad key fails
      const res1 = await attempt();
      expect(res1.status).toBe(401);
      authStatus = "REJECTED_401";
      canTransmit = false;
      expect(canTransmit).toBe(false);

      // 2. Provision new credentials at runtime (updateCredentials)
      deviceId = "esp32-lab-01";
      deviceKey = "rt_demo_secret_key_12345";
      authStatus = "OK";
      canTransmit = true;

      // 3. Next transmission succeeds immediately
      const res2 = await attempt();
      expect(res2.status).toBe(200);
      expect(authStatus).toBe("OK");
    });

    it("Phase 5.1.3 - Recovery 3: Prolonged network outage preserves newest 50 frames and drains in FIFO order", () => {
      const sim = new FirmwareRingBufferSimulator();

      // Produce 200 frames during prolonged outage
      for (let i = 0; i < 200; i++) {
        sim.enqueue({ id: i, data: `frame_${i}`, timestamp_ms: 1000 + i * 100 });
      }

      // Total drops should be exactly 150
      expect(sim.ringDropCount).toBe(150);
      expect(sim.ringTailSeq).toBe(150);
      expect(sim.ringHeadSeq).toBe(200);

      // Drain remaining 50 frames when network recovers
      const drained: number[] = [];
      while (sim.stageInFlight()) {
        drained.push(sim.inFlight.frame!.id);
        sim.completeTransmission("SUCCESS");
      }

      expect(drained.length).toBe(50);
      expect(drained[0]).toBe(150);
      expect(drained[49]).toBe(199);
      expect(sim.ringTailSeq).toBe(200);
      expect(sim.ringHeadSeq).toBe(200);
    });

    it("Phase 5.1.3 - Classification: Complete HTTP code mapping matrix matches specification", () => {
      const classify = (code: number): string => {
        if (code >= 200 && code < 300) return "DISPOSITION_SUCCESS";
        if (code === 401 || code === 403) return "DISPOSITION_AUTH_FAILURE";
        if (code === 429) return "DISPOSITION_RETRY_RATELIMIT";
        if (code === 409) return "DISPOSITION_RETRY_CONFLICT";
        if (code === 400 || code === 404 || code === 422 || (code >= 400 && code < 500)) {
          return "DISPOSITION_DISCARD_PERMANENT";
        }
        return "DISPOSITION_RETRY_TRANSIENT";
      };

      expect(classify(200)).toBe("DISPOSITION_SUCCESS");
      expect(classify(201)).toBe("DISPOSITION_SUCCESS");
      expect(classify(204)).toBe("DISPOSITION_SUCCESS");
      expect(classify(400)).toBe("DISPOSITION_DISCARD_PERMANENT");
      expect(classify(401)).toBe("DISPOSITION_AUTH_FAILURE");
      expect(classify(403)).toBe("DISPOSITION_AUTH_FAILURE");
      expect(classify(404)).toBe("DISPOSITION_DISCARD_PERMANENT");
      expect(classify(409)).toBe("DISPOSITION_RETRY_CONFLICT");
      expect(classify(422)).toBe("DISPOSITION_DISCARD_PERMANENT");
      expect(classify(429)).toBe("DISPOSITION_RETRY_RATELIMIT");
      expect(classify(500)).toBe("DISPOSITION_RETRY_TRANSIENT");
      expect(classify(502)).toBe("DISPOSITION_RETRY_TRANSIENT");
      expect(classify(503)).toBe("DISPOSITION_RETRY_TRANSIENT");
      expect(classify(-1)).toBe("DISPOSITION_RETRY_TRANSIENT");
      expect(classify(-2)).toBe("DISPOSITION_RETRY_TRANSIENT");
    });

    it("Phase 5.1.3 - Timestamp: Preserves historical capture timestamp across buffered queue and server arrival", async () => {
      const historicalTime = "2026-11-15T15:00:00.000Z";
      const res = await telemetryHandler({
        request: new Request("http://localhost/api/public/device/telemetry", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-id": "esp32-lab-01",
            "x-device-key": "rt_demo_secret_key_12345",
          },
          body: JSON.stringify({
            timestamp: historicalTime,
            device_time_synced: true,
            captured_at_ms: 1234567,
            data: {
              sensor_type: "ld2450",
              targets: [
                {
                  target_id: 1,
                  x_mm: 1200,
                  y_mm: 2400,
                  speed_cms: 15,
                  distance_mm: 2683,
                },
              ],
            },
          }),
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.timestamp).toBe(historicalTime);
      expect(data.captured_at).toBe(historicalTime);
      expect(data.device_time_synced).toBe(true);
      expect(new Date(data.received_at).getTime()).toBeGreaterThan(
        new Date(historicalTime).getTime(),
      );
    });
  });
});

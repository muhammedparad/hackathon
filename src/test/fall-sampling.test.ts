import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DEVICE, registerFixtureDevices } from "./device-fixtures";
import { createDeviceSession } from "@/lib/live/device-session.server";
import { _resetRateLimits, authenticateCredentials } from "@/lib/device-auth.server";
import {
  _resetTelemetryCache,
  processHeartbeat,
  processTelemetry,
  publishTelemetryOnReceipt,
} from "@/lib/device-ingest.server";
import { fakeDb } from "./fake-firestore";

vi.mock("@/lib/firebase/admin.server", async () => {
  const { fakeDb: db } = await import("./fake-firestore");
  return {
    getAdminFirestore: () => db,
    getAdminAuth: () => null,
    hasServiceAccount: () => true,
    verifyUserToken: async () => null,
  };
});

// A fall seen through the device WebSocket, whose storage is throttled to about 1 frame per second.
describe("fall detection sees every frame, not only the stored ones", () => {
  beforeEach(async () => {
    _resetRateLimits();
    _resetTelemetryCache();
    fakeDb.reset();
    await registerFixtureDevices();
    fakeDb.seed("rooms", TEST_DEVICE.room_id, {
      user_id: TEST_DEVICE.user_id,
      name: "Fall room",
      width_mm: 5000,
      length_mm: 6000,
      doors: [],
      zones: [],
      objects: [],
    });
  });

  const frame = (iso: string, speed: number) => ({
    type: "telemetry",
    timestamp: iso,
    device_time_synced: true,
    data: {
      sensor_type: "ld2450",
      sensor_status: "online",
      // open floor, away from everything
      targets: [{ target_id: 1, x_mm: -800, y_mm: 3000, speed_cms: speed }],
    },
  });

  it("raises candidate_fall from a spike that arrives between two stored frames", async () => {
    const session = createDeviceSession(
      { id: "dev", send: () => {}, close: () => {} },
      {
        authenticate: (id, key) => authenticateCredentials(id, key),
        publishTelemetry: publishTelemetryOnReceipt,
        storeTelemetry: (device, payload, receivedAtMs) =>
          processTelemetry(device, payload, { publish: false, receivedAtMs }),
        analyzeTelemetry: (device, payload, receivedAtMs) =>
          processTelemetry(device, payload, { publish: false, receivedAtMs, storeRaw: false }),
        handleHeartbeat: (device, body) => processHeartbeat(device, body),
      },
    );
    await session.onMessage(
      JSON.stringify({ type: "auth", device_id: TEST_DEVICE.device_id, key: TEST_DEVICE.secret }),
    );

    // The first frame is stored. The spike comes 150 ms later, inside the throttle window, so it is NOT stored,
    // and the person then lies still. Frames are 150 ms apart like the firmware's fast rate.
    const base = Date.parse("2026-06-01T10:00:00.000Z");
    const at = (ms: number) => new Date(base + ms).toISOString();
    let t = 0;
    const send = async (speed: number) => {
      await session.onMessage(JSON.stringify(frame(at(t), speed)));
      t += 150;
    };
    await send(30); // walking, stored
    await send(160); // sudden speed spike, throttled (not stored)
    for (let i = 0; i < 40; i++) await send(0); // still for 6 s
    await session.idle();

    const events = fakeDb.all("occupancy_events");
    const fall = events.find((e) => e["event_type"] === "candidate_fall");
    expect(fall).toBeDefined();
    expect(fall).toMatchObject({
      room_id: TEST_DEVICE.room_id,
      severity: "critical",
      simulated: false,
    });

    // History stays gentle: nowhere near one raw row per frame
    const raw = fakeDb.all("telemetry");
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.length).toBeLessThan(12);
  });
});

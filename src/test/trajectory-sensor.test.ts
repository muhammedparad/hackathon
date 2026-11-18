import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrajectoryRecorder } from "@/lib/radar/trajectory-recorder";
import {
  Route as TelemetryRoute,
  _resetTelemetryCache,
} from "@/routes/api/public/device/telemetry";
import { Route as HeartbeatRoute } from "@/routes/api/public/device/heartbeat";
import { _resetRateLimits } from "@/lib/device-auth.server";
import { _resetSensorStatusCache } from "@/lib/sensor-status.server";
import { TEST_DEVICE, registerFixtureDevices } from "./device-fixtures";
import { fakeDb } from "./fake-firestore";

// The ingest routes run against the in-memory Firestore instead of the real Admin SDK.
vi.mock("@/lib/firebase/admin.server", async () => {
  const { fakeDb: db } = await import("./fake-firestore");
  return {
    getAdminFirestore: () => db,
    getAdminAuth: () => null,
    hasServiceAccount: () => true,
    verifyUserToken: async () => null,
  };
});

const T0 = Date.parse("2025-06-01T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const tgt = (id: number, x: number, y: number, v = 0) => ({
  target_id: id,
  x_mm: x,
  y_mm: y,
  speed_cms: v,
});

describe("TrajectoryRecorder", () => {
  const ctx = { roomId: "room-1", deviceId: "dev-1" };

  it("closes a segment after the target has been gone longer than the gap", () => {
    const r = new TrajectoryRecorder({ gapMs: 5000 });
    expect(r.ingest(ctx, [tgt(1, 0, 1000)], T0)).toEqual([]);
    expect(r.ingest(ctx, [tgt(1, 10, 1100)], T0 + 500)).toEqual([]);
    expect(r.ingest(ctx, [tgt(1, 20, 1200)], T0 + 1000)).toEqual([]);
    expect(r.ingest(ctx, [], T0 + 3000)).toEqual([]); // still within the gap
    const done = r.ingest(ctx, [], T0 + 10_000);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      room_id: "room-1",
      device_id: "dev-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: false,
      point_count: 3,
      start_epoch: T0,
      end_epoch: T0 + 1000,
      dwell_seconds: 1,
    });
    expect(done[0]!.points[1]).toEqual({ t: T0 + 500, x: 10, y: 1100, s: 0 });
    expect(r.openCount).toBe(0);
  });

  it("keeps a target that briefly drops out in the same segment", () => {
    const r = new TrajectoryRecorder({ gapMs: 5000 });
    r.ingest(ctx, [tgt(1, 0, 1000)], T0);
    r.ingest(ctx, [], T0 + 1500); // one empty frame (flicker)
    r.ingest(ctx, [tgt(1, 5, 1010)], T0 + 2000);
    const done = r.ingest(ctx, [], T0 + 20_000);
    expect(done).toHaveLength(1);
    expect(done[0]!.point_count).toBe(2);
  });

  it("starts a new segment when the same target returns after a long gap", () => {
    const r = new TrajectoryRecorder({ gapMs: 5000 });
    r.ingest(ctx, [tgt(1, 0, 1000)], T0);
    r.ingest(ctx, [tgt(1, 1, 1000)], T0 + 500);
    const closed = r.ingest(ctx, [tgt(1, 2, 1000)], T0 + 60_000);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.point_count).toBe(2);
    expect(r.openCount).toBe(1);
  });

  it("splits long tracks to keep documents small", () => {
    const r = new TrajectoryRecorder({ maxPoints: 3 });
    const out = [];
    for (let i = 0; i < 7; i++) out.push(...r.ingest(ctx, [tgt(1, i, 1000)], T0 + i * 500));
    expect(out.map((s) => s.point_count)).toEqual([3, 3]);
  });

  it("drops one-point tracks (nothing to play back)", () => {
    const r = new TrajectoryRecorder({ gapMs: 1000 });
    r.ingest(ctx, [tgt(1, 0, 1000)], T0);
    expect(r.ingest(ctx, [], T0 + 5000)).toEqual([]);
  });

  it("tracks targets and devices independently", () => {
    const r = new TrajectoryRecorder({ gapMs: 1000 });
    r.ingest(ctx, [tgt(1, 0, 1000), tgt(2, 500, 2000)], T0);
    r.ingest(ctx, [tgt(1, 1, 1000), tgt(2, 501, 2000)], T0 + 500);
    r.ingest({ roomId: "room-2", deviceId: "dev-2" }, [tgt(1, 9, 9)], T0 + 600);
    const done = r.ingest(ctx, [], T0 + 5000);
    expect(done.map((s) => s.target_id).sort()).toEqual([1, 2]);
    expect(done.every((s) => s.device_id === "dev-1")).toBe(true);
  });
});

describe("ingest routes persist trajectories and sensor status (fake Firestore)", () => {
  const post = (route: typeof TelemetryRoute | typeof HeartbeatRoute, body: unknown) => {
    const handlers = route.options.server?.handlers as {
      POST: (a: { request: Request }) => Promise<Response>;
    };
    return handlers.POST({
      request: new Request("http://localhost/api/public/device/x", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": TEST_DEVICE.device_id,
          "x-device-key": TEST_DEVICE.secret,
        },
        body: JSON.stringify(body),
      }),
    });
  };
  const frame = (ms: number, targets: ReturnType<typeof tgt>[], extra: object = {}) =>
    post(TelemetryRoute, {
      timestamp: iso(ms),
      device_time_synced: true,
      data: { sensor_type: "ld2450", targets, ...extra },
    });

  beforeEach(async () => {
    fakeDb.reset();
    _resetTelemetryCache();
    _resetRateLimits();
    _resetSensorStatusCache();
    await registerFixtureDevices();
    fakeDb.seed("rooms", TEST_DEVICE.room_id, {
      name: "Test room",
      width_mm: 4000,
      length_mm: 5000,
    });
    fakeDb.seed("sensors", "s-ld", {
      device_id: TEST_DEVICE.doc_id,
      sensor_type: "ld2450",
      status: "unknown",
    });
    fakeDb.seed("sensors", "s-rd", {
      device_id: TEST_DEVICE.doc_id,
      sensor_type: "rd61",
      status: "unknown",
    });
  });

  it("stores a trajectory segment once the person leaves", async () => {
    expect((await frame(T0, [tgt(1, 0, 1500)])).status).toBe(200);
    await frame(T0 + 500, [tgt(1, 30, 1600, 12)]);
    await frame(T0 + 1000, [tgt(1, 60, 1700, 12)]);
    expect(fakeDb.all("trajectory_segments")).toHaveLength(0); // still in view: nothing stored yet
    await frame(T0 + 30_000, []); // empty frame well after the gap
    const segs = fakeDb.all("trajectory_segments");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      room_id: TEST_DEVICE.room_id,
      device_id: TEST_DEVICE.doc_id,
      sensor_type: "ld2450",
      target_id: 1,
      simulated: false,
      point_count: 3,
    });
    expect((segs[0]!["points"] as unknown[])[2]).toEqual({ t: T0 + 1000, x: 60, y: 1700, s: 12 });
    expect(fakeDb.all("telemetry").length).toBeGreaterThanOrEqual(4); // frames are still stored
  });

  it("stores one segment per target", async () => {
    await frame(T0, [tgt(1, 0, 1500), tgt(2, 800, 2500)]);
    await frame(T0 + 500, [tgt(1, 10, 1500), tgt(2, 810, 2500)]);
    await frame(T0 + 30_000, []);
    expect(
      fakeDb
        .all("trajectory_segments")
        .map((s) => s["target_id"])
        .sort(),
    ).toEqual([1, 2]);
  });

  it("marks the LD2450 sensor connected when real frames arrive, leaving RD-61 untouched", async () => {
    await frame(T0, [tgt(1, 0, 1500)]);
    expect(fakeDb.all("sensors").find((s) => s.id === "s-ld")!["status"]).toBe("connected");
    expect(fakeDb.all("sensors").find((s) => s.id === "s-rd")!["status"]).toBe("unknown");
  });

  it("a frame reporting the sensor disconnected stores no trajectory and marks it disconnected", async () => {
    await frame(T0, [tgt(1, 0, 1500)]);
    await frame(T0 + 500, [], { sensor_status: "disconnected" });
    expect(fakeDb.all("sensors").find((s) => s.id === "s-ld")!["status"]).toBe("disconnected");
    await frame(T0 + 60_000, [tgt(1, 0, 1500)], { sensor_status: "disconnected" });
    expect(fakeDb.all("trajectory_segments")).toHaveLength(0);
  });

  it("heartbeat updates sensor status from what the device reports", async () => {
    await post(HeartbeatRoute, { sensor_status: "online", ld2450_connected: true });
    expect(fakeDb.all("sensors").find((s) => s.id === "s-ld")!["status"]).toBe("connected");
    await post(HeartbeatRoute, { sensor_status: "disconnected", ld2450_connected: false });
    expect(fakeDb.all("sensors").find((s) => s.id === "s-ld")!["status"]).toBe("disconnected");
  });

  it("a heartbeat that says nothing about the sensor does not change its status", async () => {
    await post(HeartbeatRoute, { firmware_version: "x" });
    expect(fakeDb.all("sensors").find((s) => s.id === "s-ld")!["status"]).toBe("unknown");
  });
});

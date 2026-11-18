import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOKED_TEST_DEVICE, TEST_DEVICE, registerFixtureDevices } from "./device-fixtures";
import {
  MAX_DEVICE_MESSAGE_BYTES,
  createDeviceSession,
  type DeviceServerMessage,
  type DeviceSessionDeps,
} from "@/lib/live/device-session.server";
import { LiveHub, getLiveHub } from "@/lib/live/hub.server";
import type { LiveServerMessage } from "@/lib/live/protocol";
import { _resetRateLimits, authenticateCredentials } from "@/lib/device-auth.server";
import {
  _resetTelemetryCache,
  processHeartbeat,
  processTelemetry,
  publishTelemetryOnReceipt,
} from "@/lib/device-ingest.server";

const frame = (x = -250) => ({
  type: "telemetry",
  timestamp: "2026-06-01T10:00:00.123Z",
  device_time_synced: true,
  data: {
    sensor_type: "ld2450",
    sensor_status: "online",
    targets: [{ target_id: 1, x_mm: x, y_mm: 1800, speed_cms: 12 }],
  },
});

const auth = (key: string = TEST_DEVICE.secret, id: string = TEST_DEVICE.device_id) =>
  JSON.stringify({ type: "auth", device_id: id, key });

function setup(overrides: Partial<DeviceSessionDeps> = {}) {
  const sent: DeviceServerMessage[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  const stored: unknown[] = [];
  const published: unknown[] = [];
  const heartbeats: unknown[] = [];
  const session = createDeviceSession(
    {
      id: "dev-peer",
      send: (d) => void sent.push(JSON.parse(d) as DeviceServerMessage),
      close: (c, r) => void closed.push([c, r]),
    },
    {
      authenticate: (id, key) => authenticateCredentials(id, key),
      publishTelemetry: (_d, p) => void published.push(p),
      storeTelemetry: async (_d, p) => void stored.push(p),
      handleHeartbeat: async (_d, b) => void heartbeats.push(b),
      ...overrides,
    },
  );
  return { session, sent, closed, stored, published, heartbeats };
}

beforeEach(async () => {
  _resetRateLimits();
  _resetTelemetryCache();
  await registerFixtureDevices();
});
afterEach(() => vi.useRealTimers());

describe("device websocket session", () => {
  it("answers ping, and refuses data before auth", async () => {
    const t = setup();
    await t.session.onMessage(JSON.stringify({ type: "ping" }));
    await t.session.onMessage(JSON.stringify(frame()));
    expect(t.sent[0]).toEqual({ type: "pong" });
    expect(t.sent[1]).toMatchObject({ type: "error", code: "auth_required" });
    expect(t.published).toHaveLength(0);
    expect(t.stored).toHaveLength(0);
  });

  it("authenticates with device id + key, then publishes and stores frames", async () => {
    const t = setup();
    await t.session.onMessage(auth());
    expect(t.sent[0]).toEqual({ type: "ready", device_id: TEST_DEVICE.device_id });
    expect(t.session.deviceId).toBeTruthy();

    await t.session.onMessage(JSON.stringify(frame()));
    await t.session.idle();
    expect(t.published).toHaveLength(1);
    expect(t.stored).toHaveLength(1);
  });

  it("closes on a wrong key, an unknown device or a revoked device", async () => {
    for (const [key, id] of [
      ["rt_wrong", TEST_DEVICE.device_id],
      [TEST_DEVICE.secret, "no-such-device"],
      [TEST_DEVICE.secret, REVOKED_TEST_DEVICE.device_id],
    ] as const) {
      const t = setup();
      await t.session.onMessage(auth(key, id));
      expect(t.sent[0]).toMatchObject({ type: "error", code: "unauthorized" });
      expect(t.closed[0]?.[0]).toBe(4403);
      await t.session.onMessage(JSON.stringify(frame()));
      expect(t.published).toHaveLength(0);
    }
  });

  it("closes a socket that never authenticates", async () => {
    vi.useFakeTimers();
    const t = setup({ authTimeoutMs: 5000 });
    vi.advanceTimersByTime(5001);
    expect(t.sent[0]).toMatchObject({ type: "error", code: "auth_required" });
    expect(t.closed[0]?.[0]).toBe(4401);
    t.session.onClose();
  });

  it("rejects invalid payloads without publishing, and oversized messages with a close", async () => {
    const t = setup();
    await t.session.onMessage(auth());
    await t.session.onMessage(
      JSON.stringify({ type: "telemetry", data: { sensor_type: "ld2450", targets: [1, 2, 3, 4] } }),
    );
    await t.session.onMessage("not json");
    expect(t.sent.filter((m) => m.type === "error")).toHaveLength(2);
    expect(t.published).toHaveLength(0);

    await t.session.onMessage("x".repeat(MAX_DEVICE_MESSAGE_BYTES + 1));
    expect(t.closed[0]?.[0]).toBe(1009);
  });

  it("acks heartbeats", async () => {
    const t = setup();
    await t.session.onMessage(auth());
    await t.session.onMessage(JSON.stringify({ type: "heartbeat", firmware_version: "0.2.0" }));
    await t.session.idle();
    expect(t.sent).toContainEqual({ type: "ack", kind: "heartbeat" });
    expect(t.heartbeats).toHaveLength(1);
  });

  it("publishes live immediately even while storage is slow, and stores in order", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const order: number[] = [];
    const t = setup({
      storeIntervalMs: 0,
      storeTelemetry: async (_d, p) => {
        await gate;
        order.push(p.data.sensor_type === "ld2450" ? (p.data.targets[0]?.x_mm ?? 0) : 0);
      },
    });
    await t.session.onMessage(auth());
    await t.session.onMessage(JSON.stringify(frame(1)));
    await t.session.onMessage(JSON.stringify(frame(2)));
    await t.session.onMessage(JSON.stringify(frame(3)));
    expect(t.published).toHaveLength(3); // live view did not wait for storage
    expect(order).toHaveLength(0);
    release();
    await t.session.idle();
    expect(order).toEqual([1, 2, 3]);
  });

  it("bounds the storage backlog by dropping the oldest waiting frames", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      storeIntervalMs: 0,
      maxBacklog: 3,
      storeTelemetry: async (_d, p) => {
        await gate;
        t.stored.push(p.data.sensor_type === "ld2450" ? p.data.targets[0]?.x_mm : 0);
      },
    });
    await t.session.onMessage(auth());
    for (let i = 1; i <= 8; i++) await t.session.onMessage(JSON.stringify(frame(i)));
    expect(t.published).toHaveLength(8); // every frame still reached the live view
    release();
    await t.session.idle();
    // frame 1 was already running; of the rest only the newest 3 survive
    expect(t.stored).toEqual([1, 6, 7, 8]);
  });

  it("keeps working when storing a frame throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const t = setup({
      storeIntervalMs: 0,
      storeTelemetry: async () => {
        if (n++ === 0) throw new Error("firestore down");
        t.stored.push("ok");
      },
    });
    await t.session.onMessage(auth());
    await t.session.onMessage(JSON.stringify(frame(1)));
    await t.session.onMessage(JSON.stringify(frame(2)));
    await t.session.idle();
    expect(t.stored).toEqual(["ok"]);
    warn.mockRestore();
  });

  it("cuts a device off once its credentials stop being valid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    const t = setup({ recheckMs: 1000 });
    await t.session.onMessage(auth());
    await t.session.onMessage(JSON.stringify(frame(1)));
    expect(t.published).toHaveLength(1);

    await registerFixtureDevices();
    const { _registerTestDevice } = await import("@/lib/device-auth.server");
    await _registerTestDevice(
      {
        id: TEST_DEVICE.doc_id,
        user_id: TEST_DEVICE.user_id,
        device_id: TEST_DEVICE.device_id,
        device_name: "Test Radar Hub",
        room_id: TEST_DEVICE.room_id,
        status: "disabled",
        last_seen: null,
      },
      TEST_DEVICE.secret,
      { revoked: true },
    );
    vi.advanceTimersByTime(1500);
    _resetRateLimits();
    await t.session.onMessage(JSON.stringify(frame(2)));
    expect(t.closed[0]?.[0]).toBe(4403);
    expect(t.published).toHaveLength(1);
  });
});

describe("storage throttle (live gets every frame, history is gentler)", () => {
  const withTargets = (n: number, x: number) => ({
    type: "telemetry",
    data: {
      sensor_type: "ld2450",
      sensor_status: "online",
      targets: Array.from({ length: n }, (_, i) => ({
        target_id: i + 1,
        x_mm: x,
        y_mm: 1500,
        speed_cms: 0,
      })),
    },
  });

  it("stores about once per second while nothing changes, but publishes every frame", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    const t = setup();
    await t.session.onMessage(auth());
    for (let i = 0; i < 20; i++) {
      await t.session.onMessage(JSON.stringify(withTargets(1, i)));
      vi.advanceTimersByTime(100); // 10 frames per second for 2 seconds
    }
    await t.session.idle();
    expect(t.published).toHaveLength(20);
    expect(t.stored.length).toBeGreaterThanOrEqual(2);
    expect(t.stored.length).toBeLessThanOrEqual(3);
  });

  it("stores immediately when the number of targets changes, so entries and exits are never lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    const t = setup();
    await t.session.onMessage(auth());
    await t.session.onMessage(JSON.stringify(withTargets(0, 0)));
    vi.advanceTimersByTime(50);
    await t.session.onMessage(JSON.stringify(withTargets(1, 0)));
    vi.advanceTimersByTime(50);
    await t.session.onMessage(JSON.stringify(withTargets(2, 0)));
    vi.advanceTimersByTime(50);
    await t.session.onMessage(JSON.stringify(withTargets(0, 0)));
    await t.session.idle();
    expect(t.stored).toHaveLength(4);
  });
});

describe("device websocket end to end (real ingest, in-memory hub)", () => {
  it("a frame sent over the device socket reaches the owner's browser at once", async () => {
    const hub = getLiveHub();
    const browser: LiveServerMessage[] = [];
    hub.add(TEST_DEVICE.user_id, {
      id: "browser-1",
      send: (d: string) => void browser.push(JSON.parse(d) as LiveServerMessage),
    });
    const other: LiveServerMessage[] = [];
    hub.add("someone-else", {
      id: "browser-2",
      send: (d: string) => void other.push(JSON.parse(d) as LiveServerMessage),
    });

    const session = createDeviceSession(
      { id: "dev", send: () => {}, close: () => {} },
      {
        authenticate: (id, key) => authenticateCredentials(id, key),
        publishTelemetry: publishTelemetryOnReceipt,
        storeTelemetry: (device, payload, receivedAtMs) =>
          processTelemetry(device, payload, { publish: false, receivedAtMs }),
        handleHeartbeat: (device, body) => processHeartbeat(device, body),
      },
    );
    await session.onMessage(auth());
    await session.onMessage(JSON.stringify(frame(-250)));
    // delivered before storage finishes
    const live = browser.filter((m) => m.type === "frame");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      device_id: TEST_DEVICE.doc_id,
      sensor_type: "ld2450",
      targets: [{ target_id: 1, x_mm: -250, y_mm: 1800, speed_cms: 12 }],
    });
    await session.idle();

    // not duplicated by the storage step, and never delivered to another owner
    expect(browser.filter((m) => m.type === "frame")).toHaveLength(1);
    expect(other).toHaveLength(0);
    hub.remove("browser-1");
    hub.remove("browser-2");
    expect(new LiveHub().size).toBe(0);
  });
});

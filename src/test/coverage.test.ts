import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCoverageGaps } from "@/lib/radar/coverage";
import {
  DATA_GAP_MS,
  _resetTelemetryCache,
  noteDeviceCall,
  processHeartbeat,
  processTelemetry,
} from "@/lib/device-ingest.server";
import type { AuthenticatedDevice } from "@/lib/device-auth.server";
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

const DAY = Date.parse("2026-06-01T00:00:00.000Z");
const H = 3_600_000;
const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const win = { windowStart: DAY, windowEnd: DAY + 24 * H - 1, nowMs: DAY + 30 * H };

describe("buildCoverageGaps", () => {
  it("turns a data_gap event into a no-data period", () => {
    const gaps = buildCoverageGaps(
      [
        {
          event_type: "data_gap",
          timestamp: iso(DAY + 11 * H),
          gap_started_at: iso(DAY + 10 * H),
          gap_ended_at: iso(DAY + 11 * H),
        },
      ],
      win,
    );
    expect(gaps).toEqual([
      { from: DAY + 10 * H, to: DAY + 11 * H, kind: "device_offline", ongoing: false },
    ]);
  });

  it("pairs sensor_disconnected with the next sensor_reconnected", () => {
    const gaps = buildCoverageGaps(
      [
        { event_type: "sensor_reconnected", timestamp: iso(DAY + 9 * H + 30 * M) },
        { event_type: "sensor_disconnected", timestamp: iso(DAY + 9 * H) },
      ],
      win,
    );
    expect(gaps).toEqual([
      { from: DAY + 9 * H, to: DAY + 9 * H + 30 * M, kind: "sensor_offline", ongoing: false },
    ]);
  });

  it("keeps an unmatched disconnect open until now when the day is today", () => {
    const now = DAY + 12 * H;
    const gaps = buildCoverageGaps(
      [{ event_type: "sensor_disconnected", timestamp: iso(DAY + 11 * H) }],
      { ...win, nowMs: now },
    );
    expect(gaps).toEqual([{ from: DAY + 11 * H, to: now, kind: "sensor_offline", ongoing: true }]);
  });

  it("ends an unmatched disconnect at the end of a past day", () => {
    const gaps = buildCoverageGaps(
      [{ event_type: "sensor_disconnected", timestamp: iso(DAY + 23 * H) }],
      win,
    );
    expect(gaps[0]).toMatchObject({ from: DAY + 23 * H, to: DAY + 24 * H - 1, ongoing: false });
  });

  it("marks a current outage from a stale last_seen", () => {
    const now = DAY + 12 * H;
    const gaps = buildCoverageGaps([], { ...win, nowMs: now, lastSeenMs: now - 10 * M });
    expect(gaps).toEqual([{ from: now - 10 * M, to: now, kind: "device_offline", ongoing: true }]);
    // a device that reported a few seconds ago is not offline
    expect(buildCoverageGaps([], { ...win, nowMs: now, lastSeenMs: now - 5000 })).toEqual([]);
  });

  it("clips a gap that crosses midnight to the selected day", () => {
    const gaps = buildCoverageGaps(
      [
        {
          event_type: "data_gap",
          timestamp: iso(DAY + 2 * H),
          gap_started_at: iso(DAY - 3 * H),
          gap_ended_at: iso(DAY + 2 * H),
        },
      ],
      win,
    );
    expect(gaps[0]).toMatchObject({ from: DAY, to: DAY + 2 * H });
  });

  it("merges overlapping outages, and a device outage wins over a sensor one", () => {
    const gaps = buildCoverageGaps(
      [
        { event_type: "sensor_disconnected", timestamp: iso(DAY + 5 * H) },
        { event_type: "sensor_reconnected", timestamp: iso(DAY + 7 * H) },
        {
          event_type: "data_gap",
          timestamp: iso(DAY + 6 * H),
          gap_started_at: iso(DAY + 5 * H + 30 * M),
          gap_ended_at: iso(DAY + 6 * H),
        },
      ],
      win,
    );
    expect(gaps).toEqual([
      { from: DAY + 5 * H, to: DAY + 7 * H, kind: "device_offline", ongoing: false },
    ]);
  });

  it("ignores sub-second slivers and unrelated events", () => {
    const gaps = buildCoverageGaps(
      [
        { event_type: "room_vacant", timestamp: iso(DAY + H) },
        {
          event_type: "data_gap",
          timestamp: iso(DAY + 2 * H + 500),
          gap_started_at: iso(DAY + 2 * H),
          gap_ended_at: iso(DAY + 2 * H + 500),
        },
      ],
      win,
    );
    expect(gaps).toEqual([]);
  });
});

describe("server records a data gap when a device comes back", () => {
  const device = (over: Partial<AuthenticatedDevice> = {}): AuthenticatedDevice => ({
    id: "doc-gap",
    user_id: "u1",
    device_id: "gap-esp",
    device_name: "Gap test hub",
    room_id: "room-gap",
    status: "connected",
    last_seen: null,
    ...over,
  });
  const frame = {
    data: {
      sensor_type: "ld2450" as const,
      sensor_status: "online" as const,
      targets: [],
    },
  };

  beforeEach(() => {
    fakeDb.reset();
    _resetTelemetryCache();
  });

  it("noteDeviceCall reports silence of a minute or more, once", () => {
    const t = Date.parse("2026-06-01T10:00:00Z");
    expect(noteDeviceCall(device({ last_seen: null }), t)).toBeNull(); // first ever call
    expect(noteDeviceCall(device(), t + 10_000)).toBeNull();
    expect(noteDeviceCall(device(), t + 10_000 + DATA_GAP_MS - 1)).toBeNull();
    const gap = noteDeviceCall(device(), t + 10_000 + DATA_GAP_MS - 1 + 5 * M);
    expect(gap).toMatchObject({ from: t + 10_000 + DATA_GAP_MS - 1 });
    expect(noteDeviceCall(device(), t + 10_000 + DATA_GAP_MS + 5 * M)).toBeNull(); // not repeated
  });

  it("uses the stored last_seen after a server restart (time the server was down counts)", () => {
    const t = Date.parse("2026-06-01T10:00:00Z");
    const gap = noteDeviceCall(device({ last_seen: iso(t - 10 * M) }), t);
    expect(gap).toEqual({ from: t - 10 * M, to: t });
  });

  it("stores a data_gap event from telemetry, with when it started and ended", async () => {
    const t0 = Date.parse("2026-06-01T10:00:00Z");
    await processTelemetry(device(), frame, { publish: false, receivedAtMs: t0 });
    await processTelemetry(device(), frame, { publish: false, receivedAtMs: t0 + 5 * M });
    const gaps = fakeDb.all("occupancy_events").filter((e) => e["event_type"] === "data_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      room_id: "room-gap",
      severity: "low",
      gap_started_at: iso(t0),
      gap_ended_at: iso(t0 + 5 * M),
      simulated: false,
    });
  });

  it("stores no gap while frames keep arriving", async () => {
    const t0 = Date.parse("2026-06-01T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      await processTelemetry(
        device(),
        { ...frame, timestamp: iso(t0 + i * 10_000) },
        {
          publish: false,
          receivedAtMs: t0 + i * 10_000,
        },
      );
    }
    expect(fakeDb.all("occupancy_events").filter((e) => e["event_type"] === "data_gap")).toEqual(
      [],
    );
  });

  it("also detects it from a heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    await processHeartbeat(device(), {});
    vi.setSystemTime(new Date("2026-06-01T10:20:00Z"));
    await processHeartbeat(device(), {});
    vi.useRealTimers();
    const gaps = fakeDb.all("occupancy_events").filter((e) => e["event_type"] === "data_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ gap_started_at: "2026-06-01T10:00:00.000Z" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertEngine, type AlertEngineRoom } from "@/lib/radar/alert-engine";
import { _resetTelemetryCache, processTelemetry } from "@/lib/device-ingest.server";
import type { AuthenticatedDevice } from "@/lib/device-auth.server";
import { popupLevel } from "@/lib/notify";
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

// Room 5 m x 6 m. The sensor is at the middle of the top wall. The entry zone sits at the door, bottom right.
const entryZone = {
  id: "z-entry",
  room_id: "room-e",
  name: "Front door area",
  type: "entry" as const,
  polygon: [
    { x_mm: 3800, y_mm: 5000 },
    { x_mm: 4900, y_mm: 5000 },
    { x_mm: 4900, y_mm: 6000 },
    { x_mm: 3800, y_mm: 6000 },
  ],
  alert_on_entry: false,
};
const room: AlertEngineRoom = {
  id: "room-e",
  name: "Room",
  width_mm: 5000,
  length_mm: 6000,
  zones: [entryZone],
  doors: [],
  objects: [],
};
// sensor coordinates: x = room x - 2500
const inZone = { target_id: 1, x_mm: 1800, y_mm: 5500, speed_cms: 20 }; // room (4300, 5500)
const justOutside = { target_id: 1, x_mm: 1500, y_mm: 5500, speed_cms: 20 }; // room (4000..) edge case below
const farAway = { target_id: 1, x_mm: -1500, y_mm: 2000, speed_cms: 20 }; // room (1000, 2000)
const T0 = 7_000_000;
const primed = (r = room) => {
  const e = new AlertEngine(r);
  e.processTargets([], T0, false); // sensor running, room empty
  return e;
};

describe("entry zone", () => {
  it("is a normal entry, only logged, when someone first appears inside it", () => {
    const alerts = primed().processTargets([inZone], T0 + 10_000, false);
    const entry = alerts.find((a) => a.event_type === "door_entry");
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe("info");
    expect(entry?.zone_name).toBe("Front door area");
    expect(alerts.some((a) => a.event_type === "unexpected_entry")).toBe(false);
    expect(popupLevel(entry!)).toBeNull();
  });

  it("alerts when someone first appears anywhere outside it", () => {
    const alerts = primed().processTargets([farAway], T0 + 10_000, false);
    const bad = alerts.find((a) => a.event_type === "unexpected_entry");
    expect(bad).toBeDefined();
    expect(bad?.severity).toBe("high");
    expect(bad?.description).toContain("outside the entry zone");
    expect(bad?.evidence.zone_name).toBe("Front door area");
    expect(popupLevel(bad!)).toBe("alert");
  });

  it("allows a small margin around the zone edge, not a big one", () => {
    // 200 mm outside the left edge (x = 3800): fine. 1500 mm outside: alert.
    const near = { target_id: 1, x_mm: 1300 - 200, y_mm: 5500, speed_cms: 20 };
    const far = { target_id: 1, x_mm: 1300 - 1500, y_mm: 5500, speed_cms: 20 };
    expect(
      primed()
        .processTargets([near], T0 + 10_000, false)
        .some((a) => a.event_type === "unexpected_entry"),
    ).toBe(false);
    expect(
      primed()
        .processTargets([far], T0 + 10_000, false)
        .some((a) => a.event_type === "unexpected_entry"),
    ).toBe(true);
    void justOutside;
  });

  it("works together with an entry door: either one is a legitimate way in", () => {
    const both: AlertEngineRoom = {
      ...room,
      doors: [{ id: "d", name: "Back door", x_mm: 300, y_mm: 300, width_mm: 900, type: "entry" }],
    };
    // appears at the back door: fine
    const atDoor = primed(both).processTargets(
      [{ target_id: 1, x_mm: -2000, y_mm: 400, speed_cms: 20 }],
      T0 + 10_000,
      false,
    );
    expect(atDoor.some((a) => a.event_type === "door_entry")).toBe(true);
    expect(atDoor.some((a) => a.event_type === "unexpected_entry")).toBe(false);
    // appears mid-room: alert
    const mid = primed(both).processTargets([farAway], T0 + 10_000, false);
    expect(mid.some((a) => a.event_type === "unexpected_entry")).toBe(true);
  });

  it("raises only one alert per person, not one per frame", () => {
    const e = primed();
    const first = e.processTargets([farAway], T0 + 10_000, false);
    expect(first.filter((a) => a.event_type === "unexpected_entry")).toHaveLength(1);
    for (let s = 11; s < 30; s++) {
      expect(
        e
          .processTargets([farAway], T0 + s * 1000, false)
          .some((a) => a.event_type === "unexpected_entry"),
      ).toBe(false);
    }
  });

  it("does not judge entries when no entry door or zone exists", () => {
    const none = primed({ ...room, zones: [] });
    expect(none.processTargets([farAway], T0 + 10_000, false)).toEqual([]);
  });

  it("does not alert for people already inside when the server starts", () => {
    const e = new AlertEngine(room);
    expect(
      e.processTargets([farAway], T0, false).some((a) => a.event_type === "unexpected_entry"),
    ).toBe(false);
  });
});

describe("entry zone through the real ingest path", () => {
  const device: AuthenticatedDevice = {
    id: "doc-ez",
    user_id: "u1",
    device_id: "ez-esp",
    device_name: "EZ hub",
    room_id: "room-e",
    status: "connected",
    last_seen: null,
  };
  beforeEach(() => {
    fakeDb.reset();
    _resetTelemetryCache();
    fakeDb.seed("rooms", "room-e", {
      user_id: "u1",
      name: "Room",
      width_mm: 5000,
      length_mm: 6000,
      doors: [],
      zones: [entryZone],
      objects: [],
    });
  });

  it("stores a high unexpected_entry event for someone appearing outside the entry zone", async () => {
    const base = Date.parse("2026-06-01T10:00:00.000Z");
    const f = (s: number, t: typeof farAway | null) => ({
      timestamp: new Date(base + s * 1000).toISOString(),
      device_time_synced: true,
      data: {
        sensor_type: "ld2450" as const,
        sensor_status: "online" as const,
        targets: t ? [t] : [],
      },
    });
    await processTelemetry(device, f(0, null), { publish: false });
    await processTelemetry(device, f(10, farAway), { publish: false });
    const events = fakeDb
      .all("occupancy_events")
      .filter((e) => e["event_type"] === "unexpected_entry");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      room_id: "room-e",
      severity: "high",
      zone_name: "Front door area",
      simulated: false,
    });
  });
});

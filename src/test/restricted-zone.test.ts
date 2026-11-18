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

// Room 5 m x 6 m. Restricted zone: x 2000..3000, y 1500..2500 (room coordinates, mm).
const zone = {
  id: "z-restricted",
  room_id: "room-r",
  name: "Medicine cabinet",
  type: "restricted" as const,
  polygon: [
    { x_mm: 2000, y_mm: 1500 },
    { x_mm: 3000, y_mm: 1500 },
    { x_mm: 3000, y_mm: 2500 },
    { x_mm: 2000, y_mm: 2500 },
  ],
  alert_on_entry: true,
};
const room: AlertEngineRoom = {
  id: "room-r",
  name: "Room",
  width_mm: 5000,
  length_mm: 6000,
  zones: [zone],
  doors: [],
  objects: [],
};
// Sensor coordinates: x = room x - 2500
const inside = (id = 1) => ({ target_id: id, x_mm: 0, y_mm: 2000, speed_cms: 5 });
const outside = (id = 1) => ({ target_id: id, x_mm: -2000, y_mm: 4500, speed_cms: 5 });
const T0 = 5_000_000;

describe("restricted zone alerts (engine)", () => {
  it("alerts critically the moment someone steps in, and names the zone", () => {
    const e = new AlertEngine(room);
    e.processTargets([outside()], T0, false);
    const alerts = e.processTargets([inside()], T0 + 500, false);
    const entry = alerts.find((a) => a.event_type === "restricted_zone_entry");
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe("critical");
    expect(entry?.zone_name).toBe("Medicine cabinet");
    expect(popupLevel(entry!)).toBe("critical");
  });

  it("also alerts when someone is first seen already inside the zone", () => {
    const e = new AlertEngine(room);
    const alerts = e.processTargets([inside()], T0, false);
    expect(alerts.some((a) => a.event_type === "restricted_zone_entry")).toBe(true);
  });

  it("repeats while the person stays inside, not on every frame", () => {
    const e = new AlertEngine(room);
    e.processTargets([inside()], T0, false);
    const presence: number[] = [];
    for (let s = 1; s <= 95; s++) {
      for (const a of e.processTargets([inside()], T0 + s * 1000, false)) {
        if (a.event_type === "restricted_zone_presence") presence.push(s);
      }
    }
    expect(presence).toEqual([30, 60, 90]);
  });

  it("raises a high alert for the repeats, and stops after they leave with an exit event", () => {
    const e = new AlertEngine(room);
    e.processTargets([inside()], T0, false);
    const rep = e.processTargets([inside()], T0 + 31_000, false);
    const again = rep.find((a) => a.event_type === "restricted_zone_presence");
    expect(again?.severity).toBe("high");
    expect(again?.description).toContain("still inside");

    const left = e.processTargets([outside()], T0 + 32_000, false);
    expect(left.some((a) => a.event_type === "restricted_zone_exit")).toBe(true);
    for (let s = 33; s <= 100; s++) {
      const more = e.processTargets([outside()], T0 + s * 1000, false);
      expect(more.some((a) => a.event_type === "restricted_zone_presence")).toBe(false);
    }
  });

  it("starts a fresh entry (and a fresh repeat clock) when they come back", () => {
    const e = new AlertEngine(room);
    e.processTargets([inside()], T0, false);
    e.processTargets([outside()], T0 + 1000, false);
    const back = e.processTargets([inside()], T0 + 2000, false);
    expect(back.some((a) => a.event_type === "restricted_zone_entry")).toBe(true);
    const soon = e.processTargets([inside()], T0 + 10_000, false);
    expect(soon.some((a) => a.event_type === "restricted_zone_presence")).toBe(false);
  });

  it("does not alert for a bed zone, or a zone with alert on entry switched off", () => {
    const quiet = new AlertEngine({
      ...room,
      zones: [
        { ...zone, id: "bed", type: "bed", alert_on_entry: false },
        { ...zone, id: "custom", type: "custom", alert_on_entry: false },
      ],
    });
    const alerts = quiet.processTargets([inside()], T0, false);
    expect(alerts.filter((a) => a.event_type === "restricted_zone_entry")).toEqual([]);
    for (let s = 1; s <= 70; s++) {
      expect(
        quiet
          .processTargets([inside()], T0 + s * 1000, false)
          .filter((a) => a.event_type.startsWith("restricted_zone")),
      ).toEqual([]);
    }
  });
});

describe("restricted zone alerts (through the real ingest path)", () => {
  const device: AuthenticatedDevice = {
    id: "doc-rz",
    user_id: "u1",
    device_id: "rz-esp",
    device_name: "RZ hub",
    room_id: "room-r",
    status: "connected",
    last_seen: null,
  };
  const frame = (iso: string, t: ReturnType<typeof inside> | null) => ({
    timestamp: iso,
    device_time_synced: true,
    data: {
      sensor_type: "ld2450" as const,
      sensor_status: "online" as const,
      targets: t ? [t] : [],
    },
  });

  beforeEach(() => {
    fakeDb.reset();
    _resetTelemetryCache();
    fakeDb.seed("rooms", "room-r", {
      user_id: "u1",
      name: "Room",
      width_mm: 5000,
      length_mm: 6000,
      doors: [],
      zones: [zone],
      objects: [],
    });
  });

  it("stores a critical restricted_zone_entry event for the owner's room", async () => {
    const base = Date.parse("2026-06-01T10:00:00.000Z");
    const iso = (s: number) => new Date(base + s * 1000).toISOString();
    await processTelemetry(device, frame(iso(0), outside()), { publish: false });
    await processTelemetry(device, frame(iso(1), inside()), { publish: false });
    const events = fakeDb
      .all("occupancy_events")
      .filter((e) => e["event_type"] === "restricted_zone_entry");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      room_id: "room-r",
      severity: "critical",
      zone_name: "Medicine cabinet",
      simulated: false,
      acknowledged: false,
    });
  });

  it("stores the repeat alerts while they stay, then an exit", async () => {
    const base = Date.parse("2026-06-01T10:00:00.000Z");
    const iso = (s: number) => new Date(base + s * 1000).toISOString();
    for (let s = 0; s <= 65; s += 5) {
      await processTelemetry(device, frame(iso(s), inside()), { publish: false });
    }
    await processTelemetry(device, frame(iso(70), outside()), { publish: false });
    const types = fakeDb.all("occupancy_events").map((e) => e["event_type"]);
    expect(types.filter((t) => t === "restricted_zone_entry")).toHaveLength(1);
    expect(types.filter((t) => t === "restricted_zone_presence")).toHaveLength(2);
    expect(types.filter((t) => t === "restricted_zone_exit")).toHaveLength(1);
  });
});

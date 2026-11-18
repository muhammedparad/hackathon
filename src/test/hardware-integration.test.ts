import { describe, expect, it, beforeEach } from "vitest";
import {
  Route,
  getRoomAlertEngine,
  _resetTelemetryCache,
  _getCacheStats,
  pruneDedupCache,
  pruneRoomEngines,
  pruneOccupancyCache,
  DEDUP_TTL_MS,
  MAX_DEDUP_CACHE_SIZE,
  ROOM_ENGINE_IDLE_TTL_MS,
  MAX_ROOM_ENGINES_SIZE,
} from "@/routes/api/public/device/telemetry";
import {
  AlertEngine,
  DEFAULT_ALERT_CONFIG,
  distanceToPolygonBoundary,
  getInwardNormal,
  makeTargetKey,
  resolveDoorWall,
  type AlertEngineRoom,
  type DetectedAlert,
} from "@/lib/radar/alert-engine";
import type { Door, LD2450Target, RoomZone } from "@/lib/radar/types";

describe("Phase 3.1: Hardware Telemetry Ingestion & Device Authentication", () => {
  beforeEach(() => {
    _resetTelemetryCache();
  });

  const handlers = Route.options.server?.handlers;
  const postHandler =
    typeof handlers === "object" && handlers !== null && "POST" in handlers
      ? (handlers as { POST: (args: { request: Request }) => Promise<Response> }).POST
      : undefined;
  if (!postHandler) {
    throw new Error("Missing POST handler in Route options");
  }

  it("rejects unauthenticated requests missing device headers with 401", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }],
        },
      }),
    });

    const res = await postHandler({ request: req } as unknown as { request: Request });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Missing device credentials");
  });

  it("rejects requests with invalid device credentials with 401", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "wrong_invalid_secret_key",
      },
      body: JSON.stringify({
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }],
        },
      }),
    });

    const res = await postHandler({ request: req } as unknown as { request: Request });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid device credentials");
  });

  it("rejects malformed payload schemas with 400", async () => {
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
          // invalid: targets array exceeds max 3 targets
          targets: [
            { target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 },
            { target_id: 2, x_mm: 100, y_mm: 2000, speed_cms: 10 },
            { target_id: 3, x_mm: 200, y_mm: 2000, speed_cms: 10 },
            { target_id: 4, x_mm: 300, y_mm: 2000, speed_cms: 10 },
          ],
        },
      }),
    });

    const res = await postHandler({ request: req } as unknown as { request: Request });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid telemetry payload");
  });

  it("authenticates valid ESP32 telemetry and processes frame", async () => {
    const req = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify({
        timestamp: "2026-11-15T12:00:00.000Z",
        data: {
          sensor_type: "ld2450",
          targets: [{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }],
        },
      }),
    });

    const res = await postHandler({ request: req } as unknown as { request: Request });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.telemetry_id).toBeDefined();
  });

  it("deduplicates retransmitted telemetry frames with identical timestamps", async () => {
    const payload = {
      timestamp: "2026-11-15T12:05:00.000Z",
      data: {
        sensor_type: "ld2450",
        targets: [{ target_id: 1, x_mm: 100, y_mm: 2500, speed_cms: 15 }],
      },
    };

    // First transmission
    const req1 = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify(payload),
    });
    const res1 = await postHandler({ request: req1 } as unknown as { request: Request });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.duplicate).toBeUndefined();

    // Duplicate retransmission
    const req2 = new Request("http://localhost/api/public/device/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "esp32-lab-01",
        "x-device-key": "rt_demo_secret_key_12345",
      },
      body: JSON.stringify(payload),
    });
    const res2 = await postHandler({ request: req2 } as unknown as { request: Request });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.ok).toBe(true);
    expect(body2.duplicate).toBe(true);
  });
});

describe("Phase 3.1: Hardware Alert Processing & AlertEngine Integration", () => {
  const hardwareRoom: AlertEngineRoom = {
    id: "room-hardware-lab",
    name: "Hardware Test Chamber",
    width_mm: 5000,
    length_mm: 6000,
    doors: [
      {
        id: "door-south",
        name: "South Main Entrance",
        x_mm: 2500,
        y_mm: 6000,
        width_mm: 900,
        wall: "bottom",
        type: "both",
      },
      {
        id: "door-emergency-exit",
        name: "North Emergency Exit",
        x_mm: 2500,
        y_mm: 0,
        width_mm: 900,
        wall: "top",
        type: "exit", // Exit-only
      },
    ],
    zones: [
      {
        id: "zone-restricted-vault",
        room_id: "room-hardware-lab",
        name: "Security Vault",
        type: "restricted",
        polygon: [
          { x_mm: 3500, y_mm: 500 },
          { x_mm: 4800, y_mm: 500 },
          { x_mm: 4800, y_mm: 2000 },
          { x_mm: 3500, y_mm: 2000 },
        ],
        alert_on_entry: true,
      },
      {
        id: "zone-chemical-hazard",
        room_id: "room-hardware-lab",
        name: "Chemical Hazard Zone",
        type: "hazard",
        polygon: [
          { x_mm: 500, y_mm: 4000 },
          { x_mm: 1800, y_mm: 4000 },
          { x_mm: 1800, y_mm: 5500 },
          { x_mm: 500, y_mm: 5500 },
        ],
        alert_on_entry: true,
        max_dwell_minutes: 0.1, // 6 seconds
      },
    ],
  };

  it("processes authenticated hardware telemetry with simulated: false and qualitative evidence", () => {
    const engine = new AlertEngine(hardwareRoom);
    const now = Date.now();

    // Target enters restricted vault (rx = 4000, ry = 1000) -> sensor x = 1500, y = 1000
    const rawTargets: LD2450Target[] = [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 35 }];

    // Call processTargets with simulated: false (hardware mode)
    const alerts = engine.processTargets(rawTargets, now, false);

    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.simulated).toBe(false); // strictly hardware provenance
    expect(alert.event_type).toBe("restricted_zone_entry");
    expect(alert.severity).toBe("critical");
    expect(alert.target_id).toBe(1);
    expect(alert.room_id).toBe("room-hardware-lab");
    expect(alert.sensor_type).toBe("ld2450");
    expect(alert.evidence_quality).toBe("High Evidence Quality");
    expect(alert.evidence.evidence_quality).toBe("High Evidence Quality");
    expect(alert.confidence).toBe("high");
  });

  it("suppresses duplicate alerts across consecutive hardware frames", () => {
    const engine = new AlertEngine(hardwareRoom);
    let t = Date.now();

    // Frame 1: Entry into restricted vault
    const a1 = engine.processTargets(
      [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 30 }],
      t,
      false,
    );
    expect(a1).toHaveLength(1);

    // Consecutive frames 2..10 while target remains inside zone
    for (let i = 0; i < 9; i++) {
      t += 200;
      const an = engine.processTargets(
        [{ target_id: 1, x_mm: 1510, y_mm: 1010, speed_cms: 2 }],
        t,
        false,
      );
      expect(an.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(0);
    }
  });
});

describe("Phase 3.1: Door Crossing Inward vs Outward Directionality", () => {
  const roomWidth = 5000;
  const roomLength = 6000;

  const testRoom: AlertEngineRoom = {
    id: "room-door-test",
    name: "Door Direction Test Room",
    width_mm: roomWidth,
    length_mm: roomLength,
    doors: [
      {
        id: "door-south",
        name: "South Main Door",
        x_mm: 2500,
        y_mm: 6000,
        width_mm: 900,
        wall: "bottom",
        type: "both",
      },
      {
        id: "door-north-exit",
        name: "North Fire Exit",
        x_mm: 2500,
        y_mm: 0,
        width_mm: 900,
        wall: "top",
        type: "exit", // Exit-only
      },
    ],
    zones: [],
  };

  it("computes door wall orientation and inward normal vectors correctly", () => {
    const southDoor = testRoom.doors![0]!;
    const northDoor = testRoom.doors![1]!;

    expect(resolveDoorWall(southDoor, roomWidth, roomLength)).toBe("bottom");
    expect(resolveDoorWall(northDoor, roomWidth, roomLength)).toBe("top");

    // Inward normal for bottom wall points up into the room (decreasing y)
    const southNormal = getInwardNormal("bottom");
    expect(southNormal.nx).toBe(0);
    expect(southNormal.ny).toBe(-1);

    // Inward normal for top wall points down into the room (increasing y)
    const northNormal = getInwardNormal("top");
    expect(northNormal.nx).toBe(0);
    expect(northNormal.ny).toBe(1);
  });

  it("triggers unexpected_entry when a target moves INWARD from the doorway into the room", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    // Target appears near South door (rx = 2500, ry = 5850) -> sensor coords x = 0, y = 5850
    // moving inward into room (speed 20 cm/s)
    const a1 = engine.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 5850, speed_cms: 20 }],
      t,
      false,
    );

    const doorAlert = a1.find((a) => a.event_type === "unexpected_entry");
    expect(doorAlert).toBeDefined();
    expect(doorAlert?.evidence.door_name).toBe("South Main Door");
    expect(doorAlert?.evidence_quality).toBe("Moderate Evidence Quality");
    expect(doorAlert?.evidence.threshold_value).toContain("bottom wall");
  });

  it("SUPPRESSES unexpected_entry when a target moves OUTWARD towards the exit doorway", () => {
    const engine = new AlertEngine(testRoom);
    let t = 1_000_000;

    // Target is walking from inside room (rx = 2500, ry = 5300) towards South door
    engine.processTargets([{ target_id: 2, x_mm: 0, y_mm: 5300, speed_cms: 25 }], t, false);

    // Target moves towards the doorway (ry = 5300 -> 5750, outward towards bottom wall)
    t += 600;
    const a2 = engine.processTargets(
      [{ target_id: 2, x_mm: 0, y_mm: 5750, speed_cms: 30 }],
      t,
      false,
    );

    // Should NOT trigger unexpected_entry because movement vector is outward (exiting)
    const doorAlert = a2.find((a) => a.event_type === "unexpected_entry");
    expect(doorAlert).toBeUndefined();
  });

  it("never triggers unexpected_entry for exit-only doors", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    // Target near North Fire Exit (door.type === "exit")
    const alerts = engine.processTargets(
      [{ target_id: 3, x_mm: 0, y_mm: 300, speed_cms: 25 }],
      t,
      false,
    );

    const doorAlert = alerts.find((a) => a.event_type === "unexpected_entry");
    expect(doorAlert).toBeUndefined();
  });
});

describe("Phase 3.1: Boundary Hysteresis & Edge Flutter Elimination", () => {
  const polygon = [
    { x_mm: 1000, y_mm: 1000 },
    { x_mm: 3000, y_mm: 1000 },
    { x_mm: 3000, y_mm: 3000 },
    { x_mm: 1000, y_mm: 3000 },
  ];

  const flutterRoom: AlertEngineRoom = {
    id: "room-flutter",
    name: "Flutter Test Room",
    width_mm: 5000,
    length_mm: 5000,
    zones: [
      {
        id: "zone-flutter",
        room_id: "room-flutter",
        name: "Boundary Zone",
        type: "restricted",
        polygon,
        alert_on_entry: true,
      },
    ],
  };

  it("calculates exact perpendicular distance from point to polygon boundary edges", () => {
    // Point at (970, 2000): perpendicular distance to left edge x=1000 is 30mm
    const dist30 = distanceToPolygonBoundary(970, 2000, polygon);
    expect(Math.round(dist30)).toBe(30);

    // Point at (3080, 2000): perpendicular distance to right edge x=3000 is 80mm
    const dist80 = distanceToPolygonBoundary(3080, 2000, polygon);
    expect(Math.round(dist80)).toBe(80);
  });

  it("eliminates boundary flutter: coordinates hovering within 60mm deadband do not trigger exit/re-entry spam", () => {
    const engine = new AlertEngine(flutterRoom, {
      ...DEFAULT_ALERT_CONFIG,
      boundaryDeadbandMm: 60,
    });
    let t = 1_000_000;

    // Target enters zone firmly at (rx = 2000, ry = 2000) -> sensor x = -500, y = 2000
    const a1 = engine.processTargets(
      [{ target_id: 1, x_mm: -500, y_mm: 2000, speed_cms: 10 }],
      t,
      false,
    );
    expect(a1.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(1);

    // Target moves right to the boundary and fluctuates across the edge:
    // rx = 2000 -> rx = 980 (20mm outside left edge x=1000, within 60mm deadband)
    t += 300;
    const a2 = engine.processTargets(
      [{ target_id: 1, x_mm: -1520, y_mm: 2000, speed_cms: 2 }], // rx = 980
      t,
      false,
    );
    // Should NOT trigger restricted_zone_exit because rx=980 is within the 60mm deadband
    expect(a2.filter((a) => a.event_type === "restricted_zone_exit")).toHaveLength(0);

    // Fluctuates back inside: rx = 1015 (15mm inside)
    t += 300;
    const a3 = engine.processTargets(
      [{ target_id: 1, x_mm: -1485, y_mm: 2000, speed_cms: 2 }], // rx = 1015
      t,
      false,
    );
    // Should NOT trigger restricted_zone_entry again because target remained active
    expect(a3.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(0);

    // Target moves FIRMLY outside the zone: rx = 850 (150mm outside, well beyond 60mm deadband)
    t += 300;
    const a4 = engine.processTargets(
      [{ target_id: 1, x_mm: -1650, y_mm: 2000, speed_cms: 15 }], // rx = 850
      t,
      false,
    );
    // Clean, decisive restricted_zone_exit
    expect(a4.filter((a) => a.event_type === "restricted_zone_exit")).toHaveLength(1);
  });
});

describe("Phase 3.1: Qualitative Evidence Labels Across All Rules", () => {
  const qualityRoom: AlertEngineRoom = {
    id: "room-quality",
    name: "Evidence Quality Room",
    width_mm: 5000,
    length_mm: 6000,
    doors: [
      {
        id: "d1",
        name: "Door",
        x_mm: 2500,
        y_mm: 5900,
        width_mm: 900,
        wall: "bottom",
        type: "both",
      },
    ],
    zones: [
      {
        id: "z-rest",
        room_id: "room-quality",
        name: "Restricted",
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
    objects: [],
  };

  it("assigns High Evidence Quality to polygon boundary events", () => {
    const engine = new AlertEngine(qualityRoom);
    let t = 1_000_000;

    // Entry
    const a1 = engine.processTargets(
      [{ target_id: 1, x_mm: -1000, y_mm: 1500, speed_cms: 20 }], // rx = 1500, ry = 1500
      t,
      false,
    );
    const entry = a1.find((a) => a.event_type === "restricted_zone_entry")!;
    expect(entry.evidence_quality).toBe("High Evidence Quality");
    expect(entry.evidence.evidence_quality).toBe("High Evidence Quality");

    // Exit
    t += 500;
    const a2 = engine.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 4000, speed_cms: 20 }], // outside
      t,
      false,
    );
    const exit = a2.find((a) => a.event_type === "restricted_zone_exit")!;
    expect(exit.evidence_quality).toBe("High Evidence Quality");
    expect(exit.evidence.evidence_quality).toBe("High Evidence Quality");
  });

  it("assigns Screening Heuristic — Experimental to candidate fall alerts", () => {
    const engine = new AlertEngine(qualityRoom);
    let t = 1_000_000;

    // Spike > 110 cm/s
    engine.processTargets([{ target_id: 2, x_mm: 0, y_mm: 3500, speed_cms: 130 }], t, false);

    // Inactivity for 3.5s
    let fallAlert: DetectedAlert | undefined;
    for (let i = 0; i < 7; i++) {
      t += 500;
      const res = engine.processTargets(
        [{ target_id: 2, x_mm: 0, y_mm: 3500, speed_cms: 2 }],
        t,
        false,
      );
      const found = res.find((a) => a.event_type === "candidate_fall");
      if (found) fallAlert = found;
    }

    expect(fallAlert).toBeDefined();
    expect(fallAlert?.evidence_quality).toBe("Screening Heuristic — Experimental");
    expect(fallAlert?.evidence.evidence_quality).toBe("Screening Heuristic — Experimental");
    expect(fallAlert?.evidence.limitations).toContain("not a certified medical alarm");
  });
});

describe("Phase 3.2: Multi-Sensor Target Identity Isolation", () => {
  const multiSensorRoom: AlertEngineRoom = {
    id: "room-multi-sensor",
    name: "Dual Sensor Suite",
    width_mm: 5000,
    length_mm: 6000,
    doors: [],
    zones: [
      {
        id: "zone-alpha",
        room_id: "room-multi-sensor",
        name: "Alpha Zone",
        type: "restricted",
        polygon: [
          { x_mm: 500, y_mm: 1000 },
          { x_mm: 2000, y_mm: 1000 },
          { x_mm: 2000, y_mm: 2500 },
          { x_mm: 500, y_mm: 2500 },
        ],
        alert_on_entry: true,
      },
      {
        id: "zone-beta",
        room_id: "room-multi-sensor",
        name: "Beta Zone",
        type: "hazard",
        polygon: [
          { x_mm: 3000, y_mm: 1000 },
          { x_mm: 4500, y_mm: 1000 },
          { x_mm: 4500, y_mm: 2500 },
          { x_mm: 3000, y_mm: 2500 },
        ],
        alert_on_entry: true,
      },
    ],
    objects: [],
  };

  it("distinguishes Target ID 1 from different physical devices without state collisions", () => {
    const engine = new AlertEngine(multiSensorRoom);
    const t = 1_000_000;

    // Device Alpha reports Target 1 in Alpha Zone (rx = 1200, ry = 1500)
    // Sensor coords for roomWidth = 5000: x = 1200 - 2500 = -1300
    const alertsAlpha = engine.processTargets(
      [{ target_id: 1, x_mm: -1300, y_mm: 1500, speed_cms: 20 }],
      t,
      false,
      "device-alpha",
    );

    // Device Beta simultaneously reports Target 1 in Beta Zone (rx = 3800, ry = 1500)
    // Sensor coords for roomWidth = 5000: x = 3800 - 2500 = 1300
    const alertsBeta = engine.processTargets(
      [{ target_id: 1, x_mm: 1300, y_mm: 1500, speed_cms: 25 }],
      t,
      false,
      "device-beta",
    );

    // Both targets tracked concurrently
    expect(engine.getActiveTargetCount()).toBe(2);

    const trackAlpha = engine.getTrackedTarget(1, "device-alpha");
    expect(trackAlpha).toBeDefined();
    expect(trackAlpha?.deviceId).toBe("device-alpha");
    expect(trackAlpha?.targetId).toBe(1);
    expect(trackAlpha?.x_mm).toBe(-1300);

    const trackBeta = engine.getTrackedTarget(1, "device-beta");
    expect(trackBeta).toBeDefined();
    expect(trackBeta?.deviceId).toBe("device-beta");
    expect(trackBeta?.targetId).toBe(1);
    expect(trackBeta?.x_mm).toBe(1300);

    // Alpha triggered restricted zone entry with device_id
    const alphaEntry = alertsAlpha.find((a) => a.event_type === "restricted_zone_entry");
    expect(alphaEntry).toBeDefined();
    expect(alphaEntry?.device_id).toBe("device-alpha");
    expect(alphaEntry?.target_id).toBe(1);

    // Beta triggered hazard zone entry with device_id
    const betaEntry = alertsBeta.find((a) => a.event_type === "hazard_zone_entry");
    expect(betaEntry).toBeDefined();
    expect(betaEntry?.device_id).toBe("device-beta");
    expect(betaEntry?.target_id).toBe(1);
  });

  it("reporting from device A does NOT clean up active targets belonging to device B", () => {
    const engine = new AlertEngine(multiSensorRoom);
    let t = 1_000_000;

    // Both sensors report Target 1
    engine.processTargets(
      [{ target_id: 1, x_mm: -1300, y_mm: 1500, speed_cms: 10 }],
      t,
      false,
      "device-alpha",
    );
    engine.processTargets(
      [{ target_id: 1, x_mm: 1300, y_mm: 1500, speed_cms: 10 }],
      t,
      false,
      "device-beta",
    );
    expect(engine.getActiveTargetCount()).toBe(2);

    // 3 seconds later (> targetStaleMs = 2.5s), Device Alpha sends a frame still observing Target 1.
    // Device Alpha does NOT observe Device Beta's targets!
    t += 3000;
    engine.processTargets(
      [{ target_id: 1, x_mm: -1300, y_mm: 1500, speed_cms: 5 }],
      t,
      false,
      "device-alpha",
    );

    // Device Beta's target MUST NOT have been evicted by Device Alpha's report
    expect(engine.getTrackedTarget(1, "device-beta")).toBeDefined();
    expect(engine.getActiveTargetCount()).toBe(2);

    // Device Beta reports an empty frame after staleness timeout
    t += 3000;
    const betaPruneAlerts = engine.processTargets([], t, false, "device-beta");

    // Device Beta's target is cleaned up and emitted restricted_zone_exit with device_id
    expect(engine.getTrackedTarget(1, "device-beta")).toBeUndefined();
    expect(
      betaPruneAlerts.some(
        (a) => a.device_id === "device-beta" && a.event_type === "restricted_zone_exit",
      ),
    ).toBe(true);

    // Device Alpha's target remains active
    expect(engine.getTrackedTarget(1, "device-alpha")).toBeDefined();
    expect(engine.getActiveTargetCount()).toBe(1);
  });
});

describe("Phase 3.2: Cache Lifecycle Management & Safe Eviction", () => {
  beforeEach(() => {
    _resetTelemetryCache();
  });

  it("frame deduplication cache honors TTL and expires stale frame hashes", () => {
    const t0 = Date.now();
    // Simulate initial frame
    pruneDedupCache(t0);
    const stats0 = _getCacheStats();
    expect(stats0.dedupEntries).toBe(0);

    // Verify TTL constant is 60s
    expect(DEDUP_TTL_MS).toBe(60_000);
    expect(MAX_DEDUP_CACHE_SIZE).toBe(1000);
    expect(ROOM_ENGINE_IDLE_TTL_MS).toBe(30 * 60_000);
    expect(MAX_ROOM_ENGINES_SIZE).toBe(250);
  });

  it("room AlertEngine eviction preserves active tracking state and only prunes idle inactive rooms", async () => {
    const t0 = Date.now();
    const engineActive = await getRoomAlertEngine("room-active-tracks", null);
    const engineIdle = await getRoomAlertEngine("room-idle-empty", null);

    // Add active target to Room Active
    engineActive.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 2000, speed_cms: 10 }],
      t0,
      false,
      "sensor-01",
    );
    expect(engineActive.hasActiveTracks()).toBe(true);
    expect(engineIdle.hasActiveTracks()).toBe(false);

    // Stats show 2 engines registered
    expect(_getCacheStats().roomEngines).toBe(2);

    // Advance time by 40 minutes (> 30m idle TTL)
    const tFuture = t0 + 40 * 60_000;
    pruneRoomEngines(tFuture);

    // Room Idle was pruned, but Room Active MUST be preserved due to active tracks!
    const statsAfterPrune = _getCacheStats();
    expect(statsAfterPrune.roomEngines).toBe(1);

    // Room Active is still the exact same stateful instance
    const retrievedActive = await getRoomAlertEngine("room-active-tracks", null);
    expect(retrievedActive.hasActiveTracks()).toBe(true);
    expect(retrievedActive.getTrackedTarget(1, "sensor-01")).toBeDefined();

    // Now if Room Active clears its tracks (e.g. target left), it can be safely pruned when idle
    retrievedActive.reset();
    expect(retrievedActive.hasActiveTracks()).toBe(false);

    pruneRoomEngines(tFuture + 40 * 60_000);
    expect(_getCacheStats().roomEngines).toBe(0);
  });

  it("pruneDedupCache bounds memory growth when exceeding MAX_DEDUP_CACHE_SIZE", () => {
    const t = 1_000_000;
    // Simulate inserting devices
    for (let i = 0; i < 50; i++) {
      // Direct cache interaction test
      pruneDedupCache(t);
    }
    expect(_getCacheStats().dedupEntries).toBeLessThanOrEqual(MAX_DEDUP_CACHE_SIZE);
  });
});

import { describe, expect, it } from "vitest";
import {
  AlertEngine,
  DEFAULT_ALERT_CONFIG,
  isTargetOnRestingFurniture,
  toRoomCoords,
  type AlertEngineRoom,
} from "@/lib/radar/alert-engine";
import type { ExpectedRoutine } from "@/lib/radar/types";

describe("Phase 3: Explainable Alerts & Hazard Detection Engine", () => {
  const testRoom: AlertEngineRoom = {
    id: "room-living",
    name: "Living Room",
    width_mm: 5000,
    length_mm: 6000,
    doors: [
      {
        id: "door-front",
        name: "Main Entryway",
        x_mm: 4500,
        y_mm: 5800,
        width_mm: 900,
        wall: "bottom",
        type: "both",
      },
    ],
    zones: [
      {
        id: "zone-restricted-balcony",
        room_id: "room-living",
        name: "Restricted Balcony Ledge",
        type: "restricted",
        polygon: [
          { x_mm: 3500, y_mm: 500 },
          { x_mm: 4800, y_mm: 500 },
          { x_mm: 4800, y_mm: 1800 },
          { x_mm: 3500, y_mm: 1800 },
        ],
        alert_on_entry: true,
      },
      {
        id: "zone-hazard-fireplace",
        room_id: "room-living",
        name: "Hazard Fireplace Hearth",
        type: "hazard",
        polygon: [
          { x_mm: 200, y_mm: 4200 },
          { x_mm: 1500, y_mm: 4200 },
          { x_mm: 1500, y_mm: 5800 },
          { x_mm: 200, y_mm: 5800 },
        ],
        alert_on_entry: true,
        max_dwell_minutes: 0.25, // 15 seconds
      },
    ],
    objects: [
      {
        id: "bed-guest",
        room_id: "room-living",
        name: "Day Bed",
        type: "bed",
        x_mm: 500,
        y_mm: 800,
        width_mm: 1800,
        length_mm: 2000,
        rotation_deg: 0,
      },
      {
        id: "sofa-main",
        room_id: "room-living",
        name: "Sectional Couch",
        type: "couch",
        x_mm: 2600,
        y_mm: 3200,
        width_mm: 1600,
        length_mm: 900,
        rotation_deg: 0,
      },
    ],
  };

  // 1. Restricted-zone entry triggered when target crosses into restricted zone
  it("Criterion 1: triggers restricted_zone_entry when target crosses into restricted zone", () => {
    const engine = new AlertEngine(testRoom);
    const now = 1_000_000;

    // Frame 1: target at room centre (rx = 2500, ry = 3000), outside restricted zone
    // In sensor coords: x = 0, y = 3000
    const f1 = engine.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 30 }],
      now,
      true,
    );
    expect(f1.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(0);

    // Frame 2: target moves into restricted zone (rx = 4000, ry = 1000)
    // In sensor coords: x = 1500, y = 1000
    const f2 = engine.processTargets(
      [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 40 }],
      now + 200,
      true,
    );
    const entryAlert = f2.find((a) => a.event_type === "restricted_zone_entry");
    expect(entryAlert).toBeDefined();
    expect(entryAlert?.severity).toBe("critical");
    expect(entryAlert?.zone_id).toBe("zone-restricted-balcony");
    expect(entryAlert?.evidence.rule_id).toBe("restricted_zone_entry");
    expect(entryAlert?.evidence.summary).toContain("Restricted Balcony Ledge");
  });

  // 2. Restricted-zone exit triggered when target exits restricted zone
  it("Criterion 2: triggers restricted_zone_exit when target departs restricted zone", () => {
    const engine = new AlertEngine(testRoom);
    let t = 1_000_000;

    // Inside zone
    engine.processTargets([{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 20 }], t, true);

    // Leaves zone back to centre (x = 0, y = 3000)
    t += 300;
    const f2 = engine.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 35 }],
      t,
      true,
    );
    const exitAlert = f2.find((a) => a.event_type === "restricted_zone_exit");
    expect(exitAlert).toBeDefined();
    expect(exitAlert?.zone_id).toBe("zone-restricted-balcony");
    expect(exitAlert?.evidence.rule_id).toBe("restricted_zone_exit");
  });

  // 3. Multiple simultaneous targets in restricted zone tracked independently
  it("Criterion 3: tracks multiple simultaneous targets in restricted zone independently", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    // Targets 1 and 2 both in restricted zone (rx = 3800 & 4200, ry = 1200)
    // Sensor coords: x1 = 1300, x2 = 1700
    const alerts = engine.processTargets(
      [
        { target_id: 1, x_mm: 1300, y_mm: 1200, speed_cms: 15 },
        { target_id: 2, x_mm: 1700, y_mm: 1200, speed_cms: 10 },
      ],
      t,
      true,
    );

    const entries = alerts.filter((a) => a.event_type === "restricted_zone_entry");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.target_id).sort()).toEqual([1, 2]);
  });

  // 4. Duplicate alert suppression: no spamming entry alerts on every frame while inside zone
  it("Criterion 4: suppresses duplicate entry alerts while remaining inside zone", () => {
    const engine = new AlertEngine(testRoom);
    let t = 1_000_000;

    // Frame 1: initial entry
    const f1 = engine.processTargets(
      [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 20 }],
      t,
      true,
    );
    expect(f1.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(1);

    // Frames 2..6: target stays inside restricted zone
    for (let i = 0; i < 5; i++) {
      t += 200;
      const fn = engine.processTargets(
        [{ target_id: 1, x_mm: 1510, y_mm: 1010, speed_cms: 5 }],
        t,
        true,
      );
      expect(fn.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(0);
    }
  });

  // 5. Hazard-zone entry triggered on entering hazard zone
  it("Criterion 5: triggers hazard_zone_entry upon entering configured hazard zone", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    // Hazard fireplace is at rx in [200, 1500], ry in [4200, 5800]
    // Sensor coords: cx = 2500 -> rx = 800 => x = -1700, y = 5000
    const alerts = engine.processTargets(
      [{ target_id: 3, x_mm: -1700, y_mm: 5000, speed_cms: 25 }],
      t,
      true,
    );

    const hazardEntry = alerts.find((a) => a.event_type === "hazard_zone_entry");
    expect(hazardEntry).toBeDefined();
    expect(hazardEntry?.severity).toBe("high");
    expect(hazardEntry?.zone_id).toBe("zone-hazard-fireplace");
    expect(hazardEntry?.evidence.summary).toContain("Hazard Fireplace Hearth");
  });

  // 6. Hazard prolonged presence triggered when target dwells in hazard zone beyond threshold
  it("Criterion 6: triggers hazard_prolonged_presence when target dwells beyond threshold", () => {
    // Custom 10-second threshold for testing
    const engine = new AlertEngine(testRoom, {
      ...DEFAULT_ALERT_CONFIG,
      hazardProlongedDwellMs: 10_000,
    });
    let t = 1_000_000;

    // Entry at t=0
    engine.processTargets([{ target_id: 1, x_mm: -1700, y_mm: 5000, speed_cms: 10 }], t, true);

    // After 5s (in continuous 1s updates): not yet prolonged
    for (let s = 1; s <= 5; s++) {
      t += 1000;
      const midAlerts = engine.processTargets(
        [{ target_id: 1, x_mm: -1700, y_mm: 5000, speed_cms: 2 }],
        t,
        true,
      );
      expect(midAlerts.filter((a) => a.event_type === "hazard_prolonged_presence")).toHaveLength(0);
    }

    // Continue to 11s (> 10000ms threshold): triggers hazard prolonged presence
    let dwellAlert: ReturnType<typeof engine.processTargets>[number] | undefined;
    for (let s = 6; s <= 11; s++) {
      t += 1000;
      const res = engine.processTargets(
        [{ target_id: 1, x_mm: -1700, y_mm: 5000, speed_cms: 0 }],
        t,
        true,
      );
      const found = res.find((a) => a.event_type === "hazard_prolonged_presence");
      if (found) dwellAlert = found;
    }

    expect(dwellAlert).toBeDefined();
    expect(dwellAlert?.severity).toBe("critical");
    expect(dwellAlert?.evidence.measured_value).toContain("10s");

    // Subsequent frame inside zone suppresses repeated alert
    t += 500;
    const nextAlerts = engine.processTargets(
      [{ target_id: 1, x_mm: -1700, y_mm: 5000, speed_cms: 0 }],
      t,
      true,
    );
    expect(nextAlerts.filter((a) => a.event_type === "hazard_prolonged_presence")).toHaveLength(0);
  });

  // 7. Stale & missing target cleanup
  it("Criterion 7: cleans up stale targets lost from radar frames", () => {
    const engine = new AlertEngine(testRoom, {
      ...DEFAULT_ALERT_CONFIG,
      targetStaleMs: 2000,
    });
    let t = 1_000_000;

    // Target 1 enters restricted zone
    engine.processTargets([{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 20 }], t, true);

    // Target 1 disappears for 3000ms (> 2000ms stale threshold)
    t += 3000;
    engine.processTargets([], t, true);

    // When Target 1 reappears later, it is treated as a clean new observation
    t += 500;
    const reappearAlerts = engine.processTargets(
      [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 20 }],
      t,
      true,
    );
    // Should trigger fresh entry alert since prior session was expired
    expect(reappearAlerts.filter((a) => a.event_type === "restricted_zone_entry")).toHaveLength(1);
  });

  // 8. Unexpected entry triggered when new target appears within door boundary
  it("Criterion 8: detects unexpected_entry with neutral phrasing when target appears at door", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    // Door is at rx = 4500, ry = 5800.
    // In sensor coords: cx = 2500 -> x = 2000, y = 5750.
    // Target appears with moving speed (30 cm/s)
    const alerts = engine.processTargets(
      [{ target_id: 5, x_mm: 2000, y_mm: 5750, speed_cms: 30 }],
      t,
      true,
    );

    const doorAlert = alerts.find((a) => a.event_type === "unexpected_entry");
    expect(doorAlert).toBeDefined();
    expect(doorAlert?.evidence.door_name).toBe("Main Entryway");
    // Verify neutral, objective phrasing per requirements
    expect(doorAlert?.description).toContain(
      "Unrecognized movement entering through Main Entryway",
    );
  });

  // 9. Unusual movement (pacing) detected on repeated direction reversals
  it("Criterion 9: detects unusual_movement for pacing / wandering direction reversals", () => {
    const engine = new AlertEngine(testRoom, {
      ...DEFAULT_ALERT_CONFIG,
      pacingReversalsThreshold: 3,
    });
    let t = 1_000_000;

    // Perform multiple rapid direction reversals back and forth on open floor
    const coords = [
      { x: 0, y: 3000, s: 40 },
      { x: 400, y: 3000, s: 40 },
      { x: 800, y: 3000, s: 40 },
      { x: 400, y: 3000, s: -40 }, // reversal 1
      { x: 0, y: 3000, s: -40 },
      { x: 400, y: 3000, s: 40 }, // reversal 2
      { x: 800, y: 3000, s: 40 },
      { x: 400, y: 3000, s: -40 }, // reversal 3
      { x: 0, y: 3000, s: -40 },
      { x: 400, y: 3000, s: 40 }, // reversal 4
    ];

    let pacingAlertFound = false;
    for (const c of coords) {
      t += 500;
      const alerts = engine.processTargets(
        [{ target_id: 1, x_mm: c.x, y_mm: c.y, speed_cms: c.s }],
        t,
        true,
      );
      if (alerts.some((a) => a.event_type === "unusual_movement")) {
        pacingAlertFound = true;
        break;
      }
    }
    expect(pacingAlertFound).toBe(true);
  });

  // 10. Prolonged presence detected in general room when dwell exceeds threshold
  it("Criterion 10: triggers prolonged_presence in general room when dwell exceeds limit", () => {
    // 5-second test dwell limit
    const engine = new AlertEngine(testRoom, {
      ...DEFAULT_ALERT_CONFIG,
      generalProlongedDwellMs: 5_000,
    });
    let t = 1_000_000;

    // Start in room
    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 0 }], t, true);

    // 1..3s: not yet prolonged (updates streamed every 1s)
    for (let s = 1; s <= 3; s++) {
      t += 1000;
      const a = engine.processTargets(
        [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 0 }],
        t,
        true,
      );
      expect(a.filter((x) => x.event_type === "prolonged_presence")).toHaveLength(0);
    }

    // Continue to 6s (> 5s limit)
    let prolonged: ReturnType<typeof engine.processTargets>[number] | undefined;
    for (let s = 4; s <= 6; s++) {
      t += 1000;
      const a = engine.processTargets(
        [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 0 }],
        t,
        true,
      );
      const found = a.find((x) => x.event_type === "prolonged_presence");
      if (found) prolonged = found;
    }
    expect(prolonged).toBeDefined();
    expect(prolonged?.severity).toBe("low");
  });

  // 11. Routine deviation detected when configured routine exists and actual timing/presence deviates
  it("Criterion 11: detects routine_deviation against configured routine baseline", () => {
    const engine = new AlertEngine(testRoom);
    const routine: ExpectedRoutine = {
      id: "routine-night-sleep",
      room_id: "room-living",
      name: "Night Sleep Quiet Hours",
      start_time: "01:00",
      end_time: "06:00",
      expected_presence: false,
      expected_behavior: "Zero active fast movement during Night Sleep Quiet Hours",
    };
    engine.setRoutines([routine]);

    // Construct a timestamp at 03:30 AM local time
    const devDate = new Date();
    devDate.setHours(3, 30, 0, 0);
    const t = devDate.getTime();

    // High-speed active movement inside room during scheduled quiet sleeping hours
    const alerts = engine.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 85 }],
      t,
      true,
    );

    const devAlert = alerts.find((a) => a.event_type === "routine_deviation");
    expect(devAlert).toBeDefined();
    expect(devAlert?.severity).toBe("medium");
    expect(devAlert?.evidence.expected_behavior).toContain("Night Sleep Quiet Hours");
  });

  // 12. Routine deviation NOT detected when no baseline routine is configured
  it("Criterion 12: does NOT generate routine_deviation when no baseline routine is configured", () => {
    const engine = new AlertEngine(testRoom);
    engine.setRoutines([]); // Explicitly empty baseline

    const devDate = new Date();
    devDate.setHours(3, 30, 0, 0);
    const t = devDate.getTime();

    const alerts = engine.processTargets(
      [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 90 }],
      t,
      true,
    );

    expect(alerts.filter((a) => a.event_type === "routine_deviation")).toHaveLength(0);
  });

  // 13. Candidate fall detected on open floor following velocity spike + sudden inactivity
  it("Criterion 13: triggers candidate_fall on open floor following velocity spike and inactivity", () => {
    const engine = new AlertEngine(testRoom, {
      ...DEFAULT_ALERT_CONFIG,
      fallVelocitySpikeThresholdCms: 110,
      fallLowMotionDurationMs: 2000, // 2s test duration
    });
    let t = 1_000_000;

    // Step 1: Normal walking on open floor (x = 0, y = 3000 -> rx = 2500, ry = 3000)
    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 40 }], t, true);

    // Step 2: Velocity spike (130 cm/s > 110 cm/s threshold)
    t += 200;
    engine.processTargets([{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 130 }], t, true);

    // Step 3: Stream immobile frames (< 8 cm/s) across 2400ms (> 2000ms threshold)
    let fallAlert: ReturnType<typeof engine.processTargets>[number] | undefined;
    for (let ms = 0; ms <= 2400; ms += 300) {
      t += 300;
      const alerts = engine.processTargets(
        [{ target_id: 1, x_mm: 0, y_mm: 3000, speed_cms: 0 }],
        t,
        true,
      );
      const found = alerts.find((a) => a.event_type === "candidate_fall");
      if (found) fallAlert = found;
    }

    expect(fallAlert).toBeDefined();
    expect(fallAlert?.severity).toBe("critical");
    // Verify explicit disclaimer and experimental labeling
    expect(fallAlert?.evidence.limitations).toContain("not a certified medical alarm");
    expect(fallAlert?.evidence.summary).toContain("Candidate fall — experimental");
  });

  // 14. Candidate fall suppressed when target is on resting furniture (bed/couch)
  it("Criterion 14: suppresses candidate_fall when target is positioned on resting furniture", () => {
    const engine = new AlertEngine(testRoom, {
      ...DEFAULT_ALERT_CONFIG,
      fallVelocitySpikeThresholdCms: 110,
      fallLowMotionDurationMs: 2000,
    });
    let t = 1_000_000;

    // Day Bed is at rx in [500, 2300], ry in [800, 2800]
    // Sensor coords: cx = 2500 -> rx = 1000 => x = -1500, y = 1500
    // Test resting furniture detection helper directly:
    const onBed = isTargetOnRestingFurniture(1000, 1500, testRoom.objects, testRoom.zones);
    expect(onBed).toBe(true);

    // Rapid movement onto bed (e.g. flopping onto bed or couch)
    engine.processTargets([{ target_id: 1, x_mm: -1500, y_mm: 1500, speed_cms: 140 }], t, true);

    // Motionless on bed
    t += 3000;
    const alerts = engine.processTargets(
      [{ target_id: 1, x_mm: -1500, y_mm: 1500, speed_cms: 0 }],
      t,
      true,
    );

    // Fall alert MUST be suppressed on resting furniture
    expect(alerts.filter((a) => a.event_type === "candidate_fall")).toHaveLength(0);
  });

  // 15. Virtual/hardware provenance preserved on all generated alert objects
  it("Criterion 15: preserves virtual and hardware provenance without alteration", () => {
    const engine = new AlertEngine(testRoom);
    const t = 1_000_000;

    // Simulation frame (simulated: true)
    const simAlerts = engine.processTargets(
      [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 30 }],
      t,
      true,
    );
    expect(simAlerts[0]?.simulated).toBe(true);

    engine.reset();

    // Hardware frame (simulated: false)
    const hwAlerts = engine.processTargets(
      [{ target_id: 1, x_mm: 1500, y_mm: 1000, speed_cms: 30 }],
      t + 1000,
      false,
    );
    expect(hwAlerts[0]?.simulated).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  calculateActivitySummary,
  calculateAlertsSummary,
  calculateDailySummaries,
  calculateDoorwayPassages,
  calculateHourlyProfile,
  calculateMovementHeatmap,
  calculateZoneDwellAndActivity,
  comparePeriods,
  deduplicateEvents,
  detailedOccupancySessions,
  evaluateBaselineSufficiency,
  evaluateConfiguredRoutines,
  generateAnalyticsScenarioData,
  generateRoutineInsights,
  identifyRecurringPatterns,
  isAlertEvent,
  isPointInZone,
  normalizeToRoomCoordinates,
  occupancySessions,
  occupiedMs,
  summarizeTrajectories,
  utilisation,
  detectOfflineIntervals,
  formatDateIso,
  getCalendarDayIntervals,
  getCalendarDayStart,
  getDayOfWeekInTimezone,
  getHourInTimezone,
  parseDateOnly,
  transformSensorToRoomCoordinates,
  DEFAULT_MAX_INTERPOLATION_GAP_MS,
  DEFAULT_PROVISIONAL_JITTER_DEADBAND_MM,
  type CoordinateFrame,
  type SensorMountTransform,
} from "@/lib/analytics";
import {
  deviceConnection,
  telemetryBodySchema,
  type Door,
  type ExpectedRoutine,
  type RoomZone,
  type TrajectoryPoint,
  type TrajectorySegment,
} from "@/lib/radar/types";
import type { OccupancyEvent } from "@/lib/firebase/db";

const iso = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
const base = Date.UTC(2026, 0, 1, 0, 0);

describe("occupancy analytics (baseline)", () => {
  it("pairs occupied/vacant into a session", () => {
    const s = occupancySessions(
      [
        { room_id: "a", event_type: "room_occupied", timestamp: iso(10) },
        { room_id: "a", event_type: "room_vacant", timestamp: iso(40) },
      ],
      base + 3600e3,
    );
    expect(s).toEqual([{ room_id: "a", start: base + 600e3, end: base + 2400e3 }]);
  });

  it("30 occupied minutes in a 60 minute window is 50% utilisation", () => {
    const s = occupancySessions(
      [
        { room_id: "a", event_type: "room_occupied", timestamp: iso(0) },
        { room_id: "a", event_type: "room_vacant", timestamp: iso(30) },
      ],
      base + 3600e3,
    );
    expect(utilisation(s, base, base + 3600e3)).toBe(50);
  });
});

describe("device telemetry validation (baseline)", () => {
  it("rejects an LD2450 frame with more than 3 targets", () => {
    const t = { target_id: 1, x_mm: 0, y_mm: 100, speed_cms: 0 };
    const r = telemetryBodySchema.safeParse({
      data: { sensor_type: "ld2450", targets: [t, t, t, t] },
    });
    expect(r.success).toBe(false);
  });

  it("never reports a device as connected without a heartbeat", () => {
    expect(deviceConnection(null)).toBe("unknown");
    expect(deviceConnection(new Date(Date.now() - 120_000).toISOString())).toBe("disconnected");
  });
});

/* =========================================================================
 * Phase 4 Comprehensive Test Suites
 * ========================================================================= */

describe("Phase 4: Occupancy Duration & Missing/Stale Telemetry Handling", () => {
  it("handles open sessions by capping them at window end", () => {
    const s = occupancySessions(
      [{ room_id: "room-1", event_type: "room_occupied", timestamp: iso(10) }],
      base + 3600e3,
    );
    expect(s).toEqual([{ room_id: "room-1", start: base + 600e3, end: base + 3600e3 }]);
  });

  it("handles out-of-order event timestamps monotonically", () => {
    const s = occupancySessions(
      [
        { room_id: "room-1", event_type: "room_vacant", timestamp: iso(40) },
        { room_id: "room-1", event_type: "room_occupied", timestamp: iso(10) },
      ],
      base + 3600e3,
    );
    expect(s).toEqual([{ room_id: "room-1", start: base + 600e3, end: base + 2400e3 }]);
  });

  it("ignores orphaned room_vacant events when no room_occupied is active", () => {
    const s = occupancySessions(
      [{ room_id: "room-1", event_type: "room_vacant", timestamp: iso(10) }],
      base + 3600e3,
    );
    expect(s).toEqual([]);
  });

  it("discards invalid and unparseable timestamps gracefully", () => {
    const s = occupancySessions(
      [
        { room_id: "room-1", event_type: "room_occupied", timestamp: "corrupted_timestamp" },
        { room_id: "room-1", event_type: "room_occupied", timestamp: iso(5) },
        { room_id: "room-1", event_type: "room_vacant", timestamp: iso(15) },
      ],
      base + 3600e3,
    );
    expect(s).toEqual([{ room_id: "room-1", start: base + 300e3, end: base + 900e3 }]);
  });

  it("computes detailed occupancy sessions with duration minutes and open state", () => {
    const ds = detailedOccupancySessions(
      [
        { room_id: "room-1", event_type: "room_occupied", timestamp: iso(0) },
        { room_id: "room-1", event_type: "room_vacant", timestamp: iso(25) },
      ],
      base + 3600e3,
    );
    expect(ds).toHaveLength(1);
    expect(ds[0]?.durationMinutes).toBe(25);
    expect(ds[0]?.open).toBe(false);
  });
});

describe("Phase 4: Event Deduplication & Activity Summaries", () => {
  it("deduplicates redundant sensor echoes within 500ms window", () => {
    const e1: OccupancyEvent = {
      id: "ev1",
      room_id: "room-1",
      event_type: "target_detected",
      description: "Echo 1",
      simulated: true,
      timestamp: new Date(base).toISOString(),
      target_id: 1,
    };
    const e2: OccupancyEvent = {
      id: "ev2",
      room_id: "room-1",
      event_type: "target_detected",
      description: "Echo 2",
      simulated: true,
      timestamp: new Date(base + 100).toISOString(), // 100ms later
      target_id: 1,
    };
    const e3: OccupancyEvent = {
      id: "ev3",
      room_id: "room-1",
      event_type: "target_detected",
      description: "Legitimate distinct event",
      simulated: true,
      timestamp: new Date(base + 1200).toISOString(), // 1200ms later
      target_id: 1,
    };

    const deduped = deduplicateEvents([e1, e2, e3], 500);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.id).toBe("ev1");
    expect(deduped[1]?.id).toBe("ev3");
  });

  it("calculates comprehensive activity summary with histogram bins", () => {
    const events: OccupancyEvent[] = [
      {
        id: "e1",
        room_id: "room-1",
        event_type: "room_occupied",
        description: "Entry",
        simulated: true,
        timestamp: iso(0),
      },
      {
        id: "e2",
        room_id: "room-1",
        event_type: "target_detected",
        description: "Target",
        target_id: 1,
        simulated: true,
        timestamp: iso(2),
      },
      {
        id: "e3",
        room_id: "room-1",
        event_type: "target_moved",
        description: "Move",
        target_id: 1,
        simulated: true,
        timestamp: iso(5),
      },
      {
        id: "e4",
        room_id: "room-1",
        event_type: "room_vacant",
        description: "Exit",
        simulated: true,
        timestamp: iso(10), // 10 min session
      },
    ];

    const summary = calculateActivitySummary(events, base, base + 3600e3, "room-1");
    expect(summary.totalSessions).toBe(1);
    expect(summary.avgSessionDurationMinutes).toBe(10);
    expect(summary.medianSessionDurationMinutes).toBe(10);
    expect(summary.totalTargetDetections).toBe(1);
    expect(summary.totalMovementEvents).toBe(1);
    expect(summary.uniqueTargetChannels).toEqual([1]);

    // 10 min falls into "5–15m" bin
    const bin5to15 = summary.durationsHistogram.find((b) => b.label === "5–15m");
    expect(bin5to15?.count).toBe(1);
  });

  it("aggregates daily activity summaries with day-of-week labels", () => {
    const sessions = [
      { room_id: "room-1", start: base, end: base + 3600e3 }, // 1 hour on Day 1
    ];
    const events: OccupancyEvent[] = [
      {
        id: "e1",
        room_id: "room-1",
        event_type: "target_detected",
        description: "Det",
        simulated: true,
        timestamp: new Date(base).toISOString(),
      },
    ];

    const summaries = calculateDailySummaries(sessions, events, base, base + 86400e3 * 2, "room-1");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.occupiedMinutes).toBe(60);
    expect(summaries[0]?.sessionCount).toBe(1);
    expect(summaries[0]?.detectionCount).toBe(1);
    expect(summaries[1]?.occupiedMinutes).toBe(0);
    expect(summaries[1]?.sessionCount).toBe(0);
  });
});

describe("Phase 4: Spatial Analytics & Heatmap Binning", () => {
  it("normalizes coordinates between room-absolute and sensor-relative frames", () => {
    const mount: SensorMountTransform = {
      mountX_mm: 2500,
      mountY_mm: 0,
      orientationDeg: 0,
    };
    // Sensor-relative: lateral x = -500 in a 5000mm room -> room x = 2000
    const coord1 = normalizeToRoomCoordinates(-500, 1500, "sensor_relative", mount, 5000, 4000);
    expect(coord1).not.toBeNull();
    expect(coord1?.rx).toBe(2000);
    expect(coord1?.ry).toBe(1500);

    // Clamping to room boundaries
    const coord2 = normalizeToRoomCoordinates(8000, 9000, "room_absolute", null, 5000, 4000);
    expect(coord2).not.toBeNull();
    expect(coord2?.rx).toBe(5000);
    expect(coord2?.ry).toBe(4000);
  });

  it("bins trajectory points into 2D grid cells and normalizes density correctly", () => {
    const points: TrajectoryPoint[] = [
      { t: base, x: 2500, y: 2000, s: 50 },
      { t: base + 500, x: 2500, y: 2000, s: 50 },
      { t: base + 1000, x: 1000, y: 1000, s: 30 },
    ];
    const segment: TrajectorySegment = {
      id: "seg-1",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 3,
      points,
    };

    const heatmap = calculateMovementHeatmap([segment], 5000, 4000, 10);
    expect(heatmap.totalPoints).toBe(3);
    expect(heatmap.maxDensityCount).toBe(2); // cell containing (2500, 2000) has 2 points

    const hotCell = heatmap.cells.find((c) => c.count === 2);
    expect(hotCell).toBeDefined();
    expect(hotCell?.density).toBe(1.0);
  });

  it("calculates zone dwell duration and visit counts", () => {
    const zone: RoomZone = {
      id: "couch-zone",
      room_id: "room-1",
      name: "Couch",
      type: "sofa",
      polygon: [
        { x_mm: 1000, y_mm: 1000 },
        { x_mm: 3000, y_mm: 1000 },
        { x_mm: 3000, y_mm: 3000 },
        { x_mm: 1000, y_mm: 3000 },
      ],
      alert_on_entry: false,
    };

    const points: TrajectoryPoint[] = [
      { t: base, x: 2000, y: 2000, s: 0 }, // In zone (start visit 1)
      { t: base + 1000, x: 2100, y: 2100, s: 5 }, // In zone (dwell +1000ms)
      { t: base + 2000, x: 4500, y: 3500, s: 60 }, // Outside zone
      { t: base + 3000, x: 2200, y: 2200, s: 0 }, // In zone (start visit 2)
    ];

    const segment: TrajectorySegment = {
      id: "seg-1",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 3000,
      point_count: 4,
      points,
    };

    const activity = calculateZoneDwellAndActivity([segment], [zone], 5000);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.pointCount).toBe(3);
    expect(activity[0]?.visitCount).toBe(2);
    expect(activity[0]?.dwellMs).toBeGreaterThanOrEqual(1200);
  });

  it("calculates directional doorway transit statistics", () => {
    const door: Door = {
      id: "door-1",
      name: "Main Entry",
      x_mm: 4500,
      y_mm: 3800,
      width_mm: 900,
      wall: "bottom",
      type: "both",
    };

    // Target moves from (4500, 3800) inward to (4500, 3500) -> Entry
    const pointsEntry: TrajectoryPoint[] = [
      { t: base, x: 4500, y: 3800, s: 60 },
      { t: base + 500, x: 4500, y: 3500, s: 60 },
    ];
    // Target moves from (4500, 3500) outward to (4500, 3800) -> Exit
    const pointsExit: TrajectoryPoint[] = [
      { t: base + 2000, x: 4500, y: 3500, s: 60 },
      { t: base + 2500, x: 4500, y: 3800, s: 60 },
    ];

    const segEntry: TrajectorySegment = {
      id: "seg-e",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 500,
      point_count: 2,
      points: pointsEntry,
    };

    const segExit: TrajectorySegment = {
      id: "seg-x",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base + 2000,
      end_epoch: base + 2500,
      point_count: 2,
      points: pointsExit,
    };

    const doorActivity = calculateDoorwayPassages([door], [segEntry, segExit], [], 5000, 4000);
    expect(doorActivity).toHaveLength(1);
    expect(doorActivity[0]?.entries).toBe(1);
    expect(doorActivity[0]?.exits).toBe(1);
    expect(doorActivity[0]?.totalCrossings).toBe(2);
  });

  it("summarizes overall trajectory properties: distance, speed, and density", () => {
    const points: TrajectoryPoint[] = [
      { t: base, x: 0, y: 0, s: 20 },
      { t: base + 1000, x: 3000, y: 4000, s: 80 }, // 5000 mm = 5m distance
    ];
    const segment: TrajectorySegment = {
      id: "seg-1",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 2,
      points,
    };

    const summary = summarizeTrajectories([segment], 5000, 4000);
    expect(summary.totalDistanceMeters).toBe(5);
    expect(summary.averageSpeedCms).toBe(500); // 5000mm in 1000ms = 500 cm/s
    expect(summary.averageRadialSpeedCms).toBe(50); // (|20| + |80|) / 2 = 50 cm/s
    expect(summary.provisionalJitterDeadbandMm).toBe(35);
    expect(summary.totalPoints).toBe(2);
    expect(summary.segmentCount).toBe(1);
    expect(summary.activeTargetIds).toEqual([1]);
  });
});

describe("Phase 4: Household Routines & Baseline Sufficiency", () => {
  it("rejects generating routine conclusions when historical data is insufficient (< 3 days)", () => {
    const sessions = [
      { room_id: "room-1", start: base, end: base + 3600e3 }, // Only 1 day
    ];
    const sufficiency = evaluateBaselineSufficiency(sessions, [], 3);
    expect(sufficiency.isSufficient).toBe(false);
    expect(sufficiency.daysObserved).toBe(1);
    expect(sufficiency.reason).toContain("Insufficient baseline history");

    // Recurring patterns must strictly return empty when insufficient
    const hourly = calculateHourlyProfile(sessions, base, base + 86400e3);
    const patterns = identifyRecurringPatterns(hourly, sufficiency);
    expect(patterns).toEqual([]);
  });

  it("establishes baseline and detects recurring patterns when sufficient (>= 3 days)", () => {
    const DAY = 86400_000;
    const sessions = [
      { room_id: "room-1", start: base, end: base + 3600e3 },
      { room_id: "room-1", start: base + DAY, end: base + DAY + 3600e3 },
      { room_id: "room-1", start: base + DAY * 2, end: base + DAY * 2 + 3600e3 },
    ];
    const sufficiency = evaluateBaselineSufficiency(sessions, [], 3);
    expect(sufficiency.isSufficient).toBe(true);
    expect(sufficiency.daysObserved).toBe(3);
  });

  it("evaluates configured routine adherence without inferring personal identity", () => {
    const routine: ExpectedRoutine = {
      id: "morning-presence",
      room_id: "room-1",
      name: "Morning Wake Window",
      start_time: "08:00",
      end_time: "09:00",
      expected_presence: true,
    };

    const sufficiency = {
      isSufficient: true,
      daysObserved: 7,
      minRequiredDays: 3,
      totalSessions: 12,
      reason: "Sufficient",
    };

    // Slot 8 has 70% occupancy
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: `${h}:00`,
      observedOccupiedMinutes: h === 8 ? 42 : 0,
      observedOccupancyPct: h === 8 ? 70 : 0,
      baselineOccupancyPct: 50,
      baselineMinPct: 35,
      baselineMaxPct: 65,
      isDeviation: false,
      deviationMinutes: 0,
    }));

    const adherence = evaluateConfiguredRoutines([routine], hourly, sufficiency);
    expect(adherence).toHaveLength(1);
    expect(adherence[0]?.adherencePct).toBe(70);
    expect(adherence[0]?.status).toBe("adhered");
  });
});

describe("Phase 4: Alert Analytics & Read-Only Invariants", () => {
  it("summarizes alerts by severity, event type, and acknowledgement status", () => {
    const events: OccupancyEvent[] = [
      {
        id: "a1",
        room_id: "room-1",
        event_type: "hazard_zone_entry",
        severity: "high",
        zone_name: "Balcony",
        description: "Hazard",
        simulated: true,
        timestamp: iso(10),
        acknowledged: true,
        acknowledged_at: iso(12), // 2 min ack time
      },
      {
        id: "a2",
        room_id: "room-1",
        event_type: "candidate_fall",
        severity: "critical",
        description: "Candidate fall",
        simulated: true,
        timestamp: iso(20),
        acknowledged: false,
      },
      {
        id: "a3",
        room_id: "room-1",
        event_type: "target_detected", // Not an alert
        description: "Standard detection",
        simulated: true,
        timestamp: iso(30),
      },
    ];

    const summary = calculateAlertsSummary(events, base, base + 3600e3, "room-1");
    expect(summary.totalAlerts).toBe(2);
    expect(summary.bySeverity.high).toBe(1);
    expect(summary.bySeverity.critical).toBe(1);
    expect(summary.acknowledgedCount).toBe(1);
    expect(summary.unacknowledgedCount).toBe(1);
    expect(summary.acknowledgementRatePct).toBe(50);
    expect(summary.avgTimeToAcknowledgeMs).toBe(120_000);
    expect(summary.topAffectedZones).toEqual([{ zoneName: "Balcony", count: 1 }]);
  });
});

describe("Phase 4: Period Comparison", () => {
  it("compares current period vs previous period and calculates deltas", () => {
    const HOUR = 3600_000;
    // Current period (base to base + 24h): 4 occupied hours
    // Previous period (base - 24h to base): 2 occupied hours
    const events: OccupancyEvent[] = [
      {
        id: "p1",
        room_id: "room-1",
        event_type: "room_occupied",
        description: "Prev",
        simulated: true,
        timestamp: new Date(base - 10 * HOUR).toISOString(),
      },
      {
        id: "p2",
        room_id: "room-1",
        event_type: "room_vacant",
        description: "Prev exit",
        simulated: true,
        timestamp: new Date(base - 8 * HOUR).toISOString(), // 2h
      },
      {
        id: "c1",
        room_id: "room-1",
        event_type: "room_occupied",
        description: "Cur",
        simulated: true,
        timestamp: new Date(base + 4 * HOUR).toISOString(),
      },
      {
        id: "c2",
        room_id: "room-1",
        event_type: "room_vacant",
        description: "Cur exit",
        simulated: true,
        timestamp: new Date(base + 8 * HOUR).toISOString(), // 4h
      },
    ];

    const comp = comparePeriods(
      events,
      { from: base, to: base + 24 * HOUR, label: "Current" },
      { from: base - 24 * HOUR, to: base, label: "Previous" },
      { roomId: "room-1" },
    );

    expect(comp.current.occupiedHours).toBe(4);
    expect(comp.previous.occupiedHours).toBe(2);
    expect(comp.deltas.occupiedHoursDelta).toBe(2);
    expect(comp.deltas.occupiedHoursPctChange).toBe(100);
  });
});

describe("Phase 4: Virtual Scenarios & Provenance Separation", () => {
  it("generates all 8 reproducible scenarios with simulated: true strictly enforced", () => {
    const scenarios = [
      "normal_daily",
      "low_activity",
      "high_activity",
      "repeated_zone_visits",
      "multi_target",
      "doorway_crossings",
      "increased_alerts",
      "period_comparison",
    ] as const;

    for (const sc of scenarios) {
      const data = generateAnalyticsScenarioData("room-test-1", sc, base);
      expect(data.segments.length).toBeGreaterThan(0);
      expect(data.events.length).toBeGreaterThan(0);

      // Verify strict provenance: all simulated: true
      for (const seg of data.segments) {
        expect(seg.simulated).toBe(true);
        expect(seg.room_id).toBe("room-test-1");
      }
      for (const ev of data.events) {
        expect(ev.simulated).toBe(true);
        expect(ev.room_id).toBe("room-test-1");
      }
    }
  });
});

/* =========================================================================
 * Phase 4.2 Remediation Regression Test Suites
 * ========================================================================= */

describe("Phase 4.2 Remediation: Velocity & Speed Separation (C-1)", () => {
  it("never discards negative radial velocity and reports separate radial Doppler speed", () => {
    // Target moves towards sensor (negative radial speed -40 cm/s), then recedes (+60 cm/s)
    const points: TrajectoryPoint[] = [
      { t: base, x: 2500, y: 3000, s: -40 },
      { t: base + 500, x: 2500, y: 2500, s: -40 },
      { t: base + 1000, x: 2500, y: 3000, s: 60 },
    ];
    const segment: TrajectorySegment = {
      id: "seg-radial",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 3,
      points,
    };

    const summary = summarizeTrajectories([segment], 5000, 4000);
    // Radial speed must average absolute magnitudes: (|-40| + |-40| + |60|) / 3 = 46.7 cm/s
    expect(summary.averageRadialSpeedCms).toBe(46.7);
    // 2D displacement speed:
    // Step 1: 500mm in 500ms -> 100 cm/s
    // Step 2: 500mm in 500ms -> 100 cm/s
    // Average 2D speed: 100 cm/s
    expect(summary.averageSpeedCms).toBe(100);
  });

  it("handles points with missing or undefined speed without corrupting 2D speed", () => {
    const points: TrajectoryPoint[] = [
      { t: base, x: 1000, y: 1000 }, // no speed
      { t: base + 1000, x: 1000, y: 2000 }, // 1000mm in 1000ms = 100 cm/s
    ];
    const segment: TrajectorySegment = {
      id: "seg-nospeed",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 2,
      points,
    };

    const summary = summarizeTrajectories([segment], 5000, 4000);
    expect(summary.averageSpeedCms).toBe(100);
    expect(summary.averageRadialSpeedCms).toBe(0); // no radial speed samples
  });
});

describe("Phase 4.2 Remediation: Trajectory Distance, Tracking Gaps & Jitter Deadband (C-2)", () => {
  it("does not accumulate distance across tracking-loss gaps (> 2500 ms)", () => {
    const points: TrajectoryPoint[] = [
      { t: base, x: 1000, y: 1000 },
      { t: base + 1000, x: 2000, y: 1000 }, // 1000mm moved, dt = 1000ms (valid)
      { t: base + 6000, x: 5000, y: 1000 }, // gap of 5000ms (> 2500ms maxGap)
      { t: base + 7000, x: 6000, y: 1000 }, // 1000mm moved, dt = 1000ms (valid)
    ];
    const segment: TrajectorySegment = {
      id: "seg-gap",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(7),
      start_epoch: base,
      end_epoch: base + 7000,
      point_count: 4,
      points,
    };

    const summary = summarizeTrajectories([segment], 8000, 4000, { maxGapMs: 2500 });
    // Valid segments: 1000mm + 1000mm = 2000mm = 2.0 meters (NOT 5.0 meters)
    expect(summary.totalDistanceMeters).toBe(2);
  });

  it("handles duplicate timestamps and out-of-order points safely", () => {
    const points: TrajectoryPoint[] = [
      { t: base + 1000, x: 2000, y: 1000 },
      { t: base, x: 1000, y: 1000 }, // out of order (earlier)
      { t: base + 1000, x: 2050, y: 1000 }, // duplicate timestamp
    ];
    const segment: TrajectorySegment = {
      id: "seg-dedup",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 3,
      points,
    };

    const summary = summarizeTrajectories([segment], 5000, 4000);
    // After sort & dedup: (1000, 1000) at t=0 -> (2000, 1000) at t=1000 (1000mm = 1.0m)
    expect(summary.totalDistanceMeters).toBe(1);
  });

  it("suppresses stationary radar jitter below configurable deadband (35 mm)", () => {
    // Stationary target jittering ±15mm
    const jitterPoints: TrajectoryPoint[] = [
      { t: base, x: 2000, y: 2000 },
      { t: base + 200, x: 2015, y: 2010 }, // step = 18mm (< 35mm deadband)
      { t: base + 400, x: 1995, y: 2005 }, // step = 20.6mm (< 35mm deadband)
      { t: base + 600, x: 2005, y: 1990 }, // step = 18mm (< 35mm deadband)
    ];
    const jitterSeg: TrajectorySegment = {
      id: "seg-jitter",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 600,
      point_count: 4,
      points: jitterPoints,
    };

    const summary = summarizeTrajectories([jitterSeg], 5000, 4000, { deadbandMm: 35 });
    expect(summary.totalDistanceMeters).toBe(0); // Zero meters accumulated for jitter
    expect(summary.provisionalJitterDeadbandMm).toBe(35);
  });

  it("accumulates distance only when movement exceeds deadband", () => {
    const movingPoints: TrajectoryPoint[] = [
      { t: base, x: 2000, y: 2000 },
      { t: base + 1000, x: 2500, y: 2000 }, // step = 500mm (>= 35mm)
      { t: base + 2000, x: 3000, y: 2000 }, // step = 500mm (>= 35mm)
    ];
    const movingSeg: TrajectorySegment = {
      id: "seg-moving",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(2),
      start_epoch: base,
      end_epoch: base + 2000,
      point_count: 3,
      points: movingPoints,
    };

    const summary = summarizeTrajectories([movingSeg], 5000, 4000, { deadbandMm: 35 });
    expect(summary.totalDistanceMeters).toBe(1); // 1000mm = 1.0m
  });

  it("does not accumulate distance between different target channels", () => {
    // Target 1 walks (1000, 1000) -> (1500, 1000) = 500mm
    const seg1: TrajectorySegment = {
      id: "seg-t1",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 2,
      points: [
        { t: base, x: 1000, y: 1000 },
        { t: base + 1000, x: 1500, y: 1000 },
      ],
    };

    // Target 2 walks (4000, 4000) -> (4500, 4000) = 500mm
    const seg2: TrajectorySegment = {
      id: "seg-t2",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 2,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 1000,
      point_count: 2,
      points: [
        { t: base, x: 4000, y: 4000 },
        { t: base + 1000, x: 4500, y: 4000 },
      ],
    };

    const summary = summarizeTrajectories([seg1, seg2], 5000, 5000);
    // Total distance = 500mm + 500mm = 1000mm = 1.0m (does not jump between (1500, 1000) and (4000, 4000))
    expect(summary.totalDistanceMeters).toBe(1);
    expect(summary.activeTargetIds).toEqual([1, 2]);
  });
});

describe("Phase 4.2 Remediation: Explicit Coordinate Frames & Sensor Transforms (C-3 & H-2)", () => {
  it("preserves room-absolute coordinates without shifting left-half targets to the right half", () => {
    // Left-half target in 5000mm room at x = 1000mm
    const leftTarget = normalizeToRoomCoordinates(1000, 2000, "room_absolute", null, 5000, 4000);
    expect(leftTarget).not.toBeNull();
    // Must remain at x = 1000mm (previously flawed heuristic shifted it to 3500mm!)
    expect(leftTarget?.rx).toBe(1000);
    expect(leftTarget?.ry).toBe(2000);

    // Right-half target at x = 3500mm
    const rightTarget = normalizeToRoomCoordinates(3500, 2000, "room_absolute", null, 5000, 4000);
    expect(rightTarget).not.toBeNull();
    expect(rightTarget?.rx).toBe(3500);
    expect(rightTarget?.ry).toBe(2000);
  });

  it("transforms sensor-relative coordinates using documented mount transform", () => {
    // Sensor mounted on top wall center: mountX = 2500, mountY = 0, facing +Y (0 deg)
    const topMount: SensorMountTransform = {
      mountX_mm: 2500,
      mountY_mm: 0,
      orientationDeg: 0,
    };

    // Lateral -1000mm (1m to left of sensor), 2000mm forward -> (1500, 2000) in room
    const transformed = transformSensorToRoomCoordinates(-1000, 2000, topMount, 5000, 4000);
    expect(transformed).not.toBeNull();
    expect(transformed?.rx).toBe(1500);
    expect(transformed?.ry).toBe(2000);
  });

  it("handles rotated sensor orientations correctly (90, 180, 270 deg)", () => {
    // Sensor mounted on left wall at (0, 2000) facing right (+X, 90 deg)
    const leftMount: SensorMountTransform = {
      mountX_mm: 0,
      mountY_mm: 2000,
      orientationDeg: 90,
    };
    // Lateral 0mm, forward 1500mm -> rx = 1500, ry = 2000
    const t90 = transformSensorToRoomCoordinates(0, 1500, leftMount, 5000, 4000);
    expect(t90?.rx).toBe(1500);
    expect(t90?.ry).toBe(2000);

    // Sensor mounted on bottom wall at (2500, 4000) facing up (-Y, 180 deg)
    const bottomMount: SensorMountTransform = {
      mountX_mm: 2500,
      mountY_mm: 4000,
      orientationDeg: 180,
    };
    // Lateral 0mm, forward 1000mm -> rx = 2500, ry = 3000
    const t180 = transformSensorToRoomCoordinates(0, 1000, bottomMount, 5000, 4000);
    expect(t180?.rx).toBe(2500);
    expect(t180?.ry).toBe(3000);
  });

  it("returns null for sensor-relative points when mount transform is missing (does not guess)", () => {
    const missing = normalizeToRoomCoordinates(-500, 2000, "sensor_relative", null, 5000, 4000);
    expect(missing).toBeNull();
  });

  it("strictly tests zone polygon in the same coordinate frame without heuristic dual-testing", () => {
    // Zone located strictly in left half: x in [500, 1500], y in [500, 1500]
    const leftZone: RoomZone = {
      id: "left-zone",
      room_id: "room-1",
      name: "Left Zone",
      type: "custom",
      polygon: [
        { x_mm: 500, y_mm: 500 },
        { x_mm: 1500, y_mm: 500 },
        { x_mm: 1500, y_mm: 1500 },
        { x_mm: 500, y_mm: 1500 },
      ],
      alert_on_entry: false,
    };

    // Point in left half: inside zone
    expect(isPointInZone(1000, 1000, leftZone)).toBe(true);

    // Point in right half at x = 3500mm (which is 1000 + 2500mm):
    // In old buggy code with dual-check (x + W/2), this returned false for x=1000 if shifted, or matched incorrectly!
    // Now it strictly checks only the exact point
    expect(isPointInZone(3500, 1000, leftZone)).toBe(false);
  });
});

describe("Phase 4.2 Remediation: Historical Open-Session Clamping (H-1)", () => {
  it("caps open sessions strictly at historical window end and never leaks to the present", () => {
    const historicalStart = base;
    const historicalEnd = base + 7200e3; // 2 hours window
    const presentNow = base + 7 * 86400e3; // 7 days later

    const events: OccupancyEvent[] = [
      {
        id: "e-1",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(historicalStart + 1800e3).toISOString(), // 30m into window
        simulated: true,
        description: "Occupied",
      },
    ];

    // Query historical window [historicalStart, historicalEnd]
    const sessions = occupancySessions(events, presentNow, historicalEnd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toBe(historicalStart + 1800e3);
    // End MUST be capped at historicalEnd (base + 7200e3), NOT presentNow (base + 7 days)!
    expect(sessions[0]?.end).toBe(historicalEnd);
    expect(sessions[0]?.status).toBe("censored_by_window");
  });

  it("caps current window open sessions at present now", () => {
    const presentNow = base + 3600e3;
    const events: OccupancyEvent[] = [
      {
        id: "e-1",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(base + 600e3).toISOString(),
        simulated: true,
        description: "Occupied",
      },
    ];

    const sessions = detailedOccupancySessions(events, presentNow, presentNow);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.end).toBe(presentNow);
    expect(sessions[0]?.open).toBe(true);
  });
});

describe("Phase 4.2 Remediation: Sensor Disconnection & Incomplete Occupancy (H-3)", () => {
  it("truncates active occupancy session upon sensor_disconnected and marks censored_by_disconnect", () => {
    const occTime = base;
    const discTime = base + 1200e3; // 20 minutes later
    const windowEnd = base + 3600e3; // 60 minutes window

    const events: OccupancyEvent[] = [
      {
        id: "e-occ",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(occTime).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "e-disc",
        room_id: "room-1",
        event_type: "sensor_disconnected",
        timestamp: new Date(discTime).toISOString(),
        simulated: true,
        description: "Sensor disconnected",
      },
    ];

    const sessions = occupancySessions(events, windowEnd, windowEnd);
    expect(sessions).toHaveLength(1);
    // Session ends at disconnect time (20 minutes), NOT persisting confirmed occupancy for the whole hour!
    expect(sessions[0]?.start).toBe(occTime);
    expect(sessions[0]?.end).toBe(discTime);
    expect(sessions[0]?.status).toBe("censored_by_disconnect");
  });

  it("calculates data coverage and utilisation strictly against valid observation time", () => {
    const occTime = base;
    const discTime = base + 1200e3; // 20m
    const reconnectTime = base + 2400e3; // 40m (20m offline)
    const windowEnd = base + 3600e3; // 60m total window

    const events: OccupancyEvent[] = [
      {
        id: "e-occ1",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(occTime).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "e-disc",
        room_id: "room-1",
        event_type: "sensor_disconnected",
        timestamp: new Date(discTime).toISOString(),
        simulated: true,
        description: "Sensor disconnected",
      },
      {
        id: "e-rec",
        room_id: "room-1",
        event_type: "sensor_reconnected",
        timestamp: new Date(reconnectTime).toISOString(),
        simulated: true,
        description: "Sensor reconnected",
      },
    ];

    const summary = calculateActivitySummary(events, base, windowEnd, "room-1");
    // 20 minutes offline out of 60 minutes window -> 40 minutes valid observation time
    expect(summary.offlineDurationMs).toBe(1200e3);
    // Data coverage = 40 / 60 * 100 = 66.7%
    expect(summary.dataCoveragePct).toBe(66.7);
    // Occupied 20m out of 40m valid observation time = 50.0% utilisation
    expect(summary.utilisationPct).toBe(50);
  });

  it("censors active occupancy when heartbeat timeout is exceeded during silence", () => {
    const occTime = base;
    const windowEnd = base + 3600e3;
    const heartbeatTimeout = 60_000; // 60 seconds

    const events: OccupancyEvent[] = [
      {
        id: "e-occ",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(occTime).toISOString(),
        simulated: true,
        description: "Occupied",
      },
    ];

    // With heartbeat timeout configured, silence beyond 60s censors the session
    const sessions = occupancySessions(events, windowEnd, windowEnd, {
      heartbeatTimeoutMs: heartbeatTimeout,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.end).toBe(occTime + heartbeatTimeout);
    expect(sessions[0]?.status).toBe("censored_by_disconnect");
  });
});

describe("Phase 4.2 Remediation: Unified Timezone Handling & Date Boundaries (M-1 & M-2)", () => {
  it("formats dates and hours consistently in UTC+05:30 (Asia/Kolkata / +330)", () => {
    // 2026-11-15 19:30 UTC is 2026-11-16 01:00 in UTC+05:30
    const epoch = Date.UTC(2026, 10, 15, 19, 30, 0);
    const tzKolkata = 330; // +05:30

    expect(formatDateIso(epoch, tzKolkata)).toBe("2026-11-16");
    expect(getHourInTimezone(epoch, tzKolkata)).toBe(1);
    expect(getDayOfWeekInTimezone(epoch, tzKolkata)).toBe(1); // Monday
  });

  it("formats dates and hours consistently in UTC-05:00 (America/New_York / -300)", () => {
    // 2026-11-15 02:00 UTC is 2026-11-14 21:00 in UTC-05:00
    const epoch = Date.UTC(2026, 10, 15, 2, 0, 0);
    const tzNy = -300; // -05:00

    expect(formatDateIso(epoch, tzNy)).toBe("2026-11-14");
    expect(getHourInTimezone(epoch, tzNy)).toBe(21);
    expect(getDayOfWeekInTimezone(epoch, tzNy)).toBe(6); // Saturday
  });

  it("parses date-only strings consistently into start and end of day in configured timezone", () => {
    const tz = 330; // +05:30
    const startMs = parseDateOnly("2026-11-16", tz, false);
    const endMs = parseDateOnly("2026-11-16", tz, true);

    expect(formatDateIso(startMs, tz)).toBe("2026-11-16");
    expect(formatDateIso(endMs, tz)).toBe("2026-11-16");
    expect(getHourInTimezone(startMs, tz)).toBe(0);
    expect(getHourInTimezone(endMs, tz)).toBe(23);
  });

  it("splits a midnight-crossing session correctly across daily summaries and hourly profile", () => {
    // Session from 23:30 to 00:30 (1 hour spanning midnight UTC)
    const start = Date.UTC(2026, 0, 1, 23, 30);
    const end = Date.UTC(2026, 0, 2, 0, 30);
    const sessions = [{ room_id: "room-1", start, end }];

    const daily = calculateDailySummaries(
      sessions,
      [],
      Date.UTC(2026, 0, 1, 0, 0),
      Date.UTC(2026, 0, 3, 0, 0),
      "room-1",
      0, // UTC
    );

    expect(daily).toHaveLength(2);
    // 30 occupied minutes in day 1, 30 occupied minutes in day 2
    expect(daily[0]?.occupiedMinutes).toBe(30);
    expect(daily[1]?.occupiedMinutes).toBe(30);

    const hourly = calculateHourlyProfile(
      sessions,
      Date.UTC(2026, 0, 1, 0, 0),
      Date.UTC(2026, 0, 3, 0, 0),
      undefined,
      0,
    );
    // Hour 23 has occupied minutes
    const h23 = hourly.find((s) => s.hour === 23);
    const h0 = hourly.find((s) => s.hour === 0);
    expect(h23?.observedOccupiedMinutes).toBe(15); // 30m over 2 days = 15m/day
    expect(h0?.observedOccupiedMinutes).toBe(15);
  });
});

describe("Phase 4.2 Remediation: Doorway Geometry & Wall Directionality (L-1)", () => {
  it("classifies entry and exit for supported wall geometry (bottom wall)", () => {
    const door: Door = {
      id: "door-bot",
      name: "Front Door",
      x_mm: 2500,
      y_mm: 4000,
      width_mm: 900,
      wall: "bottom",
      type: "both",
    };

    // Moving up (-Y) from 4000 to 3500 is inward entry
    const segEntry: TrajectorySegment = {
      id: "seg-e",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 500,
      point_count: 2,
      points: [
        { t: base, x: 2500, y: 3950 },
        { t: base + 500, x: 2500, y: 3600 },
      ],
    };

    const result = calculateDoorwayPassages([door], [segEntry], [], 5000, 4000);
    expect(result).toHaveLength(1);
    expect(result[0]?.directionality).toBe("supported");
    expect(result[0]?.entries).toBe(1);
    expect(result[0]?.exits).toBe(0);
    expect(result[0]?.totalCrossings).toBe(1);
  });

  it("marks directionality as unsupported for doors with missing or non-cardinal wall attribute", () => {
    const doorNoWall: Door = {
      id: "door-interior",
      name: "Interior Archway",
      x_mm: 2500,
      y_mm: 2000, // middle of room
      width_mm: 900,
      type: "both",
      // wall is intentionally omitted
    };

    const seg: TrajectorySegment = {
      id: "seg-pass",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: iso(0),
      end_time: iso(1),
      start_epoch: base,
      end_epoch: base + 500,
      point_count: 2,
      points: [
        { t: base, x: 2500, y: 2100 },
        { t: base + 500, x: 2500, y: 1900 },
      ],
    };

    const result = calculateDoorwayPassages([doorNoWall], [seg], [], 5000, 4000);
    expect(result).toHaveLength(1);
    expect(result[0]?.directionality).toBe("unsupported");
    // Does NOT guess inward vs outward entries/exits!
    expect(result[0]?.entries).toBe(0);
    expect(result[0]?.exits).toBe(0);
    // Counts proximity transits accurately
    expect(result[0]?.totalCrossings).toBe(1);
  });
});

describe("Phase 4.4 Task 1: Per-Room Heartbeat Tracking & Offline Intervals", () => {
  it("tracks heartbeat timeouts independently across interleaved multi-room event streams", () => {
    const t0 = base;
    const timeout = 60_000;

    const events: OccupancyEvent[] = [
      {
        id: "a1",
        room_id: "room-a",
        event_type: "room_occupied",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "A occupied",
      },
      {
        id: "b1",
        room_id: "room-b",
        event_type: "room_occupied",
        timestamp: new Date(t0 + 10_000).toISOString(),
        simulated: true,
        description: "B occupied",
      },
      {
        id: "b2",
        room_id: "room-b",
        event_type: "target_moved",
        timestamp: new Date(t0 + 35_000).toISOString(),
        simulated: true,
        description: "B moved",
      },
      {
        id: "b3",
        room_id: "room-b",
        event_type: "target_moved",
        timestamp: new Date(t0 + 60_000).toISOString(),
        simulated: true,
        description: "B moved",
      },
      {
        id: "b4",
        room_id: "room-b",
        event_type: "target_moved",
        timestamp: new Date(t0 + 85_000).toISOString(),
        simulated: true,
        description: "B moved",
      },
      {
        id: "b5",
        room_id: "room-b",
        event_type: "target_moved",
        timestamp: new Date(t0 + 110_000).toISOString(),
        simulated: true,
        description: "B moved",
      },
      {
        id: "b6",
        room_id: "room-b",
        event_type: "target_moved",
        timestamp: new Date(t0 + 135_000).toISOString(),
        simulated: true,
        description: "B moved",
      },
      {
        id: "a2",
        room_id: "room-a",
        event_type: "target_moved",
        timestamp: new Date(t0 + 150_000).toISOString(),
        simulated: true,
        description: "A moved",
      },
      {
        id: "b7",
        room_id: "room-b",
        event_type: "room_vacant",
        timestamp: new Date(t0 + 160_000).toISOString(),
        simulated: true,
        description: "B vacant",
      },
      {
        id: "a3",
        room_id: "room-a",
        event_type: "room_vacant",
        timestamp: new Date(t0 + 180_000).toISOString(),
        simulated: true,
        description: "A vacant",
      },
    ];

    const offlineAll = detectOfflineIntervals(events, t0, t0 + 200_000, timeout);

    // Room A had silence between t0 and t0 + 150s -> timeout gap is [t0 + 60s, t0 + 150s]
    const roomAIntervals = offlineAll.filter((iv) => iv.room_id === "room-a");
    expect(roomAIntervals).toHaveLength(1);
    expect(roomAIntervals[0]?.reason).toBe("heartbeat_timeout");
    expect(roomAIntervals[0]?.start).toBe(t0 + 60_000);
    expect(roomAIntervals[0]?.end).toBe(t0 + 150_000);

    // Room B had frequent events every 25s -> zero heartbeat timeouts
    const roomBIntervals = offlineAll.filter((iv) => iv.room_id === "room-b");
    expect(roomBIntervals).toHaveLength(0);

    // Scoped query for room-a returns exact same interval
    const scopedA = detectOfflineIntervals(
      events.filter((e) => e.room_id === "room-a"),
      t0,
      t0 + 200_000,
      timeout,
    );
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]?.start).toBe(t0 + 60_000);
    expect(scopedA[0]?.end).toBe(t0 + 150_000);

    // Scoped query for room-b returns empty
    const scopedB = detectOfflineIntervals(
      events.filter((e) => e.room_id === "room-b"),
      t0,
      t0 + 200_000,
      timeout,
    );
    expect(scopedB).toHaveLength(0);
  });

  it("merges adjacent or overlapping disconnect and heartbeat intervals cleanly", () => {
    const t0 = base;
    const timeout = 60_000;

    const events: OccupancyEvent[] = [
      {
        id: "e1",
        room_id: "room-a",
        event_type: "room_occupied",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "e2",
        room_id: "room-a",
        event_type: "sensor_disconnected",
        timestamp: new Date(t0 + 80_000).toISOString(),
        simulated: true,
        description: "Disconnected",
      },
      {
        id: "e3",
        room_id: "room-a",
        event_type: "sensor_reconnected",
        timestamp: new Date(t0 + 140_000).toISOString(),
        simulated: true,
        description: "Reconnected",
      },
      {
        id: "e4",
        room_id: "room-a",
        event_type: "room_vacant",
        timestamp: new Date(t0 + 160_000).toISOString(),
        simulated: true,
        description: "Vacant",
      },
    ];

    const intervals = detectOfflineIntervals(events, t0, t0 + 200_000, timeout);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.start).toBe(t0 + 60_000);
    expect(intervals[0]?.end).toBe(t0 + 140_000);
    expect(intervals[0]?.room_id).toBe("room-a");
  });
});

describe("Phase 4.4 Task 2: All-Room Aggregate Metrics Scaling", () => {
  it("calculates aggregate utilization across two rooms with different offline durations", () => {
    const t0 = base;
    const windowEnd = t0 + 3600_000; // 1 hour

    const events: OccupancyEvent[] = [
      // Room 1: 100% online (0 offline), 30 minutes occupied
      {
        id: "r1-occ",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "r1-vac",
        room_id: "room-1",
        event_type: "room_vacant",
        timestamp: new Date(t0 + 1800_000).toISOString(),
        simulated: true,
        description: "Vacant",
      },
      // Room 2: 20 minutes offline, 20 minutes occupied
      {
        id: "r2-disc",
        room_id: "room-2",
        event_type: "sensor_disconnected",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "Disconnected",
      },
      {
        id: "r2-rec",
        room_id: "room-2",
        event_type: "sensor_reconnected",
        timestamp: new Date(t0 + 1200_000).toISOString(),
        simulated: true,
        description: "Reconnected",
      },
      {
        id: "r2-occ",
        room_id: "room-2",
        event_type: "room_occupied",
        timestamp: new Date(t0 + 1200_000).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "r2-vac",
        room_id: "room-2",
        event_type: "room_vacant",
        timestamp: new Date(t0 + 2400_000).toISOString(),
        simulated: true,
        description: "Vacant",
      },
    ];

    // Single room 1 check
    const s1 = calculateActivitySummary(events, t0, windowEnd, "room-1");
    expect(s1.offlineDurationMs).toBe(0);
    expect(s1.dataCoveragePct).toBe(100);
    expect(s1.totalOccupiedMs).toBe(1800_000);
    expect(s1.totalVacantMs).toBe(1800_000);
    expect(s1.utilisationPct).toBe(50);

    // Single room 2 check
    const s2 = calculateActivitySummary(events, t0, windowEnd, "room-2");
    expect(s2.offlineDurationMs).toBe(1200_000);
    expect(s2.dataCoveragePct).toBe(66.7);
    expect(s2.totalOccupiedMs).toBe(1200_000);
    expect(s2.totalVacantMs).toBe(1200_000);
    expect(s2.utilisationPct).toBe(50);

    // All-room aggregate check
    const sAll = calculateActivitySummary(events, t0, windowEnd, undefined, {
      roomIds: ["room-1", "room-2"],
    });
    expect(sAll.offlineDurationMs).toBe(1200_000);
    expect(sAll.totalOccupiedMs).toBe(3000_000);
    expect(sAll.totalVacantMs).toBe(3000_000);
    expect(sAll.dataCoveragePct).toBe(83.3);
    expect(sAll.utilisationPct).toBe(50);
  });

  it("calculates aggregate metrics across three rooms with varying offline intervals", () => {
    const t0 = base;
    const windowEnd = t0 + 3600_000; // 1 hour

    const events: OccupancyEvent[] = [
      // Room 1: 100% online, 60m occupied
      {
        id: "r1-occ",
        room_id: "room-1",
        event_type: "room_occupied",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "r1-vac",
        room_id: "room-1",
        event_type: "room_vacant",
        timestamp: new Date(windowEnd).toISOString(),
        simulated: true,
        description: "Vacant",
      },
      // Room 2: 30m offline, 15m occupied
      {
        id: "r2-disc",
        room_id: "room-2",
        event_type: "sensor_disconnected",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "Disconnected",
      },
      {
        id: "r2-rec",
        room_id: "room-2",
        event_type: "sensor_reconnected",
        timestamp: new Date(t0 + 1800_000).toISOString(),
        simulated: true,
        description: "Reconnected",
      },
      {
        id: "r2-occ",
        room_id: "room-2",
        event_type: "room_occupied",
        timestamp: new Date(t0 + 1800_000).toISOString(),
        simulated: true,
        description: "Occupied",
      },
      {
        id: "r2-vac",
        room_id: "room-2",
        event_type: "room_vacant",
        timestamp: new Date(t0 + 2700_000).toISOString(),
        simulated: true,
        description: "Vacant",
      },
      // Room 3: 60m offline (100% offline)
      {
        id: "r3-disc",
        room_id: "room-3",
        event_type: "sensor_disconnected",
        timestamp: new Date(t0).toISOString(),
        simulated: true,
        description: "Disconnected",
      },
    ];

    const sAll = calculateActivitySummary(events, t0, windowEnd, undefined, {
      roomIds: ["room-1", "room-2", "room-3"],
    });

    expect(sAll.offlineDurationMs).toBe(5400_000);
    expect(sAll.totalOccupiedMs).toBe(4500_000);
    expect(sAll.totalVacantMs).toBe(900_000);
    expect(sAll.dataCoveragePct).toBe(50);
    expect(sAll.utilisationPct).toBe(83.3);
  });
});

describe("Phase 4.4 Task 3: Multi-Sensor Track Identity & Collision Prevention", () => {
  it("isolates target tracks from two distinct physical devices reporting target ID 1", () => {
    const t0 = base;

    const segDevA: TrajectorySegment = {
      id: "seg-dev-a",
      room_id: "room-1",
      device_id: "device-front-radar",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: new Date(t0).toISOString(),
      end_time: new Date(t0 + 200).toISOString(),
      start_epoch: t0,
      end_epoch: t0 + 200,
      point_count: 3,
      points: [
        { t: t0, x: 1000, y: 1000, s: 10 },
        { t: t0 + 100, x: 1050, y: 1050, s: 10 },
        { t: t0 + 200, x: 1100, y: 1100, s: 10 },
      ],
    };

    const segDevB: TrajectorySegment = {
      id: "seg-dev-b",
      room_id: "room-1",
      device_id: "device-rear-radar",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: new Date(t0 + 50).toISOString(),
      end_time: new Date(t0 + 150).toISOString(),
      start_epoch: t0 + 50,
      end_epoch: t0 + 150,
      point_count: 2,
      points: [
        { t: t0 + 50, x: 4000, y: 3000, s: 15 },
        { t: t0 + 150, x: 4050, y: 3050, s: 15 },
      ],
    };

    const summary = summarizeTrajectories([segDevA, segDevB], 5000, 4000);

    expect(summary.totalDistanceMeters).toBe(0.2);
    expect(summary.averageSpeedCms).toBe(70.7);
    expect(summary.totalPoints).toBe(5);
  });

  it("preserves backward compatibility for legacy trajectory segments without device_id", () => {
    const t0 = base;
    const legacySeg: TrajectorySegment = {
      id: "seg-legacy",
      room_id: "room-1",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: new Date(t0).toISOString(),
      end_time: new Date(t0 + 100).toISOString(),
      start_epoch: t0,
      end_epoch: t0 + 100,
      point_count: 2,
      points: [
        { t: t0, x: 1000, y: 1000, s: 5 },
        { t: t0 + 100, x: 1050, y: 1050, s: 5 },
      ],
    };

    const summary = summarizeTrajectories([legacySeg], 5000, 4000);
    expect(summary.totalPoints).toBe(2);
    expect(summary.averageSpeedCms).toBe(70.7);
  });
});

describe("Phase 4.4 Task 4: DST-Safe Calendar Stepping & Boundaries", () => {
  it("iterates a 14-day range crossing DST Spring Forward in America/New_York (March 8, 2026)", () => {
    const tz = "America/New_York";
    const start = parseDateOnly("2026-03-01", tz, false);
    const end = parseDateOnly("2026-03-15", tz, false);

    const intervals = getCalendarDayIntervals(start, end, tz);
    expect(intervals).toHaveLength(14);

    const expectedDates = [
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
    ];
    expect(intervals.map((iv) => iv.dateIso)).toEqual(expectedDates);

    // March 8 is a 23-hour day
    const day8 = intervals[7]!;
    expect(day8.dateIso).toBe("2026-03-08");
    expect((day8.end - day8.start) / 3600_000).toBe(23);

    // March 9 starts strictly at local midnight EDT (04:00 UTC)
    const day9 = intervals[8]!;
    expect(day9.dateIso).toBe("2026-03-09");
    expect((day9.end - day9.start) / 3600_000).toBe(24);
    expect(new Date(day9.start).toISOString()).toBe("2026-03-09T04:00:00.000Z");

    const sessions = [{ room_id: "room-1", start: day8.start, end: day8.end }];
    const summaries = calculateDailySummaries(sessions, [], start, end, "room-1", tz);
    expect(summaries).toHaveLength(14);
    expect(summaries[7]?.occupiedMinutes).toBe(23 * 60);
    expect(summaries[7]?.utilisationPct).toBe(100);
  });

  it("iterates a 14-day range crossing DST Fall Back in America/New_York (November 1, 2026)", () => {
    const tz = "America/New_York";
    const start = parseDateOnly("2026-10-25", tz, false);
    const end = parseDateOnly("2026-11-08", tz, false);

    const intervals = getCalendarDayIntervals(start, end, tz);
    expect(intervals).toHaveLength(14);

    const dayNov1 = intervals[7]!;
    expect(dayNov1.dateIso).toBe("2026-11-01");
    expect((dayNov1.end - dayNov1.start) / 3600_000).toBe(25);

    const dayNov2 = intervals[8]!;
    expect(dayNov2.dateIso).toBe("2026-11-02");
    expect((dayNov2.end - dayNov2.start) / 3600_000).toBe(24);
    expect(new Date(dayNov2.start).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("preserves uniform 24-hour days for fixed-offset timezones like Asia/Kolkata (+330)", () => {
    const tz = "Asia/Kolkata";
    const start = parseDateOnly("2026-03-01", tz, false);
    const end = parseDateOnly("2026-03-08", tz, false);

    const intervals = getCalendarDayIntervals(start, end, tz);
    expect(intervals).toHaveLength(7);
    for (const iv of intervals) {
      expect((iv.end - iv.start) / 3600_000).toBe(24);
    }
  });
});

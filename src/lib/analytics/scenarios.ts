import type { OccupancyEvent } from "@/lib/firebase/db";
import type {
  AlertSeverity,
  EventType,
  RoomZone,
  Door,
  TrajectoryPoint,
  TrajectorySegment,
} from "@/lib/radar/types";

export type AnalyticsScenario =
  | "normal_daily"
  | "low_activity"
  | "high_activity"
  | "repeated_zone_visits"
  | "multi_target"
  | "doorway_crossings"
  | "increased_alerts"
  | "period_comparison";

export interface ScenarioResult {
  scenario: AnalyticsScenario;
  title: string;
  description: string;
  segments: TrajectorySegment[];
  events: OccupancyEvent[];
}

export const SCENARIO_DESCRIPTIONS: Record<
  AnalyticsScenario,
  { title: string; description: string }
> = {
  normal_daily: {
    title: "Normal Daily Activity",
    description:
      "Standard daily pattern with active morning and evening sessions, and midday quiet hours.",
  },
  low_activity: {
    title: "Low Room Activity",
    description: "Infrequent, short visits with low overall room utilisation.",
  },
  high_activity: {
    title: "High Room Activity",
    description:
      "Frequent occupancy, high movement density, and extended dwell sessions throughout the day.",
  },
  repeated_zone_visits: {
    title: "Repeated Zone Visits",
    description: "Concentrated dwell sessions in configured room zones (couch, desk, hazard area).",
  },
  multi_target: {
    title: "Multiple Target Movement",
    description: "Simultaneous tracking of multiple anonymous radar targets traversing the room.",
  },
  doorway_crossings: {
    title: "Repeated Doorway Crossings",
    description:
      "High traffic through configured doorways with clear ingress and egress transitions.",
  },
  increased_alerts: {
    title: "Increased Alert Activity",
    description: "Frequent hazard zone entries, prolonged presence, and unusual movement alerts.",
  },
  period_comparison: {
    title: "Two-Week Historical Baseline Comparison",
    description:
      "Multi-week dataset contrasting a low-activity baseline week with a high-activity current week.",
  },
};

/**
 * Helper to generate synthetic trajectory points along a path.
 */
function createPathPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  startTimeMs: number,
  durationSec: number,
  stepSec = 0.5,
): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  const steps = Math.max(1, Math.floor(durationSec / stepSec));
  const dx = (endX - startX) / steps;
  const dy = (endY - startY) / steps;

  for (let i = 0; i <= steps; i++) {
    const t = startTimeMs + Math.round(i * stepSec * 1000);
    const x = Math.round(startX + dx * i + Math.sin(i * 0.3) * 20);
    const y = Math.round(startY + dy * i + Math.cos(i * 0.3) * 20);
    const s = Math.round(Math.hypot(dx, dy) / stepSec / 10); // cm/s
    points.push({ t, x, y, s });
  }
  return points;
}

/**
 * Split a continuous trajectory point array into standard Firestore-safe segments.
 */
function toSegments(
  points: TrajectoryPoint[],
  roomId: string,
  targetId: number,
  chunkSize = 60,
): TrajectorySegment[] {
  const segments: TrajectorySegment[] = [];
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const startP = chunk[0]!;
    const endP = chunk[chunk.length - 1]!;
    segments.push({
      id: `sim_seg_${roomId}_${targetId}_${startP.t}`,
      room_id: roomId,
      sensor_type: "ld2450",
      target_id: targetId,
      simulated: true,
      start_time: new Date(startP.t).toISOString(),
      end_time: new Date(endP.t).toISOString(),
      start_epoch: startP.t,
      end_epoch: endP.t,
      point_count: chunk.length,
      dwell_seconds: Math.round((endP.t - startP.t) / 1000),
      points: chunk,
    });
  }
  return segments;
}

/**
 * Generates synthetic occupancy event records.
 */
function createEvent(
  roomId: string,
  eventType: EventType,
  timestampMs: number,
  options?: {
    severity?: AlertSeverity;
    targetId?: number;
    zoneName?: string;
    zoneId?: string;
    doorName?: string;
    doorId?: string;
    description?: string;
    acknowledged?: boolean;
    acknowledgedAtMs?: number;
  },
): OccupancyEvent {
  const dateIso = new Date(timestampMs).toISOString();
  return {
    id: `sim_ev_${roomId}_${eventType}_${timestampMs}_${Math.random().toString(36).slice(2, 6)}`,
    room_id: roomId,
    event_type: eventType,
    description: options?.description ?? `Simulated ${eventType.replace(/_/g, " ")}`,
    target_id: options?.targetId ?? 1,
    sensor_type: "ld2450",
    simulated: true,
    timestamp: dateIso,
    severity: options?.severity,
    zone_name: options?.zoneName,
    zone_id: options?.zoneId,
    evidence:
      options?.doorId || options?.doorName
        ? {
            rule_id: "doorway_crossing",
            summary: `Doorway transit detected at ${options.doorName ?? "Door"}`,
            door_id: options.doorId,
            door_name: options.doorName,
            confidence: "high",
          }
        : undefined,
    acknowledged: options?.acknowledged ?? false,
    acknowledged_at: options?.acknowledgedAtMs
      ? new Date(options.acknowledgedAtMs).toISOString()
      : null,
    acknowledged_by: options?.acknowledged ? "usr_admin_default" : null,
  };
}

/**
 * Generate comprehensive reproducible simulated scenarios for Phase 4 analytics demonstrations.
 */
export function generateAnalyticsScenarioData(
  roomId: string,
  scenario: AnalyticsScenario,
  baseTimestamp: number = Date.now(),
): ScenarioResult {
  const meta = SCENARIO_DESCRIPTIONS[scenario];
  const segments: TrajectorySegment[] = [];
  const events: OccupancyEvent[] = [];

  const HOUR = 3600_000;
  const DAY = 86400_000;

  if (scenario === "normal_daily") {
    // 7 days of normal daily routines
    for (let d = 6; d >= 0; d--) {
      const dayBase = baseTimestamp - d * DAY;
      // Morning session: 07:30 - 08:45 (75m)
      const mStart = dayBase - 16 * HOUR;
      const mEnd = mStart + 75 * 60000;
      events.push(createEvent(roomId, "room_occupied", mStart));
      events.push(createEvent(roomId, "target_detected", mStart + 1000));
      events.push(createEvent(roomId, "target_moved", mStart + 20000));
      events.push(createEvent(roomId, "room_vacant", mEnd));

      const mPts = createPathPoints(4500, 3800, 2000, 2000, mStart, 60);
      segments.push(...toSegments(mPts, roomId, 1));

      // Evening session: 18:30 - 21:30 (3h)
      const eStart = dayBase - 4 * HOUR;
      const eEnd = eStart + 180 * 60000;
      events.push(createEvent(roomId, "room_occupied", eStart));
      events.push(createEvent(roomId, "target_detected", eStart + 1000));
      events.push(createEvent(roomId, "target_moved", eStart + 30000));
      events.push(createEvent(roomId, "room_vacant", eEnd));

      const ePts = createPathPoints(2000, 2000, 2500, 2400, eStart, 90);
      segments.push(...toSegments(ePts, roomId, 1));
    }
  } else if (scenario === "low_activity") {
    // 3 days of minimal visits (2-3 short visits)
    for (let d = 2; d >= 0; d--) {
      const dayBase = baseTimestamp - d * DAY;
      const t1 = dayBase - 10 * HOUR;
      events.push(createEvent(roomId, "room_occupied", t1));
      events.push(createEvent(roomId, "target_detected", t1 + 500));
      events.push(createEvent(roomId, "room_vacant", t1 + 3 * 60000));

      const pts = createPathPoints(4700, 3800, 3500, 3000, t1, 40);
      segments.push(...toSegments(pts, roomId, 1));
    }
  } else if (scenario === "high_activity") {
    // Multiple frequent, long sessions across 5 days
    for (let d = 4; d >= 0; d--) {
      const dayBase = baseTimestamp - d * DAY;
      for (let h = 8; h <= 20; h += 3) {
        const sTime = dayBase - (24 - h) * HOUR;
        const eTime = sTime + 120 * 60000;
        events.push(createEvent(roomId, "room_occupied", sTime));
        events.push(createEvent(roomId, "target_detected", sTime + 1000, { targetId: 1 }));
        events.push(createEvent(roomId, "target_moved", sTime + 15000, { targetId: 1 }));
        events.push(createEvent(roomId, "room_vacant", eTime));

        const pts = createPathPoints(1000 + (h % 3) * 1000, 1000, 3500, 3200, sTime, 80);
        segments.push(...toSegments(pts, roomId, 1));
      }
    }
  } else if (scenario === "repeated_zone_visits") {
    // Frequent visits targeted inside zones (couch, desk)
    const base = baseTimestamp - 24 * HOUR;
    for (let i = 0; i < 6; i++) {
      const s = base + i * 3 * HOUR;
      const e = s + 45 * 60000;
      events.push(createEvent(roomId, "room_occupied", s));
      events.push(createEvent(roomId, "target_detected", s + 1000));
      events.push(createEvent(roomId, "room_vacant", e));

      // Dwell points directly inside Couch zone (1200-3200, 1800-2700)
      const pts = createPathPoints(2000, 2200, 2600, 2300, s, 60);
      segments.push(...toSegments(pts, roomId, 1));
    }
  } else if (scenario === "multi_target") {
    // Simultaneous targets (target 1 and target 2)
    const base = baseTimestamp - 2 * HOUR;
    events.push(createEvent(roomId, "room_occupied", base));
    events.push(createEvent(roomId, "target_detected", base + 500, { targetId: 1 }));
    events.push(createEvent(roomId, "target_detected", base + 1500, { targetId: 2 }));
    events.push(createEvent(roomId, "target_moved", base + 10000, { targetId: 1 }));
    events.push(createEvent(roomId, "target_moved", base + 12000, { targetId: 2 }));
    events.push(createEvent(roomId, "room_vacant", base + 60 * 60000));

    const pts1 = createPathPoints(1500, 1500, 3500, 3000, base, 70);
    const pts2 = createPathPoints(4000, 3000, 1200, 2000, base, 70);
    segments.push(...toSegments(pts1, roomId, 1));
    segments.push(...toSegments(pts2, roomId, 2));
  } else if (scenario === "doorway_crossings") {
    // High volume of doorway crossings
    const base = baseTimestamp - 12 * HOUR;
    for (let i = 0; i < 8; i++) {
      const t = base + i * 80 * 60000;
      events.push(createEvent(roomId, "room_occupied", t));
      events.push(
        createEvent(roomId, "unexpected_entry", t + 500, {
          severity: "medium",
          doorName: "Main Entry",
          doorId: "door-lr-1",
        }),
      );
      events.push(createEvent(roomId, "room_vacant", t + 20 * 60000));

      // Path moving from door inward
      const pts = createPathPoints(4700, 3800, 2500, 2000, t, 30);
      segments.push(...toSegments(pts, roomId, 1));
    }
  } else if (scenario === "increased_alerts") {
    // Hazard alerts, falls, prolonged stays
    const base = baseTimestamp - 18 * HOUR;
    for (let i = 0; i < 5; i++) {
      const t = base + i * 3 * HOUR;
      events.push(
        createEvent(roomId, "hazard_zone_entry", t, {
          severity: "high",
          zoneName: "Balcony Hazard",
          zoneId: "zone-lr-balcony",
          acknowledged: i % 2 === 0,
          acknowledgedAtMs: t + 120_000,
        }),
      );
      events.push(
        createEvent(roomId, "prolonged_presence", t + 20 * 60000, {
          severity: "medium",
          zoneName: "Balcony Hazard",
          zoneId: "zone-lr-balcony",
        }),
      );

      // Trajectory path walking into Balcony Hazard zone (4000-4900, 500-1500)
      const pts = createPathPoints(4500, 1000, 4200, 1200, t, 45);
      segments.push(...toSegments(pts, roomId, 1));
    }
    events.push(
      createEvent(roomId, "candidate_fall", base + 14 * HOUR, {
        severity: "critical",
        zoneName: "Lounge Seating",
        acknowledged: false,
      }),
    );
  } else if (scenario === "period_comparison") {
    // 14 days total: Days 13-7 (Baseline Week: lower activity, ~2h/day) vs Days 6-0 (Active Week: ~6h/day)
    for (let d = 13; d >= 0; d--) {
      const dayBase = baseTimestamp - d * DAY;
      const isCurrentWeek = d <= 6;
      const hoursOccupied = isCurrentWeek ? 6 : 2;

      for (let s = 0; s < (isCurrentWeek ? 3 : 1); s++) {
        const sTime = dayBase - (18 - s * 4) * HOUR;
        const durMin = Math.round((hoursOccupied / (isCurrentWeek ? 3 : 1)) * 60);
        const eTime = sTime + durMin * 60000;

        events.push(createEvent(roomId, "room_occupied", sTime));
        events.push(createEvent(roomId, "target_detected", sTime + 1000));
        events.push(createEvent(roomId, "room_vacant", eTime));

        const pts = createPathPoints(2000, 1500, 3000, 3000, sTime, 45);
        segments.push(...toSegments(pts, roomId, 1));
      }
    }
  }

  return {
    scenario,
    title: meta.title,
    description: meta.description,
    segments,
    events,
  };
}

import {
  isPointInPolygon,
  type PlaybackTargetState,
  type RoomZone,
  type TrajectoryPoint,
  type TrajectorySegment,
} from "./types";

/** Maximum gap (ms) across which position interpolation is permitted. */
export const MAX_INTERPOLATION_GAP_MS = 2500;
/** Stale threshold (ms): target disappears after this duration without points. */
export const TARGET_STALE_MS = 1500;
/** Default trail window in milliseconds. */
export const DEFAULT_TRAIL_MS = 6000;

export interface InterpolatedFrame {
  timestamp: number;
  targets: PlaybackTargetState[];
  activeCount: number;
}

/**
 * Pure interpolation helper: calculates interpolated target positions at exact timestamp t.
 * Enforces strict boundary rules: never interpolates across long data gaps.
 */
export function interpolateTargetsAtTime(
  segments: TrajectorySegment[],
  timestamp: number,
  zones: RoomZone[] = [],
  trailDurationMs: number = DEFAULT_TRAIL_MS,
): InterpolatedFrame {
  // 1. Group segments by (sensor_type, target_id)
  const targetMap = new Map<
    string,
    { sensor_type: "ld2450" | "rd61"; target_id: number; points: TrajectoryPoint[] }
  >();

  for (const seg of segments) {
    const key = `${seg.sensor_type}_${seg.target_id}`;
    let entry = targetMap.get(key);
    if (!entry) {
      entry = { sensor_type: seg.sensor_type, target_id: seg.target_id, points: [] };
      targetMap.set(key, entry);
    }
    entry.points.push(...seg.points);
  }

  const activeTargets: PlaybackTargetState[] = [];

  for (const [, track] of targetMap.entries()) {
    const sorted = track.points.sort((a, b) => a.t - b.t);
    if (sorted.length === 0) continue;

    // Find point immediately before and after timestamp
    let prevIdx = -1;
    let nextIdx = -1;

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      if (!p) continue;
      if (p.t <= timestamp) {
        prevIdx = i;
      } else {
        nextIdx = i;
        break;
      }
    }

    const pPrev = prevIdx >= 0 ? sorted[prevIdx] : undefined;
    const pNext = nextIdx >= 0 ? sorted[nextIdx] : undefined;

    let x: number | null = null;
    let y: number | null = null;
    let z: number | undefined = undefined;
    let s = 0;

    if (pPrev && pNext) {
      const gap = pNext.t - pPrev.t;
      if (gap <= MAX_INTERPOLATION_GAP_MS) {
        const ratio = (timestamp - pPrev.t) / (gap || 1);
        x = Math.round(pPrev.x + (pNext.x - pPrev.x) * ratio);
        y = Math.round(pPrev.y + (pNext.y - pPrev.y) * ratio);
        if (pPrev.z !== undefined && pNext.z !== undefined) {
          z = Math.round(pPrev.z + (pNext.z - pPrev.z) * ratio);
        } else {
          z = pPrev.z ?? pNext.z;
        }
        s = Math.round((pPrev.s ?? 0) + ((pNext.s ?? 0) - (pPrev.s ?? 0)) * ratio);
      } else {
        // Gap is too wide: do NOT invent positions across disconnected tracks!
        // Only keep if within immediate recent window of previous point
        if (timestamp - pPrev.t <= TARGET_STALE_MS) {
          x = pPrev.x;
          y = pPrev.y;
          z = pPrev.z;
          s = 0;
        }
      }
    } else if (pPrev && timestamp - pPrev.t <= TARGET_STALE_MS) {
      // Near end of track
      x = pPrev.x;
      y = pPrev.y;
      z = pPrev.z;
      s = 0;
    } else if (pNext && pNext.t - timestamp <= 500) {
      // Just about to appear
      x = pNext.x;
      y = pNext.y;
      z = pNext.z;
      s = pNext.s ?? 0;
    }

    if (x !== null && y !== null) {
      // Calculate historical trail points within [timestamp - trailDurationMs, timestamp]
      const trailMin = timestamp - trailDurationMs;
      const trail = sorted
        .filter((pt) => pt.t >= trailMin && pt.t <= timestamp)
        .map((pt) => ({ x: pt.x, y: pt.y, t: pt.t }));

      // Append current interpolated point
      trail.push({ x, y, t: timestamp });

      // Determine current occupied zone and hazard status
      let currentZoneName: string | undefined = undefined;
      let isInHazard = false;

      // Note: in LD2450 view, lateral X is relative to sensor axis;
      // to check room zones, we need room coordinates or relative coordinates depending on zone
      for (const zone of zones) {
        if (zone.polygon && isPointInPolygon(x, y, zone.polygon)) {
          currentZoneName = zone.name;
          if (zone.type === "hazard" || zone.type === "restricted") {
            isInHazard = true;
          }
          break;
        }
      }

      // Calculate dwell time: time target spent continuously within 500mm radius up to timestamp
      let dwellMs = 0;
      for (let i = trail.length - 1; i >= 0; i--) {
        const pt = trail[i];
        if (!pt) continue;
        const dist = Math.hypot(pt.x - x, pt.y - y);
        if (dist <= 600) {
          dwellMs = timestamp - pt.t;
        } else {
          break;
        }
      }

      activeTargets.push({
        target_id: track.target_id,
        sensor_type: track.sensor_type,
        x_mm: x,
        y_mm: y,
        z_mm: z,
        speed_cms: s,
        timestamp,
        current_zone: currentZoneName,
        is_in_hazard: isInHazard,
        dwell_ms: dwellMs,
        trail,
      });
    }
  }

  return {
    timestamp,
    targets: activeTargets,
    activeCount: activeTargets.length,
  };
}

/**
 * Generates a collision-safe, deterministic, provenance-aware document ID for a trajectory segment.
 * Includes provenance ('sim' | 'hw'), sensor type, room ID, target ID, start epoch, and unique entropy.
 */
export function createTrajectorySegmentId(options: {
  simulated: boolean;
  sensorType: "ld2450" | "rd61";
  roomId: string;
  targetId: number;
  startEpoch: number;
  entropy?: string;
}): string {
  const prov = options.simulated ? "sim" : "hw";
  const ent = options.entropy ?? Math.random().toString(36).slice(2, 10);
  return `${prov}_${options.sensorType}_${options.roomId}_t${options.targetId}_${options.startEpoch}_${ent}`;
}

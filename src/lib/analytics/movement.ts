// How much people moved, hour by hour, from the tracks the server stored. Used by the dashboard's "movement" view.
import type { TrajectorySegment } from "@/lib/radar/types";

/** A step smaller than this is sensor jitter, not movement (same idea as the analytics deadband). */
export const MOVEMENT_DEADBAND_MM = 100;
/** Points further apart than this are not one continuous step. */
const MAX_STEP_GAP_MS = 5000;

/**
 * Counts movement steps per local hour (24 bins) for the 24 hours starting at `dayStartMs`: every step between two
 * consecutive points of a track that covers at least the deadband. A person sitting still adds nothing.
 */
export function movementPerHour(
  segments: Array<Pick<TrajectorySegment, "points">>,
  dayStartMs: number,
  deadbandMm = MOVEMENT_DEADBAND_MM,
): number[] {
  const bins = new Array<number>(24).fill(0);
  const dayEndMs = dayStartMs + 24 * 3_600_000;
  for (const seg of segments) {
    const pts = [...seg.points].sort((a, b) => a.t - b.t);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (b.t < dayStartMs || b.t >= dayEndMs) continue;
      if (b.t - a.t > MAX_STEP_GAP_MS) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) < deadbandMm) continue;
      const h = new Date(b.t).getHours();
      bins[h] = (bins[h] ?? 0) + 1;
    }
  }
  return bins;
}

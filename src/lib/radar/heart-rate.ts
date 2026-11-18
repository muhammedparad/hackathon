// Heart rate shown on the Live page, for someone who has been still for 10 s and is within 2 m of the sensor.
//
// The value is NOT measured: the LD2450 cannot measure heart rate. The card says "not measured" next to it, it is
// never stored in Firestore and it never feeds an alert. A measured value will come from a device that reports
// `vitals` (a 60 GHz vitals radar).

/** A person must have been still this long... */
export const HR_MIN_STILL_MS = 10_000;
/** ...and be this close to the sensor (mm) for the card to show a value. */
export const HR_MAX_RANGE_MM = 2000;

/** Moved if they drifted further than this from where they settled, or are clearly moving. */
const STILL_DRIFT_MM = 150;
const STILL_SPEED_CMS = 10;

interface Anchor {
  x: number;
  y: number;
  since: number;
}

/** How long each tracked person has been still (ms). Feed it every frame with the current time. */
export class StillTracker {
  private anchors = new Map<number, Anchor>();

  update(
    targets: Array<{ target_id: number; x_mm: number; y_mm: number; speed_cms: number }>,
    now: number,
  ): Map<number, number> {
    const out = new Map<number, number>();
    const seen = new Set<number>();
    for (const t of targets) {
      seen.add(t.target_id);
      const a = this.anchors.get(t.target_id);
      const moved =
        !a ||
        Math.abs(t.speed_cms) > STILL_SPEED_CMS ||
        Math.hypot(t.x_mm - a.x, t.y_mm - a.y) > STILL_DRIFT_MM;
      if (moved) this.anchors.set(t.target_id, { x: t.x_mm, y: t.y_mm, since: now });
      out.set(t.target_id, now - this.anchors.get(t.target_id)!.since);
    }
    for (const id of [...this.anchors.keys()]) if (!seen.has(id)) this.anchors.delete(id);
    return out;
  }
}

export interface HeartRateReading {
  target_id: number;
  /** Always false: this value is not measured. */
  measured: false;
  heart_rate_bpm: number;
}

/** Why a target does not get a value yet, or null when it does. */
export function heartRateBlocker(
  t: { x_mm: number; y_mm: number },
  stillMs: number,
): "moving" | "too_far" | null {
  if (Math.hypot(t.x_mm, t.y_mm) > HR_MAX_RANGE_MM) return "too_far";
  if (stillMs < HR_MIN_STILL_MS) return "moving";
  return null;
}

/** A plausible resting rate that drifts slowly. Deterministic for (target, time): not measured, not random noise. */
export function heartRateFor(targetId: number, now: number): number {
  const base = 60 + ((targetId * 7) % 14);
  const wander = 4 * Math.sin(now / 9000 + targetId) + 2 * Math.sin(now / 2300 + targetId * 2);
  return Math.round(base + wander);
}

/** Heart rate readings for everyone who is still and close enough. Empty unless `enabled`. */
export function heartRatesFor(
  enabled: boolean,
  targets: Array<{ target_id: number; x_mm: number; y_mm: number }>,
  stillMs: Map<number, number>,
  now: number,
): HeartRateReading[] {
  if (!enabled) return [];
  return targets
    .filter((t) => heartRateBlocker(t, stillMs.get(t.target_id) ?? 0) === null)
    .map((t) => ({
      target_id: t.target_id,
      measured: false as const,
      heart_rate_bpm: heartRateFor(t.target_id, now),
    }));
}

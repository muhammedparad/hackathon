// DEMO ONLY. A simulated heart rate for showing what a vitals sensor card would look like.
//
// None of this is measured: the LD2450 cannot measure heart rate. Every place that shows the number must label it
// SIMULATED, it is never stored in Firestore, and it never feeds an alert. It is off unless the user switches it on.
// A real value will come from a device that reports `vitals` (a 60 GHz vitals radar), not from here.

/** A person must have been still this long... */
export const DEMO_MIN_STILL_MS = 10_000;
/** ...and be this close to the sensor (mm) for the card to show a value. */
export const DEMO_MAX_RANGE_MM = 2000;

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

export interface DemoVitals {
  target_id: number;
  /** Always true: this value is not measured. */
  simulated: true;
  heart_rate_bpm: number;
}

/** Why a target does not get a value yet, or null when it does. */
export function demoBlocker(
  t: { x_mm: number; y_mm: number },
  stillMs: number,
): "moving" | "too_far" | null {
  if (Math.hypot(t.x_mm, t.y_mm) > DEMO_MAX_RANGE_MM) return "too_far";
  if (stillMs < DEMO_MIN_STILL_MS) return "moving";
  return null;
}

/** A plausible resting rate that drifts slowly. Deterministic for (target, time): not measured, not random noise. */
export function demoHeartRate(targetId: number, now: number): number {
  const base = 60 + ((targetId * 7) % 14);
  const wander = 4 * Math.sin(now / 9000 + targetId) + 2 * Math.sin(now / 2300 + targetId * 2);
  return Math.round(base + wander);
}

/** The simulated readings for everyone who is still and close enough. Empty unless `enabled`. */
export function demoVitalsFor(
  enabled: boolean,
  targets: Array<{ target_id: number; x_mm: number; y_mm: number }>,
  stillMs: Map<number, number>,
  now: number,
): DemoVitals[] {
  if (!enabled) return [];
  return targets
    .filter((t) => demoBlocker(t, stillMs.get(t.target_id) ?? 0) === null)
    .map((t) => ({
      target_id: t.target_id,
      simulated: true as const,
      heart_rate_bpm: demoHeartRate(t.target_id, now),
    }));
}

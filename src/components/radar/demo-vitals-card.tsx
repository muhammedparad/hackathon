import { useMemo, useRef } from "react";
import { Heart } from "lucide-react";
import {
  DEMO_MAX_RANGE_MM,
  DEMO_MIN_STILL_MS,
  StillTracker,
  demoBlocker,
  demoHeartRate,
} from "@/lib/radar/vitals-demo";
import { targetColor, targetLabel } from "@/lib/radar/palette";
import type { LD2450Target } from "@/lib/radar/types";

/**
 * Heart rate card. The number is SIMULATED: the LD2450 cannot measure heart rate, so it is a placeholder until a
 * vitals sensor reports real values. It is never stored and never used for alerts. It shows for someone who has
 * been still for 10 s and is within 2 m of the sensor, and the value carries a small "simulated" tag.
 */
export function DemoVitalsCard({ targets, now }: { targets: LD2450Target[]; now: number }) {
  const tracker = useRef(new StillTracker());
  const stillMs = useMemo(() => tracker.current.update(targets, now), [targets, now]);

  return (
    <section
      className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_rgba(15,23,42,0.06)]"
      aria-label="Heart rate"
    >
      <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
        <Heart className="size-4 text-rose-500" /> Heart rate
      </h2>

      {targets.length === 0 ? (
        <p className="mt-3 rounded-xl bg-slate-50 py-5 text-center text-sm text-slate-500">
          No one detected.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {targets.map((t) => {
            const ms = stillMs.get(t.target_id) ?? 0;
            const blocker = demoBlocker(t, ms);
            return (
              <li
                key={t.target_id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3"
              >
                <span className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: targetColor(t.target_id) }}
                  />
                  ID: {targetLabel(t.target_id)}
                </span>
                {blocker === null ? (
                  <span className="flex items-baseline gap-1.5 text-rose-600">
                    <Heart className="size-4 animate-pulse self-center fill-rose-500" />
                    <span className="text-2xl font-bold tabular-nums">
                      {demoHeartRate(t.target_id, now)}
                    </span>
                    <span className="text-xs font-medium">bpm</span>
                    <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                      simulated
                    </span>
                  </span>
                ) : blocker === "too_far" ? (
                  <span className="text-xs text-slate-500">
                    Too far ({(Math.hypot(t.x_mm, t.y_mm) / 1000).toFixed(1)} m, needs within{" "}
                    {DEMO_MAX_RANGE_MM / 1000} m)
                  </span>
                ) : (
                  <span className="text-xs text-slate-500">
                    Waiting: still {Math.floor(ms / 1000)} / {DEMO_MIN_STILL_MS / 1000} s
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

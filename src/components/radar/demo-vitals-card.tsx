import { useEffect, useMemo, useRef, useState } from "react";
import { Heart } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  DEMO_MAX_RANGE_MM,
  DEMO_MIN_STILL_MS,
  StillTracker,
  demoBlocker,
  demoHeartRate,
} from "@/lib/radar/vitals-demo";
import { targetColor, targetLabel } from "@/lib/radar/palette";
import type { LD2450Target } from "@/lib/radar/types";

const KEY = "rt.demoVitals";

function readEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * DEMO heart rate. Not measured: the LD2450 has no vitals. Off until the user switches it on, always labelled
 * SIMULATED, never stored, never used for alerts. Shows a value only for someone who has been still for 10 s and is
 * within 2 m of the sensor.
 */
export function DemoVitalsCard({ targets, now }: { targets: LD2450Target[]; now: number }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => setEnabled(readEnabled()), []);
  const toggle = (v: boolean) => {
    setEnabled(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* the switch still works for this visit */
    }
  };

  const tracker = useRef(new StillTracker());
  const stillMs = useMemo(() => tracker.current.update(targets, now), [targets, now]);

  return (
    <section
      className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_rgba(15,23,42,0.06)]"
      aria-label="Heart rate (simulated demo)"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
          <Heart className="size-4 text-rose-500" /> Heart rate
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
            Simulated demo
          </span>
        </h2>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Demo
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            aria-label="Show simulated heart rate"
          />
        </label>
      </div>

      {!enabled ? (
        <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
          The LD2450 cannot measure heart rate. Switch the demo on to preview this card with a
          simulated number. A real value needs a vitals sensor.
        </p>
      ) : targets.length === 0 ? (
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
                    <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">
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

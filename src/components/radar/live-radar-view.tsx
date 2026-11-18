import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, Bed, Crosshair, Pause, Play, Settings, User, UserRound } from "lucide-react";
import type { Radar3DProps } from "@/components/radar/radar-3d";
import { RadarStage } from "@/components/radar/radar-stage";
import { DemoVitalsCard } from "@/components/radar/demo-vitals-card";
import { AreaSeries } from "@/components/app/charts";
import { targetColor, targetLabel } from "@/lib/radar/palette";
import type { LD2450Target } from "@/lib/radar/types";
import { cn } from "@/lib/utils";

export type LiveRoomStatus = "occupied" | "vacant" | "sensor_offline" | "unknown";

export interface SignalSample {
  label: string;
  targets: number;
  nearest: number | null;
  speed: number;
}

export interface LiveRadarViewProps {
  room: Radar3DProps["room"] & { id: string; name: string };
  status: LiveRoomStatus;
  hasBed: boolean;
  targets: LD2450Target[];
  trails: Radar3DProps["trails"];
  points: Radar3DProps["points"];
  hub: Radar3DProps["hub"];
  stale: boolean;
  /** Current time (ms), ticking, for the still-for-10-s timer */
  now: number;
  lastUpdateLabel: string;
  series: SignalSample[];
  /** The stored-trajectory heatmap is rendered by the page. */
  heatmap: ReactNode;
  frozen: boolean;
  onToggleFrozen: () => void;
  banners?: ReactNode;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

const CARD = "rounded-2xl border border-slate-100 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.06)]";
const PILL: Record<LiveRoomStatus, { label: string; cls: string; dot: string }> = {
  occupied: { label: "Occupied", cls: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  vacant: { label: "Vacant", cls: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  sensor_offline: {
    label: "Sensor offline",
    cls: "bg-amber-50 text-amber-700",
    dot: "bg-amber-400",
  },
  unknown: { label: "No data yet", cls: "bg-slate-100 text-slate-500", dot: "bg-slate-300" },
};

const SERIES: Array<{ id: "targets" | "nearest" | "speed"; label: string; unit?: string }> = [
  { id: "targets", label: "People detected" },
  { id: "nearest", label: "Nearest target", unit: " m" },
  { id: "speed", label: "Fastest speed", unit: " m/s" },
];

export function LiveRadarView(p: LiveRadarViewProps) {
  const [metric, setMetric] = useState<(typeof SERIES)[number]["id"]>("targets");

  const pill = PILL[p.status];
  const nearest = p.targets.length
    ? Math.min(...p.targets.map((t) => Math.hypot(t.x_mm, t.y_mm))) / 1000
    : null;
  const metricDef = SERIES.find((s) => s.id === metric)!;

  return (
    <div className="min-w-0 space-y-4">
      {p.banners}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------- left: radar ---------- */}
        <RadarStage
          room={p.room}
          targets={p.targets}
          trails={p.trails}
          points={p.points}
          hub={p.hub}
          stale={p.stale}
          selectedId={p.selectedId}
          onSelect={p.onSelect}
          heatmap={p.heatmap}
          headerRight={
            <button
              type="button"
              onClick={p.onToggleFrozen}
              className="inline-flex size-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              aria-label={p.frozen ? "Resume live view" : "Freeze view"}
              title={p.frozen ? "Resume live view" : "Freeze view"}
            >
              {p.frozen ? <Play className="size-4" /> : <Pause className="size-4" />}
            </button>
          }
          overlay={
            <>
              {p.status === "unknown" && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6 text-center">
                  <div className="rounded-2xl bg-[#0a1740]/90 px-5 py-4 text-sm text-slate-200 ring-1 ring-sky-400/40">
                    <div className="font-semibold text-white">No radar data yet</div>
                    Waiting for a registered device assigned to this room to report.
                  </div>
                </div>
              )}
              {p.stale && p.status !== "unknown" && (
                <div className="absolute bottom-3 left-3 z-10 rounded-lg bg-amber-500/90 px-3 py-1 text-xs font-semibold text-white">
                  No fresh data · last update {p.lastUpdateLabel}
                </div>
              )}
            </>
          }
        />

        {/* ---------- right: details ---------- */}
        <div className="min-w-0 space-y-4">
          <section className={cn(CARD, "flex items-center justify-between gap-3 p-4")}>
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                {p.hasBed ? <Bed className="size-6" /> : <User className="size-6" />}
              </div>
              <div className="min-w-0">
                <div className="truncate text-lg font-bold text-slate-900">{p.room.name}</div>
                <div className="text-xs text-slate-500">Real-time presence tracking</div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold",
                  pill.cls,
                )}
              >
                <span className={cn("size-2 rounded-full", pill.dot)} />
                {pill.label}
              </span>
              <Link
                to="/rooms"
                aria-label="Room settings"
                className="inline-flex size-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
              >
                <Settings className="size-4" />
              </Link>
            </div>
          </section>

          <section className="grid grid-cols-3 gap-3" aria-label="Live numbers">
            {[
              {
                icon: UserRound,
                value: String(p.targets.length),
                label: p.targets.length === 1 ? "Person Detected" : "People Detected",
              },
              {
                icon: Crosshair,
                value: nearest === null ? "—" : `${nearest.toFixed(2)} m`,
                label: "Nearest Target",
              },
              { icon: Activity, value: p.lastUpdateLabel, label: "Last Update" },
            ].map((s) => (
              <div key={s.label} className={cn(CARD, "p-3.5")}>
                <s.icon className="size-5 text-indigo-500" />
                <div className="mt-2 truncate text-xl font-bold tabular-nums text-slate-900">
                  {s.value}
                </div>
                <div className="text-[11px] leading-tight text-slate-500">{s.label}</div>
              </div>
            ))}
          </section>

          <section className={cn(CARD, "p-4")} aria-label="Targets">
            <h2 className="text-base font-bold text-slate-900">Targets ({p.targets.length})</h2>
            {p.targets.length === 0 ? (
              <p className="mt-3 rounded-xl bg-slate-50 py-6 text-center text-sm text-slate-500">
                {p.status === "unknown" ? "No data received yet." : "No one detected right now."}
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {p.targets.map((t) => {
                  const moving = t.speed_cms !== 0;
                  const sel = p.selectedId === t.target_id;
                  return (
                    <li key={t.target_id}>
                      <button
                        type="button"
                        onClick={() => p.onSelect(sel ? null : t.target_id)}
                        aria-pressed={sel}
                        className={cn(
                          "grid w-full grid-cols-[auto_1fr_1fr_auto] items-center gap-x-3 rounded-xl border p-3 text-left",
                          sel
                            ? "border-emerald-300 bg-emerald-50/60"
                            : "border-slate-100 bg-slate-50/60",
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm font-bold text-slate-900">
                          <span
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: targetColor(t.target_id) }}
                          />
                          ID: {targetLabel(t.target_id)}
                        </span>
                        <span>
                          <span className="block text-[11px] text-slate-400">Position</span>
                          <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-slate-800">
                            {(t.x_mm / 1000).toFixed(1)} m, {(t.y_mm / 1000).toFixed(1)} m
                          </span>
                        </span>
                        <span>
                          <span className="block text-[11px] text-slate-400">Velocity</span>
                          <span className="text-sm font-semibold tabular-nums text-slate-800">
                            {(t.speed_cms / 100).toFixed(2)} m/s
                          </span>
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                            moving ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700",
                          )}
                        >
                          {moving ? "Moving" : "Stationary"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <DemoVitalsCard targets={p.targets} now={p.now} />

          <section className={cn(CARD, "p-4")} aria-label="Live signal">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-slate-900">Live Signal</h2>
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as typeof metric)}
                className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"
                aria-label="Signal to chart"
              >
                {SERIES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            {p.series.length < 2 ? (
              <p className="mt-3 rounded-xl bg-slate-50 py-8 text-center text-sm text-slate-500">
                The chart fills in as live frames arrive.
              </p>
            ) : (
              <div className="mt-2">
                <AreaSeries
                  data={p.series as unknown as Record<string, unknown>[]}
                  x="label"
                  y={metricDef.id}
                  yDomain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.3 * 10) / 10)]}
                  {...(metricDef.unit ? { unit: metricDef.unit } : {})}
                  height={170}
                />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

import { AlertCircle, CheckCircle2, Clock, Calendar, Sparkles } from "lucide-react";
import type { RoutineInsights } from "@/lib/analytics/types";
import { AreaSeries, Bars } from "@/components/app/charts";
import { Pill } from "@/components/app/status";
import { cn } from "@/lib/utils";

interface RoutineInsightsCardProps {
  insights: RoutineInsights;
}

export function RoutineInsightsCard({ insights }: RoutineInsightsCardProps) {
  const {
    sufficiency,
    hourlyProfile,
    weekdayProfile,
    observedPatterns,
    configuredAdherence,
    deviations,
  } = insights;

  const hourlyChartData = hourlyProfile.map((s) => ({
    label: s.label,
    observed: s.observedOccupancyPct,
    baseline: s.baselineOccupancyPct,
  }));

  const weekdayChartData = weekdayProfile.map((w) => ({
    label: w.dayName,
    util: w.utilisationPct,
    hours: w.occupiedHours,
  }));

  return (
    <div className="space-y-6">
      {/* 1. Baseline Sufficiency Status Banner */}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-xl border p-4 text-xs sm:flex-row sm:items-center sm:justify-between",
          sufficiency.isSufficient
            ? "border-emerald-200 bg-emerald-50/50 text-emerald-950"
            : "border-amber-200 bg-amber-50/50 text-amber-950",
        )}
      >
        <div className="flex items-start gap-2.5">
          {sufficiency.isSufficient ? (
            <CheckCircle2 className="mt-0.5 size-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 size-4 text-amber-600 shrink-0" />
          )}
          <div>
            <div className="font-semibold text-sm">
              {sufficiency.isSufficient
                ? "Historical Baseline Established"
                : "Insufficient Baseline History"}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{sufficiency.reason}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Pill t={sufficiency.isSufficient ? "success" : "warning"}>
            {sufficiency.daysObserved} / {sufficiency.minRequiredDays} Active Days
          </Pill>
        </div>
      </div>

      {/* 2. 24-Hour Activity Pattern: Observed vs Baseline */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              24-Hour Household Activity Pattern
            </h4>
            <p className="text-xs text-muted-foreground">
              Average occupancy percentage per hour of day comparing observed activity against
              historical baseline.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-primary" /> Observed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-muted-foreground/40" /> Baseline
            </span>
          </div>
        </div>

        <div className="mt-4">
          <Bars
            data={hourlyChartData}
            x="label"
            bars={[
              { key: "observed", label: "Observed Occupancy", color: "var(--chart-1)" },
              { key: "baseline", label: "Baseline Expectation", color: "var(--grid-strong)" },
            ]}
            unit="%"
            height={220}
          />
        </div>
      </div>

      {/* 3. Weekday Distribution */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Weekly Day-by-Day Activity</h4>
          <p className="text-xs text-muted-foreground">
            Occupied hours across Sunday through Saturday.
          </p>
          <div className="mt-4">
            <Bars
              data={weekdayChartData}
              x="label"
              bars={[{ key: "hours", label: "Occupied Hours", color: "var(--chart-2)" }]}
              unit="h"
              height={200}
            />
          </div>
        </div>

        {/* 4. Observed Statistical Patterns vs Configured Routines */}
        <div className="space-y-4">
          {/* Automatically Observed Patterns */}
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">Observed Recurring Patterns</h4>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Derived purely from statistical clustering of anonymous radar detections. No
              identities or behaviors inferred.
            </p>

            <div className="mt-3 space-y-2">
              {observedPatterns.length === 0 ? (
                <div className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                  {sufficiency.isSufficient
                    ? "No pronounced peak or quiet patterns identified in the selected window."
                    : "Statistical pattern detection disabled until baseline history reaches 3+ days."}
                </div>
              ) : (
                observedPatterns.map((pat) => (
                  <div key={pat.id} className="rounded-lg border bg-muted/20 p-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">{pat.name}</span>
                      <Pill t="neutral">{pat.timeRange}</Pill>
                    </div>
                    <p className="mt-1 text-muted-foreground">{pat.description}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* User-Configured Routines */}
          {configuredAdherence.length > 0 && (
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-1.5">
                <Clock className="size-4 text-primary" />
                <h4 className="text-sm font-semibold text-foreground">
                  Configured Routine Adherence
                </h4>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Evaluates user-configured schedules against observed anonymous occupancy.
              </p>
              <div className="mt-3 space-y-2">
                {configuredAdherence.map((r) => (
                  <div key={r.routineId} className="rounded-lg border bg-muted/20 p-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">{r.routineName}</span>
                      <Pill
                        t={
                          r.status === "adhered"
                            ? "success"
                            : r.status === "deviated"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {r.adherencePct}% Adherence
                      </Pill>
                    </div>
                    <p className="mt-1 text-muted-foreground">{r.details}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. Routine Deviations */}
      {deviations.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-900">
            Detected Household Activity Deviations
          </h4>
          <ul className="mt-2 space-y-1 text-xs text-amber-800">
            {deviations.map((dev, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-amber-600" />
                {dev}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

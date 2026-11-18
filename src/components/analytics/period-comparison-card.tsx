import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { PeriodComparisonResult } from "@/lib/analytics/types";
import { Bars } from "@/components/app/charts";
import { cn } from "@/lib/utils";

interface PeriodComparisonCardProps {
  comparison: PeriodComparisonResult;
}

export function PeriodComparisonCard({ comparison }: PeriodComparisonCardProps) {
  const { current, previous, deltas, zoneShifts } = comparison;

  const renderDelta = (delta: number, unit = "", invertColor = false) => {
    if (delta === 0) {
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
          <Minus className="size-3" /> No change
        </span>
      );
    }
    const isPositive = delta > 0;
    // For alerts, positive delta (more alerts) is bad (red), negative is good (green)
    const isGood = invertColor ? !isPositive : isPositive;

    return (
      <span
        className={cn(
          "inline-flex items-center gap-0.5 font-mono text-xs font-semibold",
          isGood ? "text-emerald-600" : "text-amber-600",
        )}
      >
        {isPositive ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
        {isPositive ? "+" : ""}
        {delta}
        {unit}
      </span>
    );
  };

  const chartData = [
    {
      metric: "Occupancy (h)",
      current: current.occupiedHours,
      previous: previous.occupiedHours,
    },
    {
      metric: "Utilisation (%)",
      current: current.utilisationPct,
      previous: previous.utilisationPct,
    },
    {
      metric: "Sessions",
      current: current.sessionCount,
      previous: previous.sessionCount,
    },
    {
      metric: "Alerts",
      current: current.alertCount,
      previous: previous.alertCount,
    },
  ];

  return (
    <div className="space-y-6">
      {/* 1. Comparison KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Occupied Hours */}
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Occupied Hours</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold">{current.occupiedHours}h</span>
            <span className="text-xs text-muted-foreground font-mono">
              prev {previous.occupiedHours}h
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t pt-2">
            <span className="text-[11px] text-muted-foreground">Change</span>
            {renderDelta(deltas.occupiedHoursDelta, "h")}
          </div>
        </div>

        {/* Room Utilisation */}
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Room Utilisation</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold">{current.utilisationPct}%</span>
            <span className="text-xs text-muted-foreground font-mono">
              prev {previous.utilisationPct}%
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t pt-2">
            <span className="text-[11px] text-muted-foreground">Change</span>
            {renderDelta(deltas.utilisationDelta, "%")}
          </div>
        </div>

        {/* Movement Sessions */}
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Movement Sessions</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold">{current.sessionCount}</span>
            <span className="text-xs text-muted-foreground font-mono">
              prev {previous.sessionCount}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t pt-2">
            <span className="text-[11px] text-muted-foreground">Change</span>
            {renderDelta(deltas.sessionCountDelta, "")}
          </div>
        </div>

        {/* Alerts */}
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Alerts Recorded</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold">{current.alertCount}</span>
            <span className="text-xs text-muted-foreground font-mono">
              prev {previous.alertCount}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t pt-2">
            <span className="text-[11px] text-muted-foreground">Change</span>
            {renderDelta(deltas.alertCountDelta, "", true)}
          </div>
        </div>
      </div>

      {/* 2. Visual Comparison Chart */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground">
            Activity Shift: Current vs Previous Window
          </h4>
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-primary" /> {current.label}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-muted-foreground/40" /> {previous.label}
            </span>
          </div>
        </div>
        <div className="mt-4">
          <Bars
            data={chartData}
            x="metric"
            bars={[
              { key: "previous", label: previous.label, color: "var(--grid-strong)" },
              { key: "current", label: current.label, color: "var(--chart-1)" },
            ]}
            height={200}
          />
        </div>
      </div>

      {/* 3. Zone Dwell Shifts Table */}
      {zoneShifts.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Zone Dwell Time Shifts
          </h4>
          <div className="mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left font-medium text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Zone</th>
                  <th className="px-3 py-2 text-right">Current Dwell</th>
                  <th className="px-3 py-2 text-right">Previous Dwell</th>
                  <th className="px-3 py-2 text-right">Shift (Δ)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-mono">
                {zoneShifts.map((z) => (
                  <tr key={z.zoneId} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-sans font-medium text-foreground">
                      {z.zoneName}
                    </td>
                    <td className="px-3 py-2 text-right">{z.currentMinutes} min</td>
                    <td className="px-3 py-2 text-right">{z.previousMinutes} min</td>
                    <td className="px-3 py-2 text-right">{renderDelta(z.deltaMinutes, " min")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

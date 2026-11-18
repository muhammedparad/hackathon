import { AlertTriangle, CheckCircle, ShieldAlert } from "lucide-react";
import type { AlertsSummary } from "@/lib/analytics/types";
import { Bars } from "@/components/app/charts";
import { Pill } from "@/components/app/status";
import { EVENT_LABELS } from "@/lib/radar/types";
import { cn } from "@/lib/utils";

interface AlertAnalyticsCardProps {
  summary: AlertsSummary;
}

export function AlertAnalyticsCard({ summary }: AlertAnalyticsCardProps) {
  const {
    totalAlerts,
    bySeverity,
    byType,
    acknowledgedCount,
    unacknowledgedCount,
    acknowledgementRatePct,
    avgTimeToAcknowledgeMs,
    topAffectedZones,
    repeatedPatterns,
    dailyTrends,
  } = summary;

  if (totalAlerts === 0) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-xs text-muted-foreground">
        <CheckCircle className="mx-auto mb-2 size-8 text-emerald-500" />
        No safety alerts or hazard warnings recorded during this period.
      </div>
    );
  }

  const formatAvgTime = (ms: number | null) => {
    if (ms === null || ms <= 0) return "--";
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    if (min === 0) return `${sec}s`;
    return `${min}m ${sec % 60}s`;
  };

  const typeChartData = Object.entries(byType).map(([type, count]) => ({
    label: EVENT_LABELS[type as keyof typeof EVENT_LABELS] ?? type.replace(/_/g, " "),
    count,
  }));

  return (
    <div className="space-y-6">
      {/* 1. KPI Badges */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Total Alert Events</div>
          <div className="mt-1 font-mono text-2xl font-bold">{totalAlerts}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Critical / High Severity</div>
          <div className="mt-1 font-mono text-2xl font-bold text-destructive">
            {bySeverity.critical + bySeverity.high}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Acknowledgement Rate</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-600">
            {acknowledgementRatePct}%
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {acknowledgedCount} of {totalAlerts} acknowledged
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">Avg. Time to Acknowledge</div>
          <div className="mt-1 font-mono text-2xl font-bold">
            {formatAvgTime(avgTimeToAcknowledgeMs)}
          </div>
        </div>
      </div>

      {/* 2. Severity Breakdown Bar */}
      <div className="rounded-xl border bg-card p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Alerts by Severity Level
        </h4>
        <div className="mt-3 flex flex-wrap gap-2">
          {bySeverity.critical > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-900">
              <span className="size-2 rounded-full bg-red-600" />
              <span className="font-medium">Critical:</span> {bySeverity.critical}
            </div>
          )}
          {bySeverity.high > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs text-orange-900">
              <span className="size-2 rounded-full bg-orange-600" />
              <span className="font-medium">High:</span> {bySeverity.high}
            </div>
          )}
          {bySeverity.medium > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
              <span className="size-2 rounded-full bg-amber-600" />
              <span className="font-medium">Medium:</span> {bySeverity.medium}
            </div>
          )}
          {bySeverity.low > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs text-blue-900">
              <span className="size-2 rounded-full bg-blue-600" />
              <span className="font-medium">Low:</span> {bySeverity.low}
            </div>
          )}
          {bySeverity.info > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-900">
              <span className="size-2 rounded-full bg-slate-500" />
              <span className="font-medium">Info:</span> {bySeverity.info}
            </div>
          )}
        </div>
      </div>

      {/* 3. Charts Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Alerts by Event Type</h4>
          <div className="mt-4">
            <Bars
              data={typeChartData}
              x="label"
              layout="vertical"
              bars={[{ key: "count", label: "Alerts", color: "var(--chart-3)" }]}
              height={Math.max(160, typeChartData.length * 40)}
            />
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Daily Alert Frequency</h4>
          <div className="mt-4">
            <Bars
              data={dailyTrends}
              x="date"
              bars={[
                { key: "count", label: "Total Alerts", color: "var(--chart-1)" },
                { key: "criticalOrHighCount", label: "Critical/High", color: "var(--destructive)" },
              ]}
              height={200}
            />
          </div>
        </div>
      </div>

      {/* 4. Top Affected Zones & Repeated Patterns */}
      <div className="grid gap-6 sm:grid-cols-2">
        {topAffectedZones.length > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Most Frequently Affected Zones
            </h4>
            <div className="mt-3 space-y-2">
              {topAffectedZones.map((z, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-foreground">{z.zoneName}</span>
                  <span className="font-mono text-destructive">{z.count} alerts</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {repeatedPatterns.length > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Identified Repeated Alert Patterns
            </h4>
            <div className="mt-3 space-y-2">
              {repeatedPatterns.map((pat, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-amber-200 bg-amber-50/30 p-2.5 text-xs"
                >
                  <div className="font-semibold text-amber-900">{pat.title}</div>
                  <div className="mt-0.5 text-muted-foreground">{pat.description}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

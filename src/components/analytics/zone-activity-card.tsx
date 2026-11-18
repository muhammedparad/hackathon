import type { ZoneActivity } from "@/lib/analytics/types";
import { Bars } from "@/components/app/charts";
import { cn } from "@/lib/utils";

interface ZoneActivityCardProps {
  zones: ZoneActivity[];
}

export function ZoneActivityCard({ zones }: ZoneActivityCardProps) {
  if (zones.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        No configured room zones to analyze. Add zones in the Floor Plan editor to track zone dwell
        times.
      </div>
    );
  }

  const chartData = zones.map((z) => ({
    label: z.zoneName,
    dwellMinutes: z.dwellMinutes,
    dwellPct: z.dwellPercentage,
    visits: z.visitCount,
  }));

  return (
    <div className="space-y-4">
      {/* Horizontal Bar Chart */}
      <Bars
        data={chartData}
        x="label"
        layout="vertical"
        bars={[{ key: "dwellMinutes", label: "Dwell Time", color: "var(--chart-1)" }]}
        unit="m"
        height={Math.max(160, zones.length * 45)}
      />

      {/* Summary Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left font-medium text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Dwell Time</th>
              <th className="px-3 py-2 text-right">Activity Share</th>
              <th className="px-3 py-2 text-right">Visits</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border font-mono">
            {zones.map((z) => {
              const isHazard = z.zoneType === "hazard" || z.zoneType === "restricted";
              return (
                <tr key={z.zoneId} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-sans font-medium text-foreground">{z.zoneName}</td>
                  <td className="px-3 py-2 font-sans">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        isHazard
                          ? "bg-destructive/10 text-destructive"
                          : "bg-primary/10 text-primary",
                      )}
                    >
                      {z.zoneType}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">{z.dwellMinutes} min</td>
                  <td className="px-3 py-2 text-right">{z.dwellPercentage}%</td>
                  <td className="px-3 py-2 text-right">{z.visitCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

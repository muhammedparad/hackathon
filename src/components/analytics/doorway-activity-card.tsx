import type { DoorwayActivity } from "@/lib/analytics/types";
import { Bars } from "@/components/app/charts";
import { LogIn, LogOut, Info } from "lucide-react";

interface DoorwayActivityCardProps {
  doorways: DoorwayActivity[];
}

export function DoorwayActivityCard({ doorways }: DoorwayActivityCardProps) {
  if (doorways.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        No configured doorways found for this room. Configure doorways in Floor Plan editor to
        observe ingress and egress transitions.
      </div>
    );
  }

  const chartData = doorways.map((d) => ({
    label: d.doorName,
    entries: d.directionality === "supported" ? d.entries : 0,
    exits: d.directionality === "supported" ? d.exits : 0,
    total: d.totalCrossings,
  }));

  const formatHour = (h: number | null) => {
    if (h === null) return "--:--";
    return `${String(h).padStart(2, "0")}:00`;
  };

  const hasUnsupportedDoor = doorways.some((d) => d.directionality === "unsupported");

  return (
    <div className="space-y-4">
      {/* Grouped Bars: Ingress vs Egress */}
      <Bars
        data={chartData}
        x="label"
        bars={[
          { key: "entries", label: "Entries (Inward)", color: "var(--chart-2)" },
          { key: "exits", label: "Exits (Outward)", color: "var(--chart-3)" },
        ]}
        height={180}
      />

      {hasUnsupportedDoor && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <Info className="size-4 shrink-0" />
          <span>
            Directional classification (inward vs outward) is unavailable for doorways with interior
            or non-wall geometry. Proximity transits are recorded without directional assumptions.
          </span>
        </div>
      )}

      {/* Door Traffic Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left font-medium text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Doorway</th>
              <th className="px-3 py-2">Allowed Flow</th>
              <th className="px-3 py-2 text-right">
                <span className="inline-flex items-center gap-1">
                  <LogIn className="size-3 text-emerald-500" /> Entries
                </span>
              </th>
              <th className="px-3 py-2 text-right">
                <span className="inline-flex items-center gap-1">
                  <LogOut className="size-3 text-amber-500" /> Exits
                </span>
              </th>
              <th className="px-3 py-2 text-right">Total Transits</th>
              <th className="px-3 py-2 text-right">Peak Transit Hour</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border font-mono">
            {doorways.map((d) => (
              <tr key={d.doorId} className="hover:bg-muted/20">
                <td className="px-3 py-2 font-sans font-medium text-foreground">
                  <div className="flex items-center gap-1.5">
                    {d.doorName}
                    {d.directionality === "unsupported" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground font-normal">
                        Direction unavailable
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 font-sans capitalize text-muted-foreground">
                  {d.doorType}
                </td>
                <td className="px-3 py-2 text-right text-emerald-600 font-semibold">
                  {d.directionality === "supported" ? d.entries : "—"}
                </td>
                <td className="px-3 py-2 text-right text-amber-600 font-semibold">
                  {d.directionality === "supported" ? d.exits : "—"}
                </td>
                <td className="px-3 py-2 text-right text-foreground font-semibold">
                  {d.totalCrossings}
                </td>
                <td className="px-3 py-2 text-right">{formatHour(d.peakHour)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

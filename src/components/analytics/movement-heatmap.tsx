import { useId, useMemo, useState } from "react";
import { Layers, MapPin, Eye, EyeOff } from "lucide-react";
import type { Door, RoomZone } from "@/lib/radar/types";
import type { HeatmapData } from "@/lib/analytics/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MovementHeatmapProps {
  heatmapData: HeatmapData;
  roomWidthMm: number;
  roomLengthMm: number;
  zones?: RoomZone[];
  doors?: Door[];
  simulated?: boolean;
}

export function MovementHeatmap({
  heatmapData,
  roomWidthMm: W,
  roomLengthMm: L,
  zones = [],
  doors = [],
}: MovementHeatmapProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [showZones, setShowZones] = useState(true);
  const [showDoors, setShowDoors] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [hoveredCell, setHoveredCell] = useState<{
    col: number;
    row: number;
    count: number;
    density: number;
  } | null>(null);

  const pad = 400;
  const vbW = W + pad * 2;
  const vbH = L + pad * 2;
  const viewBox = `${-pad} ${-pad} ${vbW} ${vbH}`;

  // Color mapping function based on normalized density (0.0 to 1.0)
  const getCellColor = (density: number) => {
    if (density <= 0) return "transparent";
    if (density < 0.2) return "rgba(14, 165, 233, 0.35)"; // Sky blue
    if (density < 0.4) return "rgba(16, 185, 129, 0.45)"; // Emerald
    if (density < 0.7) return "rgba(245, 158, 11, 0.65)"; // Amber
    return "rgba(239, 68, 68, 0.85)"; // Red
  };

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-medium text-foreground">Resolution:</span> {heatmapData.gridCols}×
          {heatmapData.gridRows} ({heatmapData.cellWidthMm}×{heatmapData.cellHeightMm}mm cells)
          <span className="mx-1">•</span>
          <span className="font-medium text-foreground">Points binned:</span>{" "}
          {heatmapData.totalPoints.toLocaleString()}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={showZones ? "secondary" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowZones((v) => !v)}
          >
            <Layers className="mr-1 size-3.5" />
            Zones
          </Button>
          <Button
            variant={showDoors ? "secondary" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowDoors((v) => !v)}
          >
            <MapPin className="mr-1 size-3.5" />
            Doors
          </Button>
          <Button
            variant={showGrid ? "secondary" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowGrid((v) => !v)}
          >
            {showGrid ? <Eye className="mr-1 size-3.5" /> : <EyeOff className="mr-1 size-3.5" />}
            Grid
          </Button>
        </div>
      </div>

      {/* Heatmap Floor Plan Canvas / SVG */}
      <div className="relative overflow-hidden rounded-xl border bg-radar-floor shadow-inner">
        <svg
          viewBox={viewBox}
          className="aspect-[5/4] w-full select-none"
          role="img"
          aria-label={`Movement Heatmap: ${heatmapData.totalPoints} points binned across room`}
        >
          <defs>
            <clipPath id={`room-clip-${uid}`}>
              <rect x={0} y={0} width={W} height={L} rx={40} />
            </clipPath>
          </defs>

          {/* Room floor background */}
          <rect
            x={0}
            y={0}
            width={W}
            height={L}
            rx={40}
            className="fill-card stroke-border"
            strokeWidth={12}
          />

          {/* Heatmap Cells */}
          <g clipPath={`url(#room-clip-${uid})`}>
            {heatmapData.cells.map((cell) => {
              if (cell.count === 0 && !showGrid) return null;
              const x = cell.col * heatmapData.cellWidthMm;
              const y = cell.row * heatmapData.cellHeightMm;
              const fill = getCellColor(cell.density);

              return (
                <rect
                  key={`cell-${cell.col}-${cell.row}`}
                  x={x}
                  y={y}
                  width={heatmapData.cellWidthMm}
                  height={heatmapData.cellHeightMm}
                  fill={fill}
                  stroke={showGrid ? "rgba(0, 0, 0, 0.05)" : "none"}
                  strokeWidth={showGrid ? 1 : 0}
                  className="transition-colors hover:stroke-foreground/40 hover:stroke-[2]"
                  onMouseEnter={() => setHoveredCell(cell)}
                  onMouseLeave={() => setHoveredCell(null)}
                />
              );
            })}
          </g>

          {/* Zones Overlay */}
          {showZones &&
            zones.map((zone) => {
              if (!zone.polygon || zone.polygon.length < 3) return null;
              const pts = zone.polygon.map((p) => `${p.x_mm},${p.y_mm}`).join(" ");
              const isHazard = zone.type === "hazard" || zone.type === "restricted";
              const strokeColor = isHazard ? "var(--destructive)" : "var(--primary)";
              const fillColor = isHazard ? "rgba(239, 68, 68, 0.12)" : "rgba(37, 99, 235, 0.08)";

              const cx = zone.polygon.reduce((sum, p) => sum + p.x_mm, 0) / zone.polygon.length;
              const cy = zone.polygon.reduce((sum, p) => sum + p.y_mm, 0) / zone.polygon.length;

              return (
                <g key={`zone-${zone.id}`}>
                  <polygon
                    points={pts}
                    stroke={strokeColor}
                    strokeWidth={8}
                    strokeDasharray="16 8"
                    fill={fillColor}
                  />
                  <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="select-none font-sans text-[110px] font-semibold fill-foreground/80 drop-shadow-sm"
                  >
                    {zone.name}
                  </text>
                </g>
              );
            })}

          {/* Doors Overlay */}
          {showDoors &&
            doors.map((door) => {
              const dw = door.width_mm || 900;
              const wall = door.wall ?? (door.y_mm > L / 2 ? "bottom" : "top");
              let x1 = door.x_mm - dw / 2;
              let y1 = door.y_mm;
              let x2 = door.x_mm + dw / 2;
              let y2 = door.y_mm;

              if (wall === "left" || wall === "right") {
                x1 = door.x_mm;
                y1 = door.y_mm - dw / 2;
                x2 = door.x_mm;
                y2 = door.y_mm + dw / 2;
              }

              return (
                <g key={`door-${door.id}`}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="var(--warning)"
                    strokeWidth={24}
                    strokeLinecap="round"
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 + (wall === "bottom" ? 140 : -60)}
                    textAnchor="middle"
                    className="font-sans text-[100px] font-medium fill-warning-foreground"
                  >
                    {door.name}
                  </text>
                </g>
              );
            })}

          {/* Walls and Perimeter */}
          <rect
            x={0}
            y={0}
            width={W}
            height={L}
            rx={40}
            fill="none"
            className="stroke-foreground/70"
            strokeWidth={16}
          />
        </svg>

        {/* Hover Readout Tooltip */}
        {hoveredCell && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border bg-card/95 px-3 py-1.5 text-xs shadow-md backdrop-blur-sm">
            <div className="font-semibold text-foreground">
              Grid Cell [{hoveredCell.col}, {hoveredCell.row}]
            </div>
            <div className="text-muted-foreground">
              Traversals:{" "}
              <span className="font-mono font-medium text-foreground">{hoveredCell.count}</span> •
              Density:{" "}
              <span className="font-mono font-medium text-foreground">
                {Math.round(hoveredCell.density * 100)}%
              </span>
            </div>
          </div>
        )}

        {/* Color Scale Legend */}
        <div className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-lg border bg-card/95 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur-sm">
          <span className="text-muted-foreground">Low</span>
          <span className="size-2.5 rounded-sm bg-sky-500/50" />
          <span className="size-2.5 rounded-sm bg-emerald-500/60" />
          <span className="size-2.5 rounded-sm bg-amber-500/70" />
          <span className="size-2.5 rounded-sm bg-red-500/80" />
          <span className="text-muted-foreground">High</span>
        </div>
      </div>

      {/* Frequently Traversed Areas Table */}
      {heatmapData.frequentlyTraversedAreas.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Frequently Traversed Areas (Top Traffic Corridors)
          </h4>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {heatmapData.frequentlyTraversedAreas.map((area, idx) => (
              <div key={idx} className="rounded-lg border bg-muted/30 p-2.5 text-xs">
                <div className="flex items-center justify-between font-medium text-foreground">
                  <span>{area.label}</span>
                  <span className="font-mono text-primary">{area.relativeDensityPct}% share</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {area.pointCount.toLocaleString()} detections binned
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

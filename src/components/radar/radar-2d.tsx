import { useId } from "react";
import type { Door, LD2450Target, RoomObject, RoomZone } from "@/lib/radar/types";
import { arcPoints, rotatedRectCorners, targetToRoom } from "@/lib/radar/iso";
import { targetColor, targetLabel } from "@/lib/radar/palette";

const FOV_DEG = 60; // LD2450: +/-60 degrees horizontally

export interface Radar2DProps {
  room: {
    width_mm: number;
    length_mm: number;
    zones?: RoomZone[] | undefined;
    objects?: RoomObject[] | undefined;
    doors?: Door[] | undefined;
  };
  targets: LD2450Target[];
  /** Recent sensor-relative positions per target id (oldest first). */
  trails?: Record<number, Array<{ x_mm: number; y_mm: number }>> | undefined;
  show: { targets: boolean; grid: boolean; trajectory: boolean };
  selectedId?: number | null | undefined;
  onSelect?: ((id: number | null) => void) | undefined;
  stale?: boolean | undefined;
  className?: string | undefined;
}

const OBJECT_COLOR: Record<string, string> = {
  bed: "#60a5fa",
  couch: "#818cf8",
  sofa: "#818cf8",
  table: "#38bdf8",
  desk: "#38bdf8",
  stove: "#f87171",
  stairs: "#a78bfa",
  window: "#7dd3fc",
  door: "#7dd3fc",
};
const ZONE_COLOR: Record<string, string> = {
  hazard: "#f87171",
  restricted: "#fb923c",
  entry: "#34d399",
  bed: "#60a5fa",
  sofa: "#818cf8",
  bathroom: "#2dd4bf",
  custom: "#38bdf8",
};

/** Dark, top-down floor plan: furniture, doors, zones, the sensor's field of view and tracked people. */
export function Radar2D({
  room,
  targets,
  trails,
  show,
  selectedId,
  onSelect,
  stale,
  className,
}: Radar2DProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const W = Math.max(500, room.width_mm);
  const L = Math.max(500, room.length_mm);
  const pad = Math.max(W, L) * 0.07;
  const fs = Math.max(W, L) / 34; // base text size, in mm
  const sw = Math.max(W, L) / 420; // base stroke width

  const maxR = Math.min(6000, Math.hypot(W, L));
  const ringStep = maxR <= 3200 ? 500 : 1000;
  const rings: number[] = [];
  for (let r = ringStep; r <= maxR; r += ringStep) rings.push(r);

  const inRoom = (p: { x: number; y: number }) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= L;
  const ringPath = (r: number) => {
    const ps = arcPoints(W / 2, 0, r, -FOV_DEG, FOV_DEG, 48).filter(inRoom);
    if (ps.length < 2) return "";
    return ps.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ");
  };
  const cone = [
    { x: W / 2, y: 0 },
    ...arcPoints(W / 2, 0, maxR, -FOV_DEG, FOV_DEG, 40).map((p) => ({
      x: Math.min(W, Math.max(0, p.x)),
      y: Math.min(L, Math.max(0, p.y)),
    })),
  ];

  const gridLines: number[] = [];
  for (let g = 1000; g < W; g += 1000) gridLines.push(g);
  const gridLinesY: number[] = [];
  for (let g = 1000; g < L; g += 1000) gridLinesY.push(g);

  // a door as a gap in the wall plus the swing of the leaf
  const doorShape = (d: Door) => {
    const wall =
      d.wall ??
      (Object.entries({ top: d.y_mm, bottom: L - d.y_mm, left: d.x_mm, right: W - d.x_mm }).sort(
        (a, c) => a[1] - c[1],
      )[0]?.[0] as "top" | "bottom" | "left" | "right");
    const w = d.width_mm;
    if (wall === "top" || wall === "bottom") {
      const y = wall === "top" ? 0 : L;
      const dir = wall === "top" ? 1 : -1;
      const x0 = d.x_mm - w / 2;
      return {
        gap: { x1: x0, y1: y, x2: x0 + w, y2: y },
        arc: `M${x0 + w},${y} A${w},${w} 0 0 ${wall === "top" ? 1 : 0} ${x0 + w},${y + dir * w}`,
        leaf: { x1: x0 + w, y1: y, x2: x0 + w, y2: y + dir * w },
        label: { x: d.x_mm, y: y + dir * (w + fs * 0.9) },
      };
    }
    const x = wall === "left" ? 0 : W;
    const dir = wall === "left" ? 1 : -1;
    const y0 = d.y_mm - w / 2;
    return {
      gap: { x1: x, y1: y0, x2: x, y2: y0 + w },
      arc: `M${x},${y0 + w} A${w},${w} 0 0 ${wall === "left" ? 0 : 1} ${x + dir * w},${y0 + w}`,
      leaf: { x1: x, y1: y0 + w, x2: x + dir * w, y2: y0 + w },
      label: { x: x + dir * (w + fs), y: d.y_mm },
    };
  };

  return (
    <svg
      viewBox={`${-pad} ${-pad * 1.6} ${W + pad * 2} ${L + pad * 2.8}`}
      className={className}
      role="img"
      aria-label={`2D top view, ${targets.length} ${targets.length === 1 ? "person" : "people"} detected`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={`cone-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0.32" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0.03" />
        </linearGradient>
        <filter id={`glow-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation={sw * 2.4} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id={`room-${uid}`}>
          <rect x="0" y="0" width={W} height={L} rx={sw * 3} />
        </clipPath>
      </defs>

      {/* floor */}
      <rect x="0" y="0" width={W} height={L} rx={sw * 3} fill="#0a1a4f" fillOpacity="0.85" />

      <g clipPath={`url(#room-${uid})`}>
        {show.grid && (
          <g stroke="#38bdf8" strokeOpacity="0.1" strokeWidth={sw * 0.8}>
            {gridLines.map((x) => (
              <line key={`gx${x}`} x1={x} y1={0} x2={x} y2={L} />
            ))}
            {gridLinesY.map((y) => (
              <line key={`gy${y}`} x1={0} y1={y} x2={W} y2={y} />
            ))}
          </g>
        )}

        <polygon
          points={cone.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ")}
          fill={`url(#cone-${uid})`}
        />
        <g stroke="#38bdf8" strokeOpacity="0.45" strokeWidth={sw * 0.9} fill="none">
          <line
            x1={W / 2}
            y1={0}
            x2={cone[1]!.x}
            y2={cone[1]!.y}
            strokeDasharray={`${sw * 5} ${sw * 4}`}
          />
          <line
            x1={W / 2}
            y1={0}
            x2={cone[cone.length - 1]!.x}
            y2={cone[cone.length - 1]!.y}
            strokeDasharray={`${sw * 5} ${sw * 4}`}
          />
        </g>

        {show.grid &&
          rings.map((r) => (
            <path
              key={`ring-${r}`}
              d={ringPath(r)}
              fill="none"
              stroke="#7dd3fc"
              strokeOpacity="0.35"
              strokeWidth={sw}
              strokeDasharray={`${sw * 4} ${sw * 5}`}
            />
          ))}

        {/* zones */}
        {(room.zones ?? [])
          .filter((z) => z.polygon.length >= 3)
          .map((z) => {
            const c = ZONE_COLOR[z.type] ?? "#38bdf8";
            const cx = z.polygon.reduce((s, p) => s + p.x_mm, 0) / z.polygon.length;
            const cy = z.polygon.reduce((s, p) => s + p.y_mm, 0) / z.polygon.length;
            return (
              <g key={z.id}>
                <polygon
                  points={z.polygon.map((p) => `${p.x_mm},${p.y_mm}`).join(" ")}
                  fill={c}
                  fillOpacity="0.2"
                  stroke={c}
                  strokeOpacity="0.9"
                  strokeWidth={sw * 1.4}
                  strokeDasharray={`${sw * 5} ${sw * 3}`}
                />
                <text
                  x={cx}
                  y={cy}
                  fontSize={fs * 0.8}
                  fill={c}
                  textAnchor="middle"
                  fontWeight="600"
                >
                  {z.name}
                </text>
              </g>
            );
          })}

        {/* furniture */}
        {(room.objects ?? []).map((o) => {
          const c = OBJECT_COLOR[o.type] ?? "#60a5fa";
          const pts = rotatedRectCorners(o.x_mm, o.y_mm, o.width_mm, o.length_mm, o.rotation_deg);
          return (
            <g key={o.id}>
              <polygon
                points={pts.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ")}
                fill={c}
                fillOpacity="0.28"
                stroke={c}
                strokeOpacity="0.85"
                strokeWidth={sw * 1.3}
              />
              <text
                x={o.x_mm}
                y={o.y_mm + fs * 0.3}
                fontSize={fs * 0.75}
                fill="#e0f2fe"
                fillOpacity="0.85"
                textAnchor="middle"
              >
                {o.name}
              </text>
            </g>
          );
        })}
      </g>

      {/* walls */}
      <rect
        x="0"
        y="0"
        width={W}
        height={L}
        rx={sw * 3}
        fill="none"
        stroke="#93c5fd"
        strokeOpacity="0.95"
        strokeWidth={sw * 3.2}
      />

      {/* doors */}
      {(room.doors ?? []).map((d) => {
        const s = doorShape(d);
        return (
          <g key={d.id}>
            <line {...s.gap} stroke="#0a1a4f" strokeWidth={sw * 4.4} />
            <path d={s.arc} fill="none" stroke="#e0f2fe" strokeOpacity="0.8" strokeWidth={sw} />
            <line {...s.leaf} stroke="#e0f2fe" strokeWidth={sw * 1.6} strokeLinecap="round" />
            <text
              x={s.label.x}
              y={s.label.y}
              fontSize={fs * 0.7}
              fill="#bae6fd"
              fillOpacity="0.9"
              textAnchor="middle"
            >
              {d.name}
            </text>
          </g>
        );
      })}

      {/* sensor */}
      <g>
        <rect
          x={W / 2 - fs * 0.9}
          y={-fs * 0.9}
          width={fs * 1.8}
          height={fs * 1.2}
          rx={fs * 0.3}
          fill="#0b1b4d"
          stroke="#38bdf8"
          strokeWidth={sw * 1.4}
        />
        <circle cx={W / 2} cy={-fs * 0.3} r={fs * 0.28} fill="#7dd3fc" />
        <text
          x={W / 2}
          y={-fs * 1.25}
          fontSize={fs * 0.8}
          fill="#cbd5e1"
          textAnchor="middle"
          fontWeight="600"
        >
          LD2450
        </text>
      </g>

      {/* trails */}
      {show.trajectory &&
        Object.entries(trails ?? {}).map(([id, tr]) =>
          tr.length > 1 ? (
            <polyline
              key={`trail-${id}`}
              points={tr
                .map((t) => {
                  const r = targetToRoom(W, t);
                  return `${r.x.toFixed(0)},${r.y.toFixed(0)}`;
                })
                .join(" ")}
              fill="none"
              stroke={targetColor(Number(id))}
              strokeOpacity="0.75"
              strokeWidth={sw * 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${sw * 5} ${sw * 4}`}
            />
          ) : null,
        )}

      {/* people */}
      {show.targets && (
        <g opacity={stale ? 0.4 : 1}>
          {targets.map((t) => {
            const r = targetToRoom(W, t);
            const col = targetColor(t.target_id);
            const sel = selectedId === t.target_id;
            const x = Math.min(W - fs, Math.max(fs, r.x));
            const y = Math.min(L - fs, Math.max(fs, r.y));
            return (
              <g
                key={`t-${t.target_id}`}
                onClick={() => onSelect?.(sel ? null : t.target_id)}
                style={{ cursor: onSelect ? "pointer" : "default" }}
              >
                {sel && (
                  <circle
                    cx={x}
                    cy={y}
                    r={fs * 1.5}
                    fill="none"
                    stroke={col}
                    strokeOpacity="0.6"
                    strokeWidth={sw * 1.4}
                  />
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={fs * 1.05}
                  fill={col}
                  fillOpacity="0.2"
                  stroke={col}
                  strokeWidth={sw * 1.2}
                />
                <circle cx={x} cy={y} r={fs * 0.55} fill={col} filter={`url(#glow-${uid})`} />
                <circle cx={x} cy={y} r={fs * 0.2} fill="#fff" fillOpacity="0.9" />
                <g transform={`translate(${x + fs * 1.3} ${y - fs * 0.8})`}>
                  <rect
                    width={fs * 2.5}
                    height={fs * 1.6}
                    rx={fs * 0.4}
                    fill="#0a1740"
                    fillOpacity="0.92"
                    stroke={col}
                    strokeOpacity="0.7"
                    strokeWidth={sw}
                  />
                  <text
                    x={fs * 1.25}
                    y={fs * 1.15}
                    fontSize={fs * 0.95}
                    fontWeight="700"
                    fill="#f8fafc"
                    textAnchor="middle"
                  >
                    {targetLabel(t.target_id)}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      )}

      {/* scale bar */}
      <g transform={`translate(${W - 1000 - fs} ${L + pad * 0.95})`}>
        <line x1={0} y1={0} x2={1000} y2={0} stroke="#cbd5e1" strokeWidth={sw * 1.4} />
        <line x1={0} y1={-fs * 0.3} x2={0} y2={fs * 0.3} stroke="#cbd5e1" strokeWidth={sw * 1.4} />
        <line
          x1={1000}
          y1={-fs * 0.3}
          x2={1000}
          y2={fs * 0.3}
          stroke="#cbd5e1"
          strokeWidth={sw * 1.4}
        />
        <text
          x={500}
          y={-fs * 0.6}
          fontSize={fs * 0.85}
          fill="#cbd5e1"
          textAnchor="middle"
          fontWeight="600"
        >
          1 m
        </text>
      </g>
    </svg>
  );
}

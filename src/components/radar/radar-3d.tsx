import { useId, useMemo } from "react";
import type { Door, LD2450Target, RD61Point, RoomObject, RoomZone } from "@/lib/radar/types";
import {
  arcPoints,
  boundsOf,
  makeProjector,
  OBJECT_HEIGHT_MM,
  rotatedRectCorners,
  targetToRoom,
  type Pt2,
  type Pt3,
  type RadarView,
} from "@/lib/radar/iso";

const WALL_H = 2500;
const SENSOR_H = 1800;
const PERSON_H = 1700;
const FOV_DEG = 60; // LD2450: +/-60 degrees horizontally

export interface Radar3DProps {
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
  /** RD-61 reflections, sensor-relative. Drawn as floor footprints only. */
  points?: RD61Point[] | undefined;
  view: RadarView;
  show: { targets: boolean; grid: boolean; pointCloud: boolean; trajectory: boolean };
  hub: { label: string; online: boolean } | null;
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
};
const ZONE_COLOR: Record<string, string> = {
  hazard: "#f87171",
  restricted: "#fb923c",
  bed: "#60a5fa",
  sofa: "#818cf8",
  bathroom: "#2dd4bf",
  custom: "#38bdf8",
};

function inside(p: Pt2, w: number, l: number) {
  return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= l;
}

export function Radar3D({
  room,
  targets,
  trails,
  points,
  view,
  show,
  hub,
  selectedId,
  onSelect,
  stale,
  className,
}: Radar3DProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const W = Math.max(500, room.width_mm);
  const L = Math.max(500, room.length_mm);

  const scene = useMemo(() => {
    const P = makeProjector(view);
    const xy = (p: Pt3) => {
      const q = P(p);
      return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    };
    const poly = (ps: Pt3[]) => ps.map(xy).join(" ");
    const at = (x: number, y: number, z = 0) => P({ x, y, z });

    const keyPts: Pt2[] = [
      at(0, 0),
      at(W, 0),
      at(W, L),
      at(0, L),
      at(0, 0, WALL_H),
      at(W, 0, WALL_H),
      at(W, L, WALL_H),
      at(0, L, WALL_H),
      at(W / 2, 0, SENSOR_H),
    ];
    const b = boundsOf(keyPts);
    const pad = b.w * 0.08;
    const fs = b.w / 46;
    const sw = b.w / 750;
    return { P, poly, at, b, pad, fs, sw, xy };
  }, [view, W, L]);

  const { P, poly, at, b, pad, fs, sw } = scene;
  const sideOn = view !== "top";
  const full = view === "perspective";
  const maxR = Math.min(6000, Math.hypot(W, L));
  const ringStep = maxR <= 3200 ? 500 : 1000;
  const rings: number[] = [];
  for (let r = ringStep; r <= maxR; r += ringStep) rings.push(r);

  const floor3: Pt3[] = [
    { x: 0, y: 0, z: 0 },
    { x: W, y: 0, z: 0 },
    { x: W, y: L, z: 0 },
    { x: 0, y: L, z: 0 },
  ];

  const ringPath = (r: number) => {
    const ps = arcPoints(W / 2, 0, r, -FOV_DEG, FOV_DEG, 40).filter((p) => inside(p, W, L));
    if (ps.length < 2) return "";
    return ps.map((p, i) => `${i ? "L" : "M"}${scene.xy({ x: p.x, y: p.y, z: 0 })}`).join(" ");
  };
  const fov = arcPoints(W / 2, 0, maxR, -FOV_DEG, FOV_DEG, 40).map((p) => ({
    x: Math.min(W, Math.max(0, p.x)),
    y: Math.min(L, Math.max(0, p.y)),
    z: 0,
  }));
  const hubTop = at(W / 2, 0, SENSOR_H);
  const hubFoot = at(W / 2, 0, 0);

  const objects = [...(room.objects ?? [])].sort(
    (a, c) => P({ x: a.x_mm, y: a.y_mm, z: 0 }).depth - P({ x: c.x_mm, y: c.y_mm, z: 0 }).depth,
  );

  const doorPoly = (d: Door): Pt3[] | null => {
    const half = d.width_mm / 2;
    const wall =
      d.wall ??
      (() => {
        const dist = { top: d.y_mm, bottom: L - d.y_mm, left: d.x_mm, right: W - d.x_mm };
        return (Object.entries(dist).sort((a, c) => a[1] - c[1])[0]?.[0] ?? "top") as
          "top" | "bottom" | "left" | "right";
      })();
    const h = 2000;
    if (wall === "top" || wall === "bottom") {
      const y = wall === "top" ? 0 : L;
      return [
        { x: d.x_mm - half, y, z: 0 },
        { x: d.x_mm + half, y, z: 0 },
        { x: d.x_mm + half, y, z: h },
        { x: d.x_mm - half, y, z: h },
      ];
    }
    const x = wall === "left" ? 0 : W;
    return [
      { x, y: d.y_mm - half, z: 0 },
      { x, y: d.y_mm + half, z: 0 },
      { x, y: d.y_mm + half, z: h },
      { x, y: d.y_mm - half, z: h },
    ];
  };

  const tg = [...targets].sort(
    (a, c) => P({ ...targetToRoom(W, a), z: 0 }).depth - P({ ...targetToRoom(W, c), z: 0 }).depth,
  );

  return (
    <svg
      viewBox={`${b.minX - scene.pad} ${b.minY - scene.pad} ${b.w + scene.pad * 2} ${b.h + scene.pad * 2}`}
      className={className}
      role="img"
      aria-label={`3D room view, ${targets.length} ${targets.length === 1 ? "person" : "people"} detected`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={`floor-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d4ed8" stopOpacity="0.38" />
          <stop offset="1" stopColor="#0ea5e9" stopOpacity="0.14" />
        </linearGradient>
        <linearGradient id={`fov-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0.5" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0.04" />
        </linearGradient>
        <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={sw * 5} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* floor */}
      <polygon
        points={poly(floor3)}
        fill={`url(#floor-${uid})`}
        stroke="#38bdf8"
        strokeOpacity="0.8"
        strokeWidth={sw * 1.6}
      />

      {/* back walls (perspective only) */}
      {full && (
        <g
          fill="#38bdf8"
          fillOpacity="0.07"
          stroke="#38bdf8"
          strokeOpacity="0.5"
          strokeWidth={sw * 1.2}
        >
          <polygon
            points={poly([
              { x: 0, y: 0, z: 0 },
              { x: W, y: 0, z: 0 },
              { x: W, y: 0, z: WALL_H },
              { x: 0, y: 0, z: WALL_H },
            ])}
          />
          <polygon
            points={poly([
              { x: 0, y: 0, z: 0 },
              { x: 0, y: L, z: 0 },
              { x: 0, y: L, z: WALL_H },
              { x: 0, y: 0, z: WALL_H },
            ])}
          />
        </g>
      )}

      {/* front-facing elevation frames for side views */}
      {sideOn && !full && (
        <rect
          x={Math.min(at(0, 0, WALL_H).x, at(W, L, 0).x)}
          y={at(0, 0, WALL_H).y}
          width={Math.abs(at(W, L, 0).x - at(0, 0, 0).x) || 1}
          height={WALL_H}
          fill="none"
          stroke="#38bdf8"
          strokeOpacity="0.35"
          strokeWidth={sw}
          strokeDasharray={`${sw * 6} ${sw * 6}`}
        />
      )}

      {/* doors */}
      {(room.doors ?? []).map((d) => {
        const dp = doorPoly(d);
        if (!dp) return null;
        return (
          <polygon
            key={`door-${d.id}`}
            points={poly(dp)}
            fill="#fbbf24"
            fillOpacity="0.12"
            stroke="#fbbf24"
            strokeOpacity="0.8"
            strokeWidth={sw * 1.2}
            strokeDasharray={`${sw * 5} ${sw * 4}`}
          />
        );
      })}

      {/* zones */}
      {(room.zones ?? []).map((z) => {
        if (z.polygon.length < 3) return null;
        const c = z.color ?? ZONE_COLOR[z.type] ?? "#38bdf8";
        return (
          <polygon
            key={`zone-${z.id}`}
            points={poly(z.polygon.map((p) => ({ x: p.x_mm, y: p.y_mm, z: 0 })))}
            fill={c}
            fillOpacity="0.12"
            stroke={c}
            strokeOpacity="0.7"
            strokeWidth={sw}
            strokeDasharray={`${sw * 5} ${sw * 4}`}
          />
        );
      })}

      {/* range grid + field of view */}
      {show.grid && (
        <g>
          <polygon
            points={poly(fov.length ? [{ x: W / 2, y: 0, z: 0 }, ...fov] : [])}
            fill={`url(#fov-${uid})`}
            fillOpacity="0.5"
          />
          {rings.map((r) => {
            const d = ringPath(r);
            if (!d) return null;
            const lab = at(W / 2, r, 0);
            return (
              <g key={`ring-${r}`}>
                <path d={d} fill="none" stroke="#7dd3fc" strokeOpacity="0.4" strokeWidth={sw} />
                <text
                  x={lab.x + fs * 0.5}
                  y={lab.y - fs * 0.25}
                  fontSize={fs * 0.82}
                  fill="#7dd3fc"
                  fillOpacity="0.85"
                  fontFamily="ui-monospace, monospace"
                >
                  {(r / 1000).toFixed(1)} m
                </text>
              </g>
            );
          })}
        </g>
      )}

      {/* furniture */}
      {objects.map((o) => {
        if (o.type === "door" || o.type === "window") return null;
        const corners = rotatedRectCorners(o.x_mm, o.y_mm, o.width_mm, o.length_mm, o.rotation_deg);
        const h = OBJECT_HEIGHT_MM[o.type] ?? 600;
        const col = OBJECT_COLOR[o.type] ?? "#38bdf8";
        const bottom = corners.map((c) => ({ ...c, z: 0 }));
        const top = corners.map((c) => ({ ...c, z: h }));
        const sides = corners
          .map((_, i) => {
            const j = (i + 1) % 4;
            const face = [bottom[i]!, bottom[j]!, top[j]!, top[i]!];
            const depth = face.reduce((s, p) => s + P(p).depth, 0) / 4;
            return { face, depth, i };
          })
          .sort((a, c) => a.depth - c.depth);
        const topC = at(o.x_mm, o.y_mm, h);
        return (
          <g key={`obj-${o.id}`}>
            {sides.map((s) => (
              <polygon
                key={s.i}
                points={poly(s.face)}
                fill={col}
                fillOpacity="0.16"
                stroke={col}
                strokeOpacity="0.85"
                strokeWidth={sw * 1.1}
                strokeLinejoin="round"
              />
            ))}
            <polygon
              points={poly(top)}
              fill={col}
              fillOpacity="0.3"
              stroke={col}
              strokeOpacity="0.95"
              strokeWidth={sw * 1.3}
              strokeLinejoin="round"
            />
            {view === "top" && (
              <text
                x={topC.x}
                y={topC.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={fs * 0.8}
                fill="#e0f2fe"
                fillOpacity="0.85"
              >
                {o.name}
              </text>
            )}
          </g>
        );
      })}

      {/* front rim of the room (perspective) */}
      {full && (
        <g stroke="#38bdf8" strokeOpacity="0.55" strokeWidth={sw * 1.1} fill="none">
          <polyline
            points={poly([
              { x: W, y: 0, z: WALL_H },
              { x: W, y: L, z: WALL_H },
              { x: 0, y: L, z: WALL_H },
            ])}
          />
          <line
            x1={at(W, 0, 0).x}
            y1={at(W, 0, 0).y}
            x2={at(W, 0, WALL_H).x}
            y2={at(W, 0, WALL_H).y}
          />
          <line
            x1={at(W, L, 0).x}
            y1={at(W, L, 0).y}
            x2={at(W, L, WALL_H).x}
            y2={at(W, L, WALL_H).y}
          />
          <line
            x1={at(0, L, 0).x}
            y1={at(0, L, 0).y}
            x2={at(0, L, WALL_H).x}
            y2={at(0, L, WALL_H).y}
          />
        </g>
      )}

      {/* trails */}
      {show.trajectory &&
        Object.entries(trails ?? {}).map(([id, tr]) =>
          tr.length > 1 ? (
            <polyline
              key={`trail-${id}`}
              points={tr
                .map((t) => {
                  const r = targetToRoom(W, t);
                  return scene.xy({ x: r.x, y: r.y, z: 0 });
                })
                .join(" ")}
              fill="none"
              stroke="#34d399"
              strokeOpacity="0.7"
              strokeWidth={sw * 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${sw * 5} ${sw * 5}`}
            />
          ) : null,
        )}

      {/* RD-61 reflections (floor footprints) */}
      {show.pointCloud &&
        (points ?? []).map((p, i) => {
          const r = targetToRoom(W, { x_mm: p.x_mm, y_mm: p.y_mm });
          const q = at(r.x, r.y, 0);
          return (
            <circle
              key={`pc-${i}`}
              cx={q.x}
              cy={q.y}
              r={sw * 3.2}
              fill="#22d3ee"
              fillOpacity="0.75"
            />
          );
        })}

      {/* radar hub */}
      {hub && (
        <g>
          <line
            x1={hubTop.x}
            y1={hubTop.y}
            x2={hubFoot.x}
            y2={hubFoot.y}
            stroke="#7dd3fc"
            strokeOpacity="0.35"
            strokeWidth={sw}
            strokeDasharray={`${sw * 3} ${sw * 4}`}
          />
          {show.grid && fov.length > 1 && view !== "top" && (
            <g stroke="#38bdf8" strokeOpacity="0.45" strokeWidth={sw}>
              <line x1={hubTop.x} y1={hubTop.y} x2={P(fov[0]!).x} y2={P(fov[0]!).y} />
              <line
                x1={hubTop.x}
                y1={hubTop.y}
                x2={P(fov[fov.length - 1]!).x}
                y2={P(fov[fov.length - 1]!).y}
              />
            </g>
          )}
          <circle
            cx={hubTop.x}
            cy={hubTop.y}
            r={fs * 0.75}
            fill="#0b1b4d"
            stroke="#38bdf8"
            strokeWidth={sw * 2}
            filter={`url(#glow-${uid})`}
          />
          <circle cx={hubTop.x} cy={hubTop.y} r={fs * 0.28} fill="#7dd3fc" />
          <g
            transform={`translate(${hubTop.x + fs * 1.4} ${view === "top" ? hubTop.y + fs * 1.2 : hubTop.y - fs * 3.2})`}
          >
            <rect
              width={fs * 8.6}
              height={fs * 2.7}
              rx={fs * 0.6}
              fill="#0a1740"
              fillOpacity="0.92"
              stroke="#38bdf8"
              strokeOpacity="0.8"
              strokeWidth={sw}
            />
            <text x={fs * 0.7} y={fs * 1.1} fontSize={fs * 0.95} fontWeight="700" fill="#f1f5f9">
              {hub.label}
            </text>
            <circle
              cx={fs * 0.95}
              cy={fs * 1.95}
              r={fs * 0.3}
              fill={hub.online ? "#22c55e" : "#94a3b8"}
            />
            <text
              x={fs * 1.5}
              y={fs * 2.2}
              fontSize={fs * 0.78}
              fill={hub.online ? "#4ade80" : "#cbd5e1"}
            >
              ESP32 • {hub.online ? "Online" : "Offline"}
            </text>
          </g>
        </g>
      )}

      {/* tracked people */}
      {show.targets && (
        <g opacity={stale ? 0.4 : 1}>
          {tg.map((t) => {
            const r = targetToRoom(W, t);
            const foot = at(r.x, r.y, 0);
            const head = at(r.x, r.y, PERSON_H);
            const sel = selectedId === t.target_id;
            const ring = arcPoints(r.x, r.y, 330, 0, 360, 24).map((p) =>
              scene.xy({ x: p.x, y: p.y, z: 0 }),
            );
            const labelX = (view === "top" ? foot.x : head.x) + fs * 1.6;
            const labelY = (view === "top" ? foot.y : head.y) - fs * 0.5;
            const idStr = String(t.target_id).padStart(2, "0");
            return (
              <g
                key={`t-${t.target_id}`}
                onClick={() => onSelect?.(sel ? null : t.target_id)}
                style={{ cursor: onSelect ? "pointer" : "default" }}
                filter={`url(#glow-${uid})`}
              >
                <polygon
                  points={ring.join(" ")}
                  fill="#34d399"
                  fillOpacity="0.25"
                  stroke="#34d399"
                  strokeOpacity="0.9"
                  strokeWidth={sw * (sel ? 3 : 1.6)}
                />
                {view !== "top" &&
                  (() => {
                    // A simple standing figure: two legs, torso, head (about 1.7 m tall).
                    const spread = 130;
                    const side = view === "right" ? { x: 0, y: spread } : { x: spread, y: 0 };
                    const hipL = at(r.x - side.x, r.y - side.y, 880);
                    const hipR = at(r.x + side.x, r.y + side.y, 880);
                    const footL = at(r.x - side.x * 1.3, r.y - side.y * 1.3, 0);
                    const footR = at(r.x + side.x * 1.3, r.y + side.y * 1.3, 0);
                    const hip = at(r.x, r.y, 900);
                    const neck = at(r.x, r.y, 1450);
                    const headC = at(r.x, r.y, 1620);
                    return (
                      <g stroke="#34d399" strokeLinecap="round" fill="none">
                        <line
                          x1={footL.x}
                          y1={footL.y}
                          x2={hipL.x}
                          y2={hipL.y}
                          strokeOpacity="0.6"
                          strokeWidth={fs * 0.6}
                        />
                        <line
                          x1={footR.x}
                          y1={footR.y}
                          x2={hipR.x}
                          y2={hipR.y}
                          strokeOpacity="0.6"
                          strokeWidth={fs * 0.6}
                        />
                        <line
                          x1={hip.x}
                          y1={hip.y}
                          x2={neck.x}
                          y2={neck.y}
                          strokeOpacity="0.7"
                          strokeWidth={fs * 1.25}
                        />
                        <circle
                          cx={headC.x}
                          cy={headC.y}
                          r={fs * 0.7}
                          fill="#6ee7b7"
                          fillOpacity="0.9"
                          stroke="none"
                        />
                      </g>
                    );
                  })()}
                <g transform={`translate(${labelX} ${labelY})`} filter="none">
                  <rect
                    width={fs * 8.2}
                    height={fs * 2.9}
                    rx={fs * 0.6}
                    fill="#0a1740"
                    fillOpacity="0.92"
                    stroke={sel ? "#6ee7b7" : "#34d399"}
                    strokeOpacity="0.9"
                    strokeWidth={sw * (sel ? 2.4 : 1.2)}
                  />
                  <text x={fs * 0.7} y={fs * 1.2} fontSize={fs} fontWeight="700" fill="#f8fafc">
                    ID: {idStr}
                  </text>
                  <text x={fs * 0.7} y={fs * 2.3} fontSize={fs * 0.78} fill="#94a3b8">
                    ({(t.x_mm / 1000).toFixed(1)} m, {(t.y_mm / 1000).toFixed(1)} m)
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}

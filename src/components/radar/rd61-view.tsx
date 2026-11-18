import { useEffect, useRef, useState } from "react";
import type { Door, RD61Frame, RD61Point, RoomObject, RoomZone } from "@/lib/radar/types";

interface Props {
  widthMm: number;
  lengthMm: number;
  frame: RD61Frame | undefined;
  /** How many past frames to keep on screen. */
  persistence?: number;
  height?: number;
  compact?: boolean;
  doors?: Door[] | undefined;
  zones?: RoomZone[] | undefined;
  objects?: RoomObject[] | undefined;
  showZones?: boolean | undefined;
  showObjects?: boolean | undefined;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** RD-61 point cloud (top-down x/y). Colour = motion, size = SNR, with short persistence. */
export function RD61View({
  widthMm: W,
  lengthMm: L,
  frame,
  persistence = 6,
  height = 460,
  compact,
  doors,
  zones,
  objects,
  showZones = true,
  showObjects = true,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<RD61Frame[]>([]);
  const [hover, setHover] = useState<{ p: RD61Point; x: number; y: number } | null>(null);

  useEffect(() => {
    if (frame) {
      history.current.push(frame);
      while (history.current.length > persistence) history.current.shift();
    } else history.current = [];
    const c = canvas.current;
    const wrapEl = wrap.current;
    if (!c || !wrapEl) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = wrapEl.clientWidth;
    const ch = height;
    c.width = Math.max(1, Math.floor(cw * dpr));
    c.height = Math.floor(ch * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = compact ? 12 : 30;
    const k = Math.min((cw - pad * 2) / W, (ch - pad * 2) / L);
    const ox = (cw - W * k) / 2;
    const oy = (ch - L * k) / 2;
    const floor = cssVar("--radar-floor");
    const floor2 = cssVar("--radar-floor-2");
    const grid = cssVar("--grid");
    const gridStrong = cssVar("--grid-strong");
    const wall = cssVar("--radar-wall");
    const range = cssVar("--radar-range");
    const still = cssVar("--chart-1");
    const moving = cssVar("--chart-3");
    const clutter = cssVar("--muted-foreground");
    const primary = cssVar("--primary");

    const g = ctx.createLinearGradient(0, oy, 0, oy + L * k);
    g.addColorStop(0, floor2);
    g.addColorStop(1, floor);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(ox, oy, W * k, L * k, 8);
    ctx.fill();

    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 500) {
      ctx.strokeStyle = x % 1000 ? grid : gridStrong;
      ctx.beginPath();
      ctx.moveTo(ox + x * k, oy);
      ctx.lineTo(ox + x * k, oy + L * k);
      ctx.stroke();
    }
    for (let y = 0; y <= L; y += 500) {
      ctx.strokeStyle = y % 1000 ? grid : gridStrong;
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * k);
      ctx.lineTo(ox + W * k, oy + y * k);
      ctx.stroke();
    }

    // range rings from the sensor, clipped to the room
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(ox, oy, W * k, L * k, 8);
    ctx.clip();
    ctx.strokeStyle = range;
    ctx.setLineDash([4, 6]);
    for (let r = 1000; r <= 6000; r += 1000) {
      ctx.beginPath();
      ctx.arc(ox + (W / 2) * k, oy, r * k, 0.1, Math.PI - 0.1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Defined Zones
    if (showZones && zones && zones.length > 0) {
      for (const z of zones) {
        if (z.polygon.length < 3) continue;
        ctx.save();
        ctx.beginPath();
        const first = z.polygon[0]!;
        ctx.moveTo(ox + first.x_mm * k, oy + first.y_mm * k);
        for (let i = 1; i < z.polygon.length; i++) {
          const pt = z.polygon[i]!;
          ctx.lineTo(ox + pt.x_mm * k, oy + pt.y_mm * k);
        }
        ctx.closePath();
        ctx.fillStyle =
          z.type === "hazard"
            ? "rgba(239, 68, 68, 0.16)"
            : z.type === "bed"
              ? "rgba(59, 130, 246, 0.16)"
              : z.type === "sofa"
                ? "rgba(245, 158, 11, 0.16)"
                : "rgba(168, 85, 247, 0.14)";
        ctx.fill();
        ctx.strokeStyle =
          z.type === "hazard"
            ? "#ef4444"
            : z.type === "bed"
              ? "#3b82f6"
              : z.type === "sofa"
                ? "#f59e0b"
                : "#a855f7";
        ctx.lineWidth = 1.5;
        if (z.type === "hazard") ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Defined Furniture & Objects
    if (showObjects && objects && objects.length > 0) {
      for (const obj of objects) {
        ctx.save();
        ctx.translate(ox + obj.x_mm * k, oy + obj.y_mm * k);
        ctx.rotate((obj.rotation_deg * Math.PI) / 180);
        ctx.fillStyle = "rgba(148, 163, 184, 0.12)";
        ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(
          (-obj.width_mm * k) / 2,
          (-obj.length_mm * k) / 2,
          obj.width_mm * k,
          obj.length_mm * k,
          4,
        );
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // walls
    ctx.strokeStyle = wall;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(ox, oy, W * k, L * k, 8);
    ctx.stroke();

    // Configured Doors
    if (doors && doors.length > 0) {
      for (const d of doors) {
        const dW = d.width_mm || 900;
        ctx.save();
        ctx.strokeStyle = wall;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(ox + d.x_mm * k, oy + d.y_mm * k, (dW * k) / 2, 0, Math.PI);
        ctx.stroke();
        ctx.restore();
      }
    }

    // sensor
    ctx.fillStyle = wall;
    ctx.beginPath();
    ctx.roundRect(ox + (W / 2) * k - 11, oy - 5, 22, 9, 3);
    ctx.fill();
    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.arc(ox + (W / 2) * k, oy + 1, 3, 0, Math.PI * 2);
    ctx.fill();

    // points, oldest first
    const n = history.current.length;
    history.current.forEach((f, i) => {
      const age = (i + 1) / n;
      for (const p of f.points) {
        const px = ox + (p.x_mm + W / 2) * k;
        const py = oy + p.y_mm * k;
        if (px < ox || px > ox + W * k || py < oy || py > oy + L * k) continue;
        const lowSnr = p.snr < 7;
        const fast = Math.abs(p.doppler) > 0.15;
        const base = Math.max(lowSnr ? 1.9 : 1.6, Math.min(4.6, p.snr / 5)) * (compact ? 0.8 : 1);
        const rad = base * (0.55 + age * 0.45) * (fast ? 1.15 : 1);
        const color = lowSnr ? clutter : fast ? moving : still;
        ctx.globalAlpha = age * (lowSnr ? 0.5 : 0.85);
        if (!lowSnr && age > 0.75) {
          ctx.globalAlpha = age * 0.16;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, rad * 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = age * (lowSnr ? 0.3 : 0.85);
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;

    if (!compact) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = wall;
      ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = "center";
      for (let x = 0; x <= W; x += 1000) ctx.fillText(`${x / 1000}m`, ox + x * k, oy - 8);
      ctx.textAlign = "right";
      for (let y = 1000; y <= L; y += 1000) ctx.fillText(`${y / 1000}m`, ox - 6, oy + y * k + 3);
      ctx.globalAlpha = 1;
    }
  }, [frame, W, L, persistence, height, compact]);

  const onMove = (e: React.PointerEvent) => {
    const c = canvas.current;
    if (!c || !frame || compact) {
      setHover(null);
      return;
    }
    const rect = c.getBoundingClientRect();
    const pad = 30;
    const k = Math.min((rect.width - pad * 2) / W, (height - pad * 2) / L);
    const ox = (rect.width - W * k) / 2;
    const oy = (height - L * k) / 2;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { p: RD61Point; x: number; y: number } | null = null;
    let bd = 14;
    for (const p of frame.points) {
      const px = ox + (p.x_mm + W / 2) * k;
      const py = oy + p.y_mm * k;
      const d = Math.hypot(px - mx, py - my);
      if (d < bd) {
        bd = d;
        best = { p, x: px, y: py };
      }
    }
    setHover(best);
  };

  return (
    <div
      ref={wrap}
      className="relative overflow-hidden rounded-xl border bg-radar-floor"
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <canvas
        ref={canvas}
        className="block w-full"
        style={{ height }}
        aria-label="RD-61 point cloud"
        role="img"
      />
      {hover && (
        <div
          className="pointer-events-none absolute rounded-md bg-radar-wall/95 px-2 py-1 font-mono text-[10px] leading-tight text-background shadow-raised"
          style={{
            left: Math.min(hover.x + 10, (wrap.current?.clientWidth ?? 300) - 130),
            top: Math.max(4, hover.y - 34),
          }}
        >
          <div>
            x {hover.p.x_mm} · y {hover.p.y_mm} mm
          </div>
          <div className="opacity-70">
            z {hover.p.z_mm} · {hover.p.doppler} m/s · {hover.p.snr} dB
          </div>
        </div>
      )}
      {!compact && (
        <div className="pointer-events-none absolute bottom-2.5 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card/90 px-2.5 py-1.5 text-[11px] text-muted-foreground backdrop-blur">
          <span className="flex items-center gap-1.5">
            <i className="size-2 rounded-full bg-chart-1" />
            static
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2 rounded-full bg-chart-3" />
            moving
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2 rounded-full bg-muted-foreground/60" />
            clutter
          </span>
          <span className="flex items-center gap-1 font-mono">
            <i className="size-1 rounded-full bg-muted-foreground/60" />
            <i className="size-1.5 rounded-full bg-muted-foreground/60" />
            <i className="size-2 rounded-full bg-muted-foreground/60" />
            size = SNR
          </span>
        </div>
      )}
    </div>
  );
}

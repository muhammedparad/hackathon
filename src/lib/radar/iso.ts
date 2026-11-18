// Projection math for the 3D room view. Room coordinates: x across the room (0..width), y away from the
// sensor wall (0..length), z up. The sensor sits at (width / 2, 0) on the y = 0 wall.
import type { ObjectType } from "./types";

export type RadarView = "perspective" | "top" | "front" | "right";

export interface Pt3 {
  x: number;
  y: number;
  z: number;
}
export interface Pt2 {
  x: number;
  y: number;
}
export type Projector = (p: Pt3) => Pt2 & { depth: number };

const C30 = Math.cos(Math.PI / 6);

/** Larger `depth` = closer to the viewer (draw later). */
export function makeProjector(view: RadarView): Projector {
  switch (view) {
    case "perspective":
      return (p) => ({ x: (p.x - p.y) * C30, y: (p.x + p.y) * 0.5 - p.z, depth: p.x + p.y });
    case "top":
      return (p) => ({ x: p.x, y: p.y, depth: p.z });
    case "front": // looking from the open side towards the sensor wall
      return (p) => ({ x: p.x, y: -p.z, depth: p.y });
    case "right": // looking along the x axis
      return (p) => ({ x: p.y, y: -p.z, depth: p.x });
  }
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

export function boundsOf(points: Pt2[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1, w: 1, h: 1 };
  return { minX, minY, maxX, maxY, w: maxX - minX || 1, h: maxY - minY || 1 };
}

/** Typical furniture heights in mm, only used to draw the objects as boxes. */
export const OBJECT_HEIGHT_MM: Record<ObjectType, number> = {
  bed: 550,
  couch: 800,
  sofa: 800,
  table: 750,
  desk: 750,
  stove: 900,
  door: 0,
  window: 0,
  stairs: 900,
};

/** Corners of a rectangle centred at (cx, cy), rotated by `deg` (same convention as the 2D view). */
export function rotatedRectCorners(
  cx: number,
  cy: number,
  w: number,
  l: number,
  deg: number,
): Pt2[] {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [
    [-w / 2, -l / 2],
    [w / 2, -l / 2],
    [w / 2, l / 2],
    [-w / 2, l / 2],
  ].map(([dx, dy]) => ({ x: cx + dx! * cos - dy! * sin, y: cy + dx! * sin + dy! * cos }));
}

/**
 * Points of an arc around the sensor at `radius`, from angle `a0` to `a1` (degrees, 0 = straight ahead
 * along +y, positive = towards +x).
 */
export function arcPoints(
  cx: number,
  cy: number,
  radius: number,
  a0: number,
  a1: number,
  steps = 32,
): Pt2[] {
  const out: Pt2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push({ x: cx + radius * Math.sin(a), y: cy + radius * Math.cos(a) });
  }
  return out;
}

/** Sensor-relative target position (mm) to room coordinates. */
export function targetToRoom(widthMm: number, t: { x_mm: number; y_mm: number }): Pt2 {
  return { x: widthMm / 2 + t.x_mm, y: t.y_mm };
}

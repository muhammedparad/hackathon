import { describe, expect, it } from "vitest";
import {
  arcPoints,
  boundsOf,
  makeProjector,
  rotatedRectCorners,
  targetToRoom,
} from "@/lib/radar/iso";

describe("3D room view projection", () => {
  it("top view is the floor plan", () => {
    const p = makeProjector("top")({ x: 1200, y: 3400, z: 900 });
    expect(p.x).toBe(1200);
    expect(p.y).toBe(3400);
  });

  it("perspective puts the sensor-wall corner at the back (smallest depth) and the far corner in front", () => {
    const P = makeProjector("perspective");
    const back = P({ x: 0, y: 0, z: 0 });
    const front = P({ x: 4000, y: 5000, z: 0 });
    expect(front.depth).toBeGreaterThan(back.depth);
    expect(front.y).toBeGreaterThan(back.y); // lower on screen
  });

  it("raising z moves a point up the screen in every side-on view", () => {
    for (const v of ["perspective", "front", "right"] as const) {
      const P = makeProjector(v);
      expect(P({ x: 1000, y: 1000, z: 1000 }).y).toBeLessThan(P({ x: 1000, y: 1000, z: 0 }).y);
    }
  });

  it("rotating a rectangle by 90 degrees swaps its width and length", () => {
    const c = rotatedRectCorners(1000, 2000, 400, 800, 90);
    const b = boundsOf(c);
    expect(Math.round(b.w)).toBe(800);
    expect(Math.round(b.h)).toBe(400);
    expect(Math.round((b.minX + b.maxX) / 2)).toBe(1000);
    expect(Math.round((b.minY + b.maxY) / 2)).toBe(2000);
  });

  it("an arc at 0 degrees points straight ahead of the sensor", () => {
    const [p] = arcPoints(2000, 0, 1500, 0, 0, 1);
    expect(Math.round(p!.x)).toBe(2000);
    expect(Math.round(p!.y)).toBe(1500);
  });

  it("maps sensor-relative targets into room coordinates (sensor at the middle of the y=0 wall)", () => {
    expect(targetToRoom(4000, { x_mm: -500, y_mm: 1800 })).toEqual({ x: 1500, y: 1800 });
  });

  it("bounds of nothing is a safe unit box", () => {
    expect(boundsOf([]).w).toBe(1);
  });
});

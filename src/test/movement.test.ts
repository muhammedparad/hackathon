import { describe, expect, it } from "vitest";
import { movementPerHour } from "@/lib/analytics/movement";

const day = new Date(2026, 5, 1, 0, 0, 0, 0).getTime(); // local midnight
const at = (h: number, m = 0, s = 0) => day + ((h * 60 + m) * 60 + s) * 1000;
const seg = (pts: Array<[number, number, number]>) => ({
  points: pts.map(([t, x, y]) => ({ t, x, y })),
});

describe("movementPerHour", () => {
  it("counts walking steps in the hour they happened", () => {
    const bins = movementPerHour(
      [
        seg([
          [at(9, 5, 0), 0, 1000],
          [at(9, 5, 1), 300, 1000],
          [at(9, 5, 2), 600, 1000],
          [at(9, 5, 3), 900, 1000],
        ]),
        seg([
          [at(14, 0, 0), 0, 2000],
          [at(14, 0, 1), 0, 2400],
        ]),
      ],
      day,
    );
    expect(bins[9]).toBe(3);
    expect(bins[14]).toBe(1);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("does not count a person sitting still, or sensor jitter", () => {
    const bins = movementPerHour(
      [
        seg([
          [at(10, 0, 0), 500, 2000],
          [at(10, 0, 1), 520, 2010],
          [at(10, 0, 2), 490, 1995],
        ]),
      ],
      day,
    );
    expect(bins.every((n) => n === 0)).toBe(true);
  });

  it("skips jumps across a long silence, and points outside the day", () => {
    const bins = movementPerHour(
      [
        seg([
          [at(8, 0, 0), 0, 1000],
          [at(8, 0, 30), 2000, 3000], // 30 s apart: not one step
        ]),
        seg([
          [day - 2000, 0, 1000],
          [day - 1000, 500, 1000], // yesterday
        ]),
      ],
      day,
    );
    expect(bins.every((n) => n === 0)).toBe(true);
  });

  it("returns 24 empty bins for no tracks", () => {
    expect(movementPerHour([], day)).toEqual(new Array(24).fill(0));
  });
});

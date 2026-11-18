import { describe, expect, it } from "vitest";
import {
  HR_MIN_STILL_MS,
  StillTracker,
  heartRateBlocker,
  heartRateFor,
  heartRatesFor,
} from "@/lib/radar/heart-rate";

const still = (x = 300, y = 1500, id = 1) => ({ target_id: id, x_mm: x, y_mm: y, speed_cms: 0 });

describe("StillTracker", () => {
  it("measures how long someone has been still", () => {
    const tr = new StillTracker();
    expect(tr.update([still()], 0).get(1)).toBe(0);
    expect(tr.update([still()], 4000).get(1)).toBe(4000);
    expect(tr.update([still()], 11_000).get(1)).toBe(11_000);
  });

  it("tolerates small drift but restarts when they actually move", () => {
    const tr = new StillTracker();
    tr.update([still(300, 1500)], 0);
    expect(tr.update([still(340, 1530)], 6000).get(1)).toBe(6000); // jitter
    expect(tr.update([still(900, 1500)], 7000).get(1)).toBe(0); // walked 600 mm
    expect(tr.update([{ target_id: 1, x_mm: 900, y_mm: 1500, speed_cms: 40 }], 8000).get(1)).toBe(
      0,
    );
    expect(tr.update([still(900, 1500)], 20_000).get(1)).toBe(12_000);
  });

  it("forgets people who leave", () => {
    const tr = new StillTracker();
    tr.update([still()], 0);
    tr.update([], 5000);
    expect(tr.update([still()], 9000).get(1)).toBe(0);
  });
});

describe("heart rate rules", () => {
  it("needs the person to be still for 10 s and within 2 m", () => {
    expect(heartRateBlocker({ x_mm: 300, y_mm: 1500 }, HR_MIN_STILL_MS - 1)).toBe("moving");
    expect(heartRateBlocker({ x_mm: 300, y_mm: 1500 }, HR_MIN_STILL_MS)).toBeNull();
    expect(heartRateBlocker({ x_mm: 1500, y_mm: 1800 }, 60_000)).toBe("too_far"); // 2.34 m
    expect(heartRateBlocker({ x_mm: 0, y_mm: 2000 }, 60_000)).toBeNull(); // exactly 2 m
  });

  it("shows nothing when it is not enabled", () => {
    const ts = [still()];
    const stillMs = new Map([[1, 60_000]]);
    expect(heartRatesFor(false, ts, stillMs, 1000)).toEqual([]);
  });

  it("returns a value only for the people who qualify, and marks it not measured", () => {
    const ts = [still(300, 1500, 1), still(300, 1500, 2), still(300, 3000, 3)];
    const stillMs = new Map([
      [1, 15_000],
      [2, 3000],
      [3, 15_000],
    ]);
    const out = heartRatesFor(true, ts, stillMs, 5000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target_id: 1, measured: false });
    expect(out[0]!.heart_rate_bpm).toBeGreaterThanOrEqual(50);
    expect(out[0]!.heart_rate_bpm).toBeLessThanOrEqual(90);
  });

  it("changes slowly and stays in a resting range", () => {
    let prev = heartRateFor(1, 0);
    for (let t = 1000; t < 120_000; t += 1000) {
      const bpm = heartRateFor(1, t);
      expect(bpm).toBeGreaterThanOrEqual(50);
      expect(bpm).toBeLessThanOrEqual(90);
      expect(Math.abs(bpm - prev)).toBeLessThanOrEqual(3);
      prev = bpm;
    }
  });
});

import { describe, expect, it } from "vitest";
import { stripUndefined } from "@/lib/firebase/db";

describe("stripUndefined (Firestore rejects undefined values)", () => {
  it("drops undefined fields, including nested ones and inside arrays", () => {
    const room = {
      name: "Bedroom",
      shape: undefined,
      description: null,
      zones: [{ id: "z1", color: undefined, polygon: [{ x_mm: 1, y_mm: 2 }] }],
      objects: undefined,
    };
    expect(stripUndefined(room)).toEqual({
      name: "Bedroom",
      description: null,
      zones: [{ id: "z1", polygon: [{ x_mm: 1, y_mm: 2 }] }],
    });
  });

  it("keeps null, zero, false and empty strings", () => {
    expect(stripUndefined({ a: null, b: 0, c: false, d: "" })).toEqual({
      a: null,
      b: 0,
      c: false,
      d: "",
    });
  });

  it("does not touch non-plain values such as Dates", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(stripUndefined({ when: d }).when).toBe(d);
  });
});

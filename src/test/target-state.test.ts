import { describe, expect, it } from "vitest";
import { SLEEP_AFTER_STILL_MS, isAtBed, targetState } from "@/lib/radar/target-state";

// Room 5 m wide. Bed zone x 500..2100, y 1000..3000 (room coordinates). Sensor x = room x - 2500.
const room = {
  width_mm: 5000,
  zones: [
    {
      id: "bz",
      room_id: "r",
      name: "Bed",
      type: "bed" as const,
      polygon: [
        { x_mm: 500, y_mm: 1000 },
        { x_mm: 2100, y_mm: 1000 },
        { x_mm: 2100, y_mm: 3000 },
        { x_mm: 500, y_mm: 3000 },
      ],
      alert_on_entry: false,
    },
  ],
  objects: [],
};
const onBed = { x_mm: -1200, y_mm: 2000 }; // room (1300, 2000)
const onFloor = { x_mm: 1000, y_mm: 2000 }; // room (3500, 2000)

describe("target state", () => {
  it("is sleeping only when still at the bed for long enough", () => {
    expect(targetState(room, onBed, SLEEP_AFTER_STILL_MS)).toBe("sleeping");
    expect(targetState(room, onBed, SLEEP_AFTER_STILL_MS + 600_000)).toBe("sleeping");
  });

  it("is awake at the bed before that, so lying down for a moment is not sleep", () => {
    expect(targetState(room, onBed, 0)).toBe("awake");
    expect(targetState(room, onBed, SLEEP_AFTER_STILL_MS - 1)).toBe("awake");
  });

  it("is never sleeping away from the bed, however long they are still", () => {
    expect(targetState(room, onFloor, 3_600_000)).toBe("awake");
  });

  it("knows a bed drawn as furniture as well as a bed zone", () => {
    const withObject = {
      width_mm: 5000,
      zones: [],
      objects: [
        {
          id: "o",
          room_id: "r",
          name: "Bed",
          type: "bed" as const,
          x_mm: 1300,
          y_mm: 2000,
          width_mm: 1600,
          length_mm: 2000,
          rotation_deg: 0,
        },
      ],
    };
    expect(isAtBed(withObject, onBed)).toBe(true);
    expect(isAtBed(withObject, onFloor)).toBe(false);
  });

  it("does not treat a sofa zone as a bed", () => {
    const sofa = { ...room, zones: [{ ...room.zones[0]!, type: "sofa" as const }] };
    expect(targetState(sofa, onBed, 3_600_000)).toBe("awake");
  });
});

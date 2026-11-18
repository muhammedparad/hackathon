import { describe, expect, it } from "vitest";
import { AlertEngine, type AlertEngineRoom, type DetectedAlert } from "@/lib/radar/alert-engine";
import { popupLevel } from "@/lib/notify";
import type { RoomMode } from "@/lib/radar/types";

// Room 5 m x 6 m. Bed zone x 500..2100, y 1000..3000 (room mm). Door at the bottom right. Sensor x = room x - 2500.
const base: AlertEngineRoom = {
  id: "room-m",
  name: "Bedroom",
  width_mm: 5000,
  length_mm: 6000,
  doors: [{ id: "d", name: "Bedroom door", x_mm: 4300, y_mm: 5900, width_mm: 900, type: "both" }],
  zones: [
    {
      id: "bz",
      room_id: "room-m",
      name: "Bed",
      type: "bed",
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
const inBed = { target_id: 1, x_mm: -1200, y_mm: 2000, speed_cms: 0 };
const midRoom = { target_id: 1, x_mm: 1000, y_mm: 2000, speed_cms: 30 };
const atDoor = { target_id: 1, x_mm: 1800, y_mm: 5800, speed_cms: 30 };
const T0 = 9_000_000;

/** Runs a script of (seconds, target-or-nothing) steps and collects every alert, in order. */
function run(mode: RoomMode, steps: Array<[number, typeof inBed | null]>): DetectedAlert[] {
  const engine = new AlertEngine({ ...base, mode });
  const out: DetectedAlert[] = [];
  for (const [s, t] of steps) {
    out.push(...engine.processTargets(t ? [t] : [], T0 + s * 1000, false));
  }
  return out;
}
const types = (a: DetectedAlert[]) => a.map((x) => x.event_type);

// Sleeps in bed for 150 s, then gets up
const sleepThenGetUp: Array<[number, typeof inBed | null]> = [
  ...Array.from({ length: 150 }, (_, i): [number, typeof inBed] => [i, inBed]),
  [151, midRoom],
  [152, midRoom],
  [155, midRoom],
];

describe("patient mode", () => {
  it("alerts when the person gets out of bed after sleeping", () => {
    const alerts = run("patient", sleepThenGetUp);
    const exit = alerts.find((a) => a.event_type === "bed_exit");
    expect(exit).toBeDefined();
    expect(exit?.severity).toBe("high");
    expect(exit?.description).toContain("got out of bed");
    expect(popupLevel(exit!)).toBe("alert");
  });

  it("raises the bed exit once, not on every frame", () => {
    const alerts = run("patient", [
      ...sleepThenGetUp,
      ...Array.from({ length: 30 }, (_, i): [number, typeof inBed] => [160 + i, midRoom]),
    ]);
    expect(alerts.filter((a) => a.event_type === "bed_exit")).toHaveLength(1);
  });

  it("does not call a short rest in bed sleep", () => {
    const alerts = run("patient", [
      ...Array.from({ length: 60 }, (_, i): [number, typeof inBed] => [i, inBed]),
      [61, midRoom],
      [62, midRoom],
      [66, midRoom],
    ]);
    expect(types(alerts)).not.toContain("bed_exit");
  });

  it("does not call lying still on the floor sleep", () => {
    const floor = { target_id: 1, x_mm: 1000, y_mm: 2000, speed_cms: 0 };
    const alerts = run("patient", [
      ...Array.from({ length: 200 }, (_, i): [number, typeof inBed] => [i, floor]),
      [201, midRoom],
      [206, midRoom],
    ]);
    expect(types(alerts)).not.toContain("bed_exit");
  });

  it("ignores a quick shift just outside the edge of the bed", () => {
    const alerts = run("patient", [
      ...Array.from({ length: 150 }, (_, i): [number, typeof inBed] => [i, inBed]),
      [150, midRoom],
      [151, inBed], // back in bed within the debounce
      [152, inBed],
    ]);
    expect(types(alerts)).not.toContain("bed_exit");
  });
});

describe("solo mode", () => {
  it("only logs getting out of bed (no alert popup)", () => {
    const exit = run("solo", sleepThenGetUp).find((a) => a.event_type === "bed_exit");
    expect(exit?.severity).toBe("info");
    expect(popupLevel(exit!)).toBeNull();
  });

  it("alerts when they wake up and then leave the room through the door", () => {
    const alerts = run("solo", [
      ...sleepThenGetUp,
      [160, atDoor],
      [161, atDoor],
      [170, null], // gone
    ]);
    const left = alerts.find((a) => a.event_type === "left_room");
    expect(left).toBeDefined();
    expect(left?.severity).toBe("high");
    expect(left?.description).toContain("Bedroom door");
    expect(popupLevel(left!)).toBe("critical");
  });

  it("does not alert when someone leaves who never slept in bed", () => {
    const alerts = run("solo", [
      [0, atDoor],
      [1, atDoor],
      [10, null],
    ]);
    expect(types(alerts)).not.toContain("left_room");
  });

  it("does not alert when they vanish in the middle of the room after waking", () => {
    const alerts = run("solo", [...sleepThenGetUp, [160, midRoom], [170, null]]);
    expect(types(alerts)).not.toContain("left_room");
  });

  it("does not alert for leaving long after getting up", () => {
    const alerts = run("solo", [
      ...sleepThenGetUp,
      [160, atDoor],
      [161, atDoor],
      [160 + 45 * 60, atDoor],
      [161 + 45 * 60, atDoor],
      [170 + 45 * 60, null],
    ]);
    // the door frames are 45 minutes after waking
    expect(types(alerts).filter((t) => t === "left_room")).toHaveLength(0);
  });
});

describe("patient mode also alerts when they then leave the room", () => {
  it("raises both the bed exit and the left-room alert", () => {
    const alerts = run("patient", [...sleepThenGetUp, [160, atDoor], [161, atDoor], [170, null]]);
    expect(types(alerts)).toEqual(expect.arrayContaining(["bed_exit", "left_room"]));
  });
});

describe("standard mode", () => {
  it("stays quiet about beds and doors", () => {
    const alerts = run("standard", [...sleepThenGetUp, [160, atDoor], [161, atDoor], [170, null]]);
    expect(types(alerts)).not.toContain("bed_exit");
    expect(types(alerts)).not.toContain("left_room");
  });
});

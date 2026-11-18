import { describe, expect, it } from "vitest";
import { isPointInPolygon, type Door, type RoomZone, type RoomObject } from "@/lib/radar/types";
import { firebaseDb } from "@/lib/firebase/db";

describe("Floor Plan Geometry: isPointInPolygon", () => {
  // 1. Simple rectangle: 1000,1000 to 3000,3000
  const boxPolygon = [
    { x_mm: 1000, y_mm: 1000 },
    { x_mm: 3000, y_mm: 1000 },
    { x_mm: 3000, y_mm: 3000 },
    { x_mm: 1000, y_mm: 3000 },
  ];

  it("detects points strictly inside the polygon", () => {
    expect(isPointInPolygon(2000, 2000, boxPolygon)).toBe(true);
    expect(isPointInPolygon(1500, 1500, boxPolygon)).toBe(true);
    expect(isPointInPolygon(2900, 2900, boxPolygon)).toBe(true);
  });

  it("detects points outside the polygon", () => {
    expect(isPointInPolygon(500, 2000, boxPolygon)).toBe(false); // Left
    expect(isPointInPolygon(3500, 2000, boxPolygon)).toBe(false); // Right
    expect(isPointInPolygon(2000, 500, boxPolygon)).toBe(false); // Above
    expect(isPointInPolygon(2000, 3500, boxPolygon)).toBe(false); // Below
    expect(isPointInPolygon(0, 0, boxPolygon)).toBe(false); // Far origin
  });

  // 2. Concave L-shaped polygon
  // (0,0) -> (4000,0) -> (4000,2000) -> (2000,2000) -> (2000,4000) -> (0,4000)
  const lShapedPolygon = [
    { x_mm: 0, y_mm: 0 },
    { x_mm: 4000, y_mm: 0 },
    { x_mm: 4000, y_mm: 2000 },
    { x_mm: 2000, y_mm: 2000 },
    { x_mm: 2000, y_mm: 4000 },
    { x_mm: 0, y_mm: 4000 },
  ];

  it("handles concave L-shaped polygons correctly", () => {
    // Inside the bottom-left leg
    expect(isPointInPolygon(1000, 3000, lShapedPolygon)).toBe(true);
    // Inside the horizontal bottom leg
    expect(isPointInPolygon(3000, 1000, lShapedPolygon)).toBe(true);
    // In the hollow cut-out (top-right quadrant 3000, 3000) -> should be false
    expect(isPointInPolygon(3000, 3000, lShapedPolygon)).toBe(false);
  });

  it("handles degenerate polygons gracefully", () => {
    expect(isPointInPolygon(100, 100, [])).toBe(false);
    expect(isPointInPolygon(100, 100, [{ x_mm: 0, y_mm: 0 }])).toBe(false);
    expect(
      isPointInPolygon(100, 100, [
        { x_mm: 0, y_mm: 0 },
        { x_mm: 100, y_mm: 100 },
      ]),
    ).toBe(false);
  });
});

describe("Floor Plan Data Management", () => {
  it("stores and retrieves room zones and objects via firebaseDb fallback cache", async () => {
    const testZone: RoomZone = {
      id: "test-zone-bed-1",
      room_id: "test-room-1",
      name: "Bed Sensor Zone",
      type: "bed",
      polygon: [
        { x_mm: 500, y_mm: 500 },
        { x_mm: 2000, y_mm: 500 },
        { x_mm: 2000, y_mm: 2500 },
        { x_mm: 500, y_mm: 2500 },
      ],
      alert_on_entry: false,
    };

    const testObject: RoomObject = {
      id: "test-obj-desk-1",
      room_id: "test-room-1",
      name: "Study Desk",
      type: "desk",
      x_mm: 3000,
      y_mm: 2000,
      width_mm: 1200,
      length_mm: 600,
      rotation_deg: 0,
    };

    // Save zone and object
    await firebaseDb.saveZone(testZone);
    await firebaseDb.saveRoomObject(testObject);

    // Retrieve zones for room
    const zones = await firebaseDb.getZones("test-room-1");
    expect(zones.some((z) => z.id === "test-zone-bed-1")).toBe(true);

    // Retrieve objects for room
    const objects = await firebaseDb.getRoomObjects("test-room-1");
    expect(objects.some((o) => o.id === "test-obj-desk-1")).toBe(true);

    // Delete zone
    await firebaseDb.deleteZone("test-zone-bed-1");
    const remainingZones = await firebaseDb.getZones("test-room-1");
    expect(remainingZones.some((z) => z.id === "test-zone-bed-1")).toBe(false);

    // Delete object
    await firebaseDb.deleteRoomObject("test-obj-desk-1");
    const remainingObjects = await firebaseDb.getRoomObjects("test-room-1");
    expect(remainingObjects.some((o) => o.id === "test-obj-desk-1")).toBe(false);
  });
});

// Awake or sleeping for each tracked person. Sleeping is only possible at the bed: someone still on the floor or a
// sofa is awake (or a possible fall, which is a different rule).
import { rotatedRectCorners } from "@/lib/radar/iso";
import { isPointInPolygon, type RoomObject, type RoomZone } from "@/lib/radar/types";

/** Still, at the bed, for this long before they count as asleep. */
export const SLEEP_AFTER_STILL_MS = 120_000;

export type TargetState = "awake" | "sleeping";

interface Room {
  width_mm: number;
  zones?: RoomZone[] | undefined;
  objects?: RoomObject[] | undefined;
}

/** True when the sensor-relative position is on a bed zone or a bed object. */
export function isAtBed(room: Room, t: { x_mm: number; y_mm: number }): boolean {
  const x = t.x_mm + room.width_mm / 2; // sensor-relative to room coordinates
  const y = t.y_mm;
  const inZone = (room.zones ?? []).some(
    (z) => z.type === "bed" && z.polygon.length >= 3 && isPointInPolygon(x, y, z.polygon),
  );
  if (inZone) return true;
  return (room.objects ?? []).some(
    (o) =>
      o.type === "bed" &&
      isPointInPolygon(
        x,
        y,
        rotatedRectCorners(o.x_mm, o.y_mm, o.width_mm, o.length_mm, o.rotation_deg).map((p) => ({
          x_mm: p.x,
          y_mm: p.y,
        })),
      ),
  );
}

export function targetState(
  room: Room,
  t: { x_mm: number; y_mm: number },
  stillMs: number,
): TargetState {
  return isAtBed(room, t) && stillMs >= SLEEP_AFTER_STILL_MS ? "sleeping" : "awake";
}

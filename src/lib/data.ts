import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  firebaseDb,
  type Room,
  type Device,
  type Sensor,
  type OccupancyEvent,
} from "@/lib/firebase/db";
import { authClient } from "@/lib/auth";
import type {
  AlertSeverity,
  Door,
  RoomObject,
  RoomZone,
  TrajectoryPoint,
  TrajectorySegment,
} from "@/lib/radar/types";

export type {
  Room,
  Device,
  Sensor,
  Door,
  RoomZone,
  RoomObject,
  TrajectoryPoint,
  TrajectorySegment,
};
export type EventRow = OccupancyEvent;

/** Centralised data client: queries Cloud Firestore for the signed-in user. No local or demo data. */
async function currentUserId(): Promise<string | undefined> {
  return (await authClient.getUser())?.id;
}

export const roomsQuery = queryOptions({
  queryKey: ["rooms"],
  queryFn: async () => {
    const userId = await currentUserId();
    if (!userId) return [];
    return firebaseDb.getRooms(userId);
  },
});

export const devicesQuery = queryOptions({
  queryKey: ["devices"],
  queryFn: async () => {
    const userId = await currentUserId();
    if (!userId) return [];
    return firebaseDb.getDevices(userId);
  },
});

export const sensorsQuery = queryOptions({
  queryKey: ["sensors"],
  queryFn: async () => {
    const userId = await currentUserId();
    if (!userId) return [];
    return firebaseDb.getSensors(undefined, userId);
  },
});

export interface EventFilters {
  from?: string | undefined;
  to?: string | undefined;
  roomId?: string | undefined;
  eventType?: string | undefined;
  sensorType?: string | undefined;
  severity?: AlertSeverity | undefined;
  acknowledged?: boolean | undefined;
  page?: number;
  pageSize?: number;
}

export function eventsQuery(f: EventFilters) {
  return queryOptions({ queryKey: ["events", f], queryFn: () => fetchEvents(f) });
}

export async function fetchEvents(f: EventFilters) {
  try {
    if (f.roomId) {
      return await firebaseDb.getEvents({
        roomId: f.roomId,
        fromIso: f.from,
        toIso: f.to,
        eventType: f.eventType,
        sensorType: f.sensorType,
        severity: f.severity,
        acknowledged: f.acknowledged,
        limitCount: (f.pageSize ?? 25) * ((f.page ?? 0) + 1),
      });
    }

    // Explicit room scoping for security rules compatibility: query per owned room
    const user = await authClient.getUser();
    if (!user) return { rows: [], count: 0 };
    const rooms = await firebaseDb.getRooms(user.id);
    if (rooms.length === 0) return { rows: [], count: 0 };

    const results = await Promise.all(
      rooms.map((r) =>
        firebaseDb.getEvents({
          roomId: r.id,
          fromIso: f.from,
          toIso: f.to,
          eventType: f.eventType,
          sensorType: f.sensorType,
          severity: f.severity,
          acknowledged: f.acknowledged,
          limitCount: (f.pageSize ?? 25) * ((f.page ?? 0) + 1),
        }),
      ),
    );
    const combinedRows = results.flatMap((res) => res.rows);
    combinedRows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const totalCount = combinedRows.length;
    const start = (f.page ?? 0) * (f.pageSize ?? 25);
    const paged = combinedRows.slice(start, start + (f.pageSize ?? 25));
    return { rows: paged, count: totalCount };
  } catch {
    return { rows: [], count: 0 };
  }
}

/** Events in a time window, used by analytics. */
export function analyticsEventsQuery(fromIso: string, roomId?: string) {
  return queryOptions({
    queryKey: ["analytics-events", fromIso, roomId],
    queryFn: async () => {
      try {
        const user = await authClient.getUser();
        if (!user) return [];
        const userRooms = await firebaseDb.getRooms(user.id);
        const targetRooms = roomId ? [roomId] : userRooms.map((r) => r.id);
        if (targetRooms.length === 0) return [];

        const allRows = await Promise.all(
          targetRooms.map(async (rId) => {
            const res = await firebaseDb.getEvents({
              roomId: rId,
              fromIso,
              limitCount: 500,
            });
            return res.rows;
          }),
        );
        return allRows.flat().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      } catch {
        return [];
      }
    },
  });
}

export function useRoomMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["rooms"] });

  const save = useMutation({
    mutationFn: async (r: {
      id?: string;
      name: string;
      width_mm: number;
      length_mm: number;
      description?: string | null;
      doors?: Door[];
      zones?: RoomZone[];
      objects?: RoomObject[];
      shape?: "rectangle" | "polygon";
      polygon_vertices?: Array<{ x_mm: number; y_mm: number }>;
    }) => {
      if (r.id) {
        await firebaseDb.updateRoom(r.id, r);
        return true;
      }
      const user = await authClient.getUser();
      if (!user) throw new Error("You must be signed in to create a room.");
      await firebaseDb.createRoom({
        name: r.name,
        width_mm: r.width_mm,
        length_mm: r.length_mm,
        description: r.description,
        doors: r.doors,
        zones: r.zones,
        objects: r.objects,
        shape: r.shape,
        polygon_vertices: r.polygon_vertices,
        user_id: user.id,
      });
      return true;
    },
    onSuccess: done,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await firebaseDb.deleteRoom(id);
    },
    onSuccess: () => {
      done();
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  return { save, remove };
}

/* ---------------- Floor Plan: Zones & Objects Queries ---------------- */

export function zonesQuery(roomId?: string) {
  return queryOptions({
    queryKey: ["room-zones", roomId],
    queryFn: async () => {
      if (!roomId) return [];
      return firebaseDb.getZones(roomId);
    },
  });
}

export function roomObjectsQuery(roomId?: string) {
  return queryOptions({
    queryKey: ["room-objects", roomId],
    queryFn: async () => {
      if (!roomId) return [];
      return firebaseDb.getRoomObjects(roomId);
    },
  });
}

export function useRoomZoneMutations(roomId?: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["room-zones"] });
    void qc.invalidateQueries({ queryKey: ["rooms"] });
  };

  const saveZone = useMutation({
    mutationFn: async (zone: RoomZone) => {
      await firebaseDb.saveZone(zone);
    },
    onSuccess: invalidate,
  });

  const removeZone = useMutation({
    mutationFn: async (zoneId: string) => {
      await firebaseDb.deleteZone(zoneId);
    },
    onSuccess: invalidate,
  });

  return { saveZone, removeZone };
}

export function useRoomObjectMutations(roomId?: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["room-objects"] });
    void qc.invalidateQueries({ queryKey: ["rooms"] });
  };

  const saveObject = useMutation({
    mutationFn: async (obj: RoomObject) => {
      await firebaseDb.saveRoomObject(obj);
    },
    onSuccess: invalidate,
  });

  const removeObject = useMutation({
    mutationFn: async (objId: string) => {
      await firebaseDb.deleteRoomObject(objId);
    },
    onSuccess: invalidate,
  });

  return { saveObject, removeObject };
}

/* ---------------- Trajectories Query (Phase 2) ---------------- */

export interface TrajectoryQueryOptions {
  roomId?: string | undefined;
  fromIso?: string | undefined;
  toIso?: string | undefined;
  sensorType?: "ld2450" | "rd61" | undefined;
  targetId?: number | undefined;
  limitCount?: number | undefined;
}

export function trajectoriesQuery(options: TrajectoryQueryOptions) {
  return queryOptions({
    queryKey: ["trajectories", options],
    queryFn: async () => {
      if (!options.roomId) return [];
      return firebaseDb.getTrajectorySegments({ ...options, roomId: options.roomId });
    },
  });
}

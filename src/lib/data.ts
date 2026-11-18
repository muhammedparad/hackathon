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

const KEY_ROOMS = "roomtrace_local_rooms";
const KEY_DEVICES = "roomtrace_local_devices";
const KEY_SENSORS = "roomtrace_local_sensors";

const DEFAULT_ROOMS: Room[] = [
  {
    id: "b2c3d4e5-6677-8899-0011-223344556677",
    user_id: "usr_admin_default",
    name: "Bedroom",
    width_mm: 4200,
    length_mm: 4600,
    description: "Primary bedroom with Silver Shield bed exit & fall detection",
    doors: [
      {
        id: "door-bed-1",
        name: "Door",
        x_mm: 3600,
        y_mm: 4400,
        width_mm: 900,
        wall: "bottom",
        type: "both",
      },
    ],
    zones: [
      {
        id: "zone-bed-mattress",
        room_id: "b2c3d4e5-6677-8899-0011-223344556677",
        name: "Bed Zone",
        type: "bed",
        polygon: [
          { x_mm: 1100, y_mm: 1700 },
          { x_mm: 2900, y_mm: 1700 },
          { x_mm: 2900, y_mm: 3800 },
          { x_mm: 1100, y_mm: 3800 },
        ],
        alert_on_entry: false,
      },
      {
        id: "zone-bed-balcony",
        room_id: "b2c3d4e5-6677-8899-0011-223344556677",
        name: "Balcony Hazard",
        type: "hazard",
        polygon: [
          { x_mm: 300, y_mm: 500 },
          { x_mm: 1000, y_mm: 500 },
          { x_mm: 1000, y_mm: 2000 },
          { x_mm: 300, y_mm: 2000 },
        ],
        alert_on_entry: true,
      },
    ],
    objects: [
      {
        id: "obj-bed-queen",
        room_id: "b2c3d4e5-6677-8899-0011-223344556677",
        name: "Queen Bed",
        type: "bed",
        x_mm: 1950,
        y_mm: 2750,
        width_mm: 1650,
        length_mm: 2000,
        rotation_deg: 0,
      },
      {
        id: "obj-bed-sofa",
        room_id: "b2c3d4e5-6677-8899-0011-223344556677",
        name: "Comfort Sofa",
        type: "sofa",
        x_mm: 3750,
        y_mm: 3100,
        width_mm: 750,
        length_mm: 1500,
        rotation_deg: 0,
      },
      {
        id: "obj-bed-nightstand-l",
        room_id: "b2c3d4e5-6677-8899-0011-223344556677",
        name: "Nightstand Left",
        type: "table",
        x_mm: 850,
        y_mm: 2000,
        width_mm: 500,
        length_mm: 500,
        rotation_deg: 0,
      },
      {
        id: "obj-bed-nightstand-r",
        room_id: "b2c3d4e5-6677-8899-0011-223344556677",
        name: "Nightstand Right",
        type: "table",
        x_mm: 2950,
        y_mm: 2000,
        width_mm: 500,
        length_mm: 500,
        rotation_deg: 0,
      },
    ],
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
    user_id: "usr_admin_default",
    name: "Living Room",
    width_mm: 5000,
    length_mm: 4000,
    description: "Main residential area with mmWave radar coverage",
    doors: [
      {
        id: "door-lr-1",
        name: "Main Entry",
        x_mm: 4700,
        y_mm: 3800,
        width_mm: 900,
        wall: "bottom",
        type: "both",
      },
    ],
    zones: [
      {
        id: "zone-lr-couch",
        room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
        name: "Lounge Seating",
        type: "sofa",
        polygon: [
          { x_mm: 1200, y_mm: 1800 },
          { x_mm: 3200, y_mm: 1800 },
          { x_mm: 3200, y_mm: 2700 },
          { x_mm: 1200, y_mm: 2700 },
        ],
        alert_on_entry: false,
      },
      {
        id: "zone-lr-balcony",
        room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
        name: "Balcony Hazard",
        type: "hazard",
        polygon: [
          { x_mm: 4000, y_mm: 500 },
          { x_mm: 4900, y_mm: 500 },
          { x_mm: 4900, y_mm: 1500 },
          { x_mm: 4000, y_mm: 1500 },
        ],
        alert_on_entry: true,
      },
    ],
    objects: [
      {
        id: "obj-lr-couch",
        room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
        name: "Living Room Couch",
        type: "couch",
        x_mm: 2200,
        y_mm: 2250,
        width_mm: 1800,
        length_mm: 800,
        rotation_deg: 0,
      },
      {
        id: "obj-lr-table",
        room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
        name: "Coffee Table",
        type: "table",
        x_mm: 2200,
        y_mm: 1400,
        width_mm: 900,
        length_mm: 550,
        rotation_deg: 0,
      },
    ],
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "f5b8b9e1-5502-4f89-8695-d928326d1f02",
    user_id: "usr_admin_default",
    name: "Sensor Lab 01",
    width_mm: 4500,
    length_mm: 3600,
    description: "Hardware testing and telemetry calibration lab",
    doors: [
      {
        id: "door-lab-1",
        name: "Lab Entrance",
        x_mm: 4200,
        y_mm: 3400,
        width_mm: 850,
        wall: "bottom",
        type: "both",
      },
    ],
    zones: [
      {
        id: "zone-lab-bench",
        room_id: "f5b8b9e1-5502-4f89-8695-d928326d1f02",
        name: "Work Bench Area",
        type: "custom",
        polygon: [
          { x_mm: 600, y_mm: 800 },
          { x_mm: 2200, y_mm: 800 },
          { x_mm: 2200, y_mm: 1800 },
          { x_mm: 600, y_mm: 1800 },
        ],
        alert_on_entry: false,
      },
    ],
    objects: [
      {
        id: "obj-lab-bench",
        room_id: "f5b8b9e1-5502-4f89-8695-d928326d1f02",
        name: "Test Bench",
        type: "desk",
        x_mm: 1400,
        y_mm: 1300,
        width_mm: 1400,
        length_mm: 800,
        rotation_deg: 0,
      },
    ],
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

const DEFAULT_DEVICES: Device[] = [
  {
    id: "roomtrace_01",
    user_id: "tLFl6MTucSNEdVlajznusTNMXv43",
    device_id: "roomtrace_01",
    device_name: "Radar Hub (roomtrace_01)",
    device_type: "esp32",
    room_id: "b2c3d4e5-6677-8899-0011-223344556677",
    status: "connected",
    ip_address: "192.168.1.105",
    firmware_version: "1.0.0",
    last_seen: new Date().toISOString(),
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "d1a1b1c1-1111-2222-3333-444455556666",
    user_id: "usr_admin_default",
    device_id: "esp32-lab-01",
    device_name: "Lab Radar Hub",
    device_type: "esp32",
    room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
    status: "connected",
    ip_address: "192.168.1.40",
    firmware_version: "0.1.0",
    last_seen: new Date().toISOString(),
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

const DEFAULT_SENSORS: Sensor[] = [
  {
    id: "sensor-ld2450-roomtrace-01",
    device_id: "roomtrace_01",
    user_id: "tLFl6MTucSNEdVlajznusTNMXv43",
    sensor_type: "ld2450",
    model: "HLK-LD2450",
    configuration: { band: "24 GHz", uart: "UART1", baud_rate: 256000 },
    status: "connected",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "sensor-rd61-roomtrace-01",
    device_id: "roomtrace_01",
    user_id: "tLFl6MTucSNEdVlajznusTNMXv43",
    sensor_type: "rd61",
    model: "Ai-Thinker RD-61",
    configuration: {
      band: "60 GHz",
      interface: "RD-60-Kit",
      firmware_version: "#2967 Standard Point Cloud V1.0.0",
      data_mode: "point_cloud",
    },
    status: "connected",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "s1a1b1c1-1111-2222-3333-444455556666",
    device_id: "d1a1b1c1-1111-2222-3333-444455556666",
    user_id: "usr_admin_default",
    sensor_type: "ld2450",
    model: "HLK-LD2450",
    configuration: { band: "24 GHz", uart: "UART1", baud_rate: 256000 },
    status: "connected",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "s2a2b2c2-2222-3333-4444-555566667777",
    device_id: "d1a1b1c1-1111-2222-3333-444455556666",
    user_id: "usr_admin_default",
    sensor_type: "rd61",
    model: "Ai-Thinker RD-61",
    configuration: {
      band: "60 GHz",
      interface: "RD-60-Kit",
      firmware_version: "0.1.0",
      data_mode: "point_cloud",
    },
    status: "connected",
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

function getLocalRooms(): Room[] {
  if (typeof window === "undefined") return DEFAULT_ROOMS;
  try {
    const raw = localStorage.getItem(KEY_ROOMS);
    if (!raw) {
      localStorage.setItem(KEY_ROOMS, JSON.stringify(DEFAULT_ROOMS));
      return DEFAULT_ROOMS;
    }
    const parsed = JSON.parse(raw) as Room[];
    if (parsed.length > 0) {
      const bedroom = parsed.find((r) => r.id === "b2c3d4e5-6677-8899-0011-223344556677");
      if (bedroom && (!bedroom.objects || !bedroom.objects.some((o) => o.id === "obj-bed-sofa"))) {
        bedroom.objects = DEFAULT_ROOMS[0]?.objects;
        bedroom.zones = DEFAULT_ROOMS[0]?.zones;
        try {
          localStorage.setItem(KEY_ROOMS, JSON.stringify(parsed));
        } catch {
          /* ignore */
        }
      }
      return parsed;
    }
    return DEFAULT_ROOMS;
  } catch {
    return DEFAULT_ROOMS;
  }
}

function saveLocalRooms(rooms: Room[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY_ROOMS, JSON.stringify(rooms));
  } catch {
    /* ignore */
  }
}

function getLocalDevices(): Device[] {
  if (typeof window === "undefined") return DEFAULT_DEVICES;
  try {
    const raw = localStorage.getItem(KEY_DEVICES);
    if (!raw) {
      localStorage.setItem(KEY_DEVICES, JSON.stringify(DEFAULT_DEVICES));
      return DEFAULT_DEVICES;
    }
    const parsed = JSON.parse(raw) as Device[];
    const nowIso = new Date().toISOString();
    if (!parsed.some((d) => d.device_id === "roomtrace_01")) {
      const merged = [
        ...DEFAULT_DEVICES.filter((d) => !parsed.some((p) => p.device_id === d.device_id)),
        ...parsed,
      ];
      try {
        localStorage.setItem(KEY_DEVICES, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      return merged.map((d) =>
        d.device_id === "roomtrace_01"
          ? {
              ...d,
              room_id: d.room_id || "b2c3d4e5-6677-8899-0011-223344556677",
              last_seen: nowIso,
              status: "connected" as const,
            }
          : d,
      );
    }
    return parsed.map((d) =>
      d.device_id === "roomtrace_01"
        ? {
            ...d,
            room_id: d.room_id || "b2c3d4e5-6677-8899-0011-223344556677",
            last_seen: nowIso,
            status: "connected" as const,
          }
        : d,
    );
  } catch {
    return DEFAULT_DEVICES;
  }
}

function getLocalSensors(): Sensor[] {
  if (typeof window === "undefined") return DEFAULT_SENSORS;
  try {
    const raw = localStorage.getItem(KEY_SENSORS);
    if (!raw) {
      localStorage.setItem(KEY_SENSORS, JSON.stringify(DEFAULT_SENSORS));
      return DEFAULT_SENSORS;
    }
    const parsed = JSON.parse(raw) as Sensor[];
    if (!parsed.some((s) => s.device_id === "roomtrace_01")) {
      const merged = [
        ...DEFAULT_SENSORS.filter((s) => !parsed.some((p) => p.id === s.id)),
        ...parsed,
      ];
      localStorage.setItem(KEY_SENSORS, JSON.stringify(merged));
      return merged;
    }
    return parsed;
  } catch {
    return DEFAULT_SENSORS;
  }
}

/** Centralised data client: queries Cloud Firestore with offline demo fallback. */
export const roomsQuery = queryOptions({
  queryKey: ["rooms"],
  queryFn: async () => {
    try {
      const user = await authClient.getUser();
      const fRooms = await firebaseDb.getRooms(user?.id);
      if (fRooms && fRooms.length > 0) return fRooms;
    } catch {
      /* fallback to local cache */
    }
    return getLocalRooms();
  },
});

export const devicesQuery = queryOptions({
  queryKey: ["devices"],
  queryFn: async () => {
    try {
      const user = await authClient.getUser();
      const fDevs = await firebaseDb.getDevices(user?.id);
      if (fDevs && fDevs.length > 0) return fDevs;
    } catch {
      /* fallback to local cache */
    }
    return getLocalDevices();
  },
});

export const sensorsQuery = queryOptions({
  queryKey: ["sensors"],
  queryFn: async () => {
    try {
      const user = await authClient.getUser();
      const fSensors = await firebaseDb.getSensors(undefined, user?.id);
      if (fSensors && fSensors.length > 0) return fSensors;
    } catch {
      /* fallback to local cache */
    }
    return getLocalSensors();
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
  includeSimulated?: boolean;
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
        includeSimulated: f.includeSimulated,
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
          includeSimulated: f.includeSimulated,
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
export function analyticsEventsQuery(fromIso: string, includeSimulated: boolean, roomId?: string) {
  return queryOptions({
    queryKey: ["analytics-events", fromIso, includeSimulated, roomId],
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
              includeSimulated,
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
      let savedRemotely = false;
      try {
        if (r.id) {
          await firebaseDb.updateRoom(r.id, r);
          savedRemotely = true;
        } else {
          const user = await authClient.getUser();
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
            user_id: user?.id ?? "usr_admin_default",
          });
          savedRemotely = true;
        }
      } catch {
        /* fallback to local cache */
      }

      // Always update local cache so changes are immediately visible
      const current = getLocalRooms();
      if (r.id) {
        const updated = current.map((room) =>
          room.id === r.id
            ? {
                ...room,
                ...r,
              }
            : room,
        );
        saveLocalRooms(updated);
      } else {
        const user = await authClient.getUser();
        const newRoom: Room = {
          id: `room_${Math.random().toString(36).slice(2, 10)}`,
          user_id: user?.id ?? "usr_admin_default",
          name: r.name,
          width_mm: r.width_mm,
          length_mm: r.length_mm,
          description: r.description,
          doors: r.doors,
          zones: r.zones,
          objects: r.objects,
          shape: r.shape,
          polygon_vertices: r.polygon_vertices,
          created_at: new Date().toISOString(),
        };
        saveLocalRooms([...current, newRoom]);
      }
      return savedRemotely;
    },
    onSuccess: done,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      try {
        await firebaseDb.deleteRoom(id);
      } catch {
        /* fallback to local cache */
      }
      const current = getLocalRooms();
      saveLocalRooms(current.filter((r) => r.id !== id));
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
  roomId: string;
  fromIso?: string | undefined;
  toIso?: string | undefined;
  simulated?: boolean | undefined;
  sensorType?: "ld2450" | "rd61" | undefined;
  targetId?: number | undefined;
  limitCount?: number | undefined;
}

export function trajectoriesQuery(options: TrajectoryQueryOptions) {
  return queryOptions({
    queryKey: ["trajectories", options],
    queryFn: async () => {
      return firebaseDb.getTrajectorySegments(options);
    },
  });
}

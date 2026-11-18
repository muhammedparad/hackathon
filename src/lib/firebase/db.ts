import {
  getFirestore,
  collection,
  getDocs,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  type Firestore,
  type Unsubscribe,
  type Query,
  type DocumentData,
} from "firebase/firestore";
import { ref as rtdbRef, onValue as rtdbOnValue, get as rtdbGet } from "firebase/database";
import { getFirebaseApp, getFirebaseRtdb, isFirebaseConfigured } from "./config";
import type {
  AlertSeverity,
  Door,
  EventEvidence,
  EventType,
  EvidenceQuality,
  LD2450Target,
  RD61Point,
  RoomObject,
  RoomZone,
  TrajectoryPoint,
  TrajectorySegment,
} from "@/lib/radar/types";

export interface Room {
  id: string;
  user_id: string;
  name: string;
  width_mm: number;
  length_mm: number;
  description?: string | null | undefined;
  doors?: Door[] | undefined;
  zones?: RoomZone[] | undefined;
  objects?: RoomObject[] | undefined;
  shape?: "rectangle" | "polygon" | undefined;
  polygon_vertices?: Array<{ x_mm: number; y_mm: number }> | undefined;
  created_at: string;
  updated_at?: string | null | undefined;
}

export interface Device {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  device_type: string;
  room_id: string | null;
  status: "connected" | "disconnected" | "unknown";
  firmware_version?: string | null | undefined;
  ip_address?: string | null | undefined;
  last_seen: string | null;
  created_at: string;
  updated_at?: string | null | undefined;
}

export interface Sensor {
  id: string;
  device_id: string;
  user_id?: string | null | undefined;
  sensor_type: "ld2450" | "rd61";
  model: string;
  configuration: Record<string, unknown>;
  status: string;
  created_at?: string | null | undefined;
}

export interface OccupancyEvent {
  id: string;
  room_id: string;
  device_id?: string | null | undefined;
  event_type: EventType;
  description: string;
  target_id?: number | null | undefined;
  sensor_type?: string | null | undefined;
  simulated: boolean;
  timestamp: string; // ISO 8601
  severity?: AlertSeverity | undefined;
  zone_id?: string | null | undefined;
  zone_name?: string | null | undefined;
  x_mm?: number | null | undefined;
  y_mm?: number | null | undefined;
  z_mm?: number | null | undefined;
  evidence?: EventEvidence | undefined;
  confidence?: "low" | "medium" | "high" | undefined;
  evidence_quality?: EvidenceQuality | undefined;
  acknowledged?: boolean | undefined;
  acknowledged_at?: string | null | undefined;
  acknowledged_by?: string | null | undefined;
}

export interface TelemetryRecord {
  id: string;
  device_id: string;
  room_id: string | null;
  sensor_type: "ld2450" | "rd61";
  timestamp: string;
  payload: {
    sensor_type: "ld2450" | "rd61";
    targets?: LD2450Target[] | undefined;
    points?: RD61Point[] | undefined;
  };
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string | null | undefined;
  role?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

let firestoreInstance: Firestore | null = null;
const warnedErrors = new Set<string>();

function logFirestoreWarning(tag: string, err: unknown) {
  const code = (err as { code?: string })?.code || "error";
  const key = `${tag}:${code}`;
  if (!warnedErrors.has(key)) {
    warnedErrors.add(key);
    if (code === "permission-denied") {
      console.warn(
        `[Firebase] ${tag}: Permission denied. Update Firestore Security Rules in Firebase Console.`,
      );
    } else {
      console.warn(`[Firebase] ${tag}:`, err);
    }
  }
}

const KEY_EVENTS = "roomtrace_local_events";
const inMemoryEventsCache: OccupancyEvent[] = [];

function getLocalEventsFromStorage(): OccupancyEvent[] {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_EVENTS);
      if (raw) return JSON.parse(raw) as OccupancyEvent[];
    } catch {
      /* ignore */
    }
  }
  return inMemoryEventsCache;
}

function saveLocalEventToStorage(event: OccupancyEvent) {
  const existingIdx = inMemoryEventsCache.findIndex((e) => e.id === event.id);
  if (existingIdx >= 0) {
    inMemoryEventsCache[existingIdx] = event;
  } else {
    inMemoryEventsCache.unshift(event);
    if (inMemoryEventsCache.length > 300) inMemoryEventsCache.pop();
  }

  if (typeof window !== "undefined") {
    try {
      const events = getLocalEventsFromStorage();
      const updated = [event, ...events.filter((e) => e.id !== event.id)].slice(0, 300);
      localStorage.setItem(KEY_EVENTS, JSON.stringify(updated));
    } catch {
      /* ignore */
    }
  }
}

const KEY_ZONES = "roomtrace_local_zones";
const KEY_OBJECTS = "roomtrace_local_objects";
const inMemoryZonesCache: RoomZone[] = [];
const inMemoryObjectsCache: RoomObject[] = [];

function getLocalZonesFromStorage(roomId?: string): RoomZone[] {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_ZONES);
      const zones = raw ? (JSON.parse(raw) as RoomZone[]) : [];
      return roomId ? zones.filter((z) => z.room_id === roomId) : zones;
    } catch {
      /* ignore */
    }
  }
  return roomId ? inMemoryZonesCache.filter((z) => z.room_id === roomId) : inMemoryZonesCache;
}

function saveLocalZoneToStorage(zone: RoomZone) {
  const existingIdx = inMemoryZonesCache.findIndex((z) => z.id === zone.id);
  if (existingIdx >= 0) inMemoryZonesCache[existingIdx] = zone;
  else inMemoryZonesCache.push(zone);

  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_ZONES);
      const zones = raw ? (JSON.parse(raw) as RoomZone[]) : [];
      const idx = zones.findIndex((z) => z.id === zone.id);
      if (idx >= 0) zones[idx] = zone;
      else zones.push(zone);
      localStorage.setItem(KEY_ZONES, JSON.stringify(zones));
    } catch {
      /* ignore */
    }
  }
}

function deleteLocalZoneFromStorage(zoneId: string) {
  const existingIdx = inMemoryZonesCache.findIndex((z) => z.id === zoneId);
  if (existingIdx >= 0) inMemoryZonesCache.splice(existingIdx, 1);

  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_ZONES);
      const zones = raw ? (JSON.parse(raw) as RoomZone[]) : [];
      localStorage.setItem(KEY_ZONES, JSON.stringify(zones.filter((z) => z.id !== zoneId)));
    } catch {
      /* ignore */
    }
  }
}

function getLocalObjectsFromStorage(roomId?: string): RoomObject[] {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_OBJECTS);
      const objs = raw ? (JSON.parse(raw) as RoomObject[]) : [];
      return roomId ? objs.filter((o) => o.room_id === roomId) : objs;
    } catch {
      /* ignore */
    }
  }
  return roomId ? inMemoryObjectsCache.filter((o) => o.room_id === roomId) : inMemoryObjectsCache;
}

function saveLocalObjectToStorage(obj: RoomObject) {
  const existingIdx = inMemoryObjectsCache.findIndex((o) => o.id === obj.id);
  if (existingIdx >= 0) inMemoryObjectsCache[existingIdx] = obj;
  else inMemoryObjectsCache.push(obj);

  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_OBJECTS);
      const objs = raw ? (JSON.parse(raw) as RoomObject[]) : [];
      const idx = objs.findIndex((o) => o.id === obj.id);
      if (idx >= 0) objs[idx] = obj;
      else objs.push(obj);
      localStorage.setItem(KEY_OBJECTS, JSON.stringify(objs));
    } catch {
      /* ignore */
    }
  }
}

function deleteLocalObjectFromStorage(objId: string) {
  const existingIdx = inMemoryObjectsCache.findIndex((o) => o.id === objId);
  if (existingIdx >= 0) inMemoryObjectsCache.splice(existingIdx, 1);

  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_OBJECTS);
      const objs = raw ? (JSON.parse(raw) as RoomObject[]) : [];
      localStorage.setItem(KEY_OBJECTS, JSON.stringify(objs.filter((o) => o.id !== objId)));
    } catch {
      /* ignore */
    }
  }
}

const KEY_TRAJECTORIES = "roomtrace_local_trajectories";
const inMemoryTrajectoryCache: TrajectorySegment[] = [];

function getLocalTrajectoriesFromStorage(options?: {
  roomId?: string | undefined;
  simulated?: boolean | undefined;
  fromIso?: string | undefined;
  toIso?: string | undefined;
  sensorType?: "ld2450" | "rd61" | undefined;
  targetId?: number | undefined;
}): TrajectorySegment[] {
  let list = inMemoryTrajectoryCache;
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_TRAJECTORIES);
      if (raw) list = JSON.parse(raw) as TrajectorySegment[];
    } catch {
      /* ignore */
    }
  }
  if (options?.roomId) list = list.filter((s) => s.room_id === options.roomId);
  if (options?.simulated !== undefined)
    list = list.filter((s) => s.simulated === options.simulated);
  if (options?.sensorType) list = list.filter((s) => s.sensor_type === options.sensorType);
  if (options?.targetId !== undefined) list = list.filter((s) => s.target_id === options.targetId);
  if (options?.fromIso) list = list.filter((s) => s.end_time >= options.fromIso!);
  if (options?.toIso) list = list.filter((s) => s.start_time <= options.toIso!);
  return list;
}

function saveLocalTrajectoryToStorage(seg: TrajectorySegment) {
  const existingIdx = inMemoryTrajectoryCache.findIndex((s) => s.id === seg.id);
  if (existingIdx >= 0) inMemoryTrajectoryCache[existingIdx] = seg;
  else {
    inMemoryTrajectoryCache.push(seg);
    if (inMemoryTrajectoryCache.length > 500) inMemoryTrajectoryCache.shift();
  }

  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY_TRAJECTORIES);
      const list = raw ? (JSON.parse(raw) as TrajectorySegment[]) : [];
      const idx = list.findIndex((s) => s.id === seg.id);
      if (idx >= 0) list[idx] = seg;
      else list.push(seg);
      const trimmed = list.slice(-500);
      localStorage.setItem(KEY_TRAJECTORIES, JSON.stringify(trimmed));
    } catch {
      /* ignore */
    }
  }
}

const IS_TEST =
  typeof process !== "undefined" &&
  (Boolean(process.env["VITEST"]) || process.env["NODE_ENV"] === "test");

function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  const timeoutMs = ms ?? (IS_TEST ? 200 : 1500);
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Firestore timeout")), timeoutMs),
    ),
  ]);
}

export function getFirestoreDb(): Firestore | null {
  if (firestoreInstance) return firestoreInstance;
  const app = getFirebaseApp();
  if (!app) return null;
  try {
    firestoreInstance = getFirestore(app);
    return firestoreInstance;
  } catch (err) {
    console.warn("[Firebase] Firestore initialization error:", err);
    return null;
  }
}

export const DEFAULT_RTDB_USER_ID = "tLFl6MTucSNEdVlajznusTNMXv43";

export function getEffectiveUserId(userId?: string): string {
  if (!userId || userId.startsWith("usr_")) {
    return DEFAULT_RTDB_USER_ID;
  }
  return userId;
}

export interface RtdbTargetData {
  present?: boolean;
  count?: number | string;
  x_mm?: number | string;
  y_mm?: number | string;
  speed_cm_s?: number | string;
  target_id?: number;
  id?: number;
  speed_cms?: number | string;
  distance_m?: number | string;
}

export interface RtdbDevicePayload {
  room_id?: string | null;
  latest?: {
    ms?: number;
    rd60?: {
      target?: RtdbTargetData;
      situation?: string;
    };
    rd61?: {
      target?: RtdbTargetData;
      situation?: string;
    };
    target?: RtdbTargetData;
    targets?: RtdbTargetData[];
    situation?: string;
  };
}

export const firebaseDb = {
  isReady(): boolean {
    return isFirebaseConfigured() && getFirestoreDb() !== null;
  },

  /* ---------------- User Profile ---------------- */
  async getUserProfile(uid: string): Promise<UserProfile | null> {
    const db = getFirestoreDb();
    if (!db) return null;
    try {
      const snap = await getDoc(doc(db, "users", uid));
      if (!snap.exists()) return null;
      return { uid: snap.id, ...(snap.data() as Omit<UserProfile, "uid">) };
    } catch {
      return null;
    }
  },

  async saveUserProfile(profile: UserProfile): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    try {
      await setDoc(
        doc(db, "users", profile.uid),
        {
          ...profile,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    } catch {
      /* ignore */
    }
  },

  /* ---------------- Rooms ---------------- */
  async getRooms(userId?: string): Promise<Room[]> {
    const db = getFirestoreDb();
    if (!db) return [];
    try {
      const col = collection(db, "rooms");
      const q = userId
        ? query(col, where("user_id", "==", userId))
        : query(col, orderBy("created_at"));
      const snapshot = await withTimeout(getDocs(q));
      return snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Room, "id">),
      }));
    } catch (err) {
      logFirestoreWarning("Fetching rooms fallback", err);
      return [];
    }
  },

  async createRoom(room: {
    name: string;
    width_mm: number;
    length_mm: number;
    description?: string | null | undefined;
    doors?: Door[] | undefined;
    zones?: RoomZone[] | undefined;
    objects?: RoomObject[] | undefined;
    shape?: "rectangle" | "polygon" | undefined;
    polygon_vertices?: Array<{ x_mm: number; y_mm: number }> | undefined;
    user_id: string;
  }): Promise<string> {
    const db = getFirestoreDb();
    if (!db) throw new Error("Firebase is not initialized");
    const col = collection(db, "rooms");
    const docRef = await addDoc(col, {
      ...room,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return docRef.id;
  },

  async updateRoom(roomId: string, updates: Partial<Room>): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    try {
      const ref = doc(db, "rooms", roomId);
      await updateDoc(ref, {
        ...updates,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      logFirestoreWarning("Update room fallback", err);
    }
  },

  /* ---------------- Room Zones ---------------- */
  async getZones(roomId: string): Promise<RoomZone[]> {
    if (!roomId) return [];
    const db = getFirestoreDb();
    if (!db) return getLocalZonesFromStorage(roomId);
    try {
      const col = collection(db, "room_zones");
      const q = query(col, where("room_id", "==", roomId));
      const snapshot = await withTimeout(getDocs(q));
      const zones = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<RoomZone, "id">),
      }));
      if (zones.length === 0) return getLocalZonesFromStorage(roomId);
      return zones;
    } catch {
      return getLocalZonesFromStorage(roomId);
    }
  },

  async saveZone(zone: RoomZone): Promise<void> {
    if (!zone.room_id) return;
    saveLocalZoneToStorage(zone);
    const db = getFirestoreDb();
    if (!db) return;
    try {
      await withTimeout(setDoc(doc(db, "room_zones", zone.id), zone, { merge: true }));
    } catch {
      /* ignore */
    }
  },

  async deleteZone(zoneId: string): Promise<void> {
    deleteLocalZoneFromStorage(zoneId);
    const db = getFirestoreDb();
    if (!db) return;
    try {
      await withTimeout(deleteDoc(doc(db, "room_zones", zoneId)));
    } catch {
      /* ignore */
    }
  },

  /* ---------------- Room Objects (Furniture) ---------------- */
  async getRoomObjects(roomId: string): Promise<RoomObject[]> {
    if (!roomId) return [];
    const db = getFirestoreDb();
    if (!db) return getLocalObjectsFromStorage(roomId);
    try {
      const col = collection(db, "room_objects");
      const q = query(col, where("room_id", "==", roomId));
      const snapshot = await withTimeout(getDocs(q));
      const objs = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<RoomObject, "id">),
      }));
      if (objs.length === 0) return getLocalObjectsFromStorage(roomId);
      return objs;
    } catch {
      return getLocalObjectsFromStorage(roomId);
    }
  },

  async saveRoomObject(obj: RoomObject): Promise<void> {
    if (!obj.room_id) return;
    saveLocalObjectToStorage(obj);
    const db = getFirestoreDb();
    if (!db) return;
    try {
      await withTimeout(setDoc(doc(db, "room_objects", obj.id), obj, { merge: true }));
    } catch {
      /* ignore */
    }
  },

  async deleteRoomObject(objId: string): Promise<void> {
    deleteLocalObjectFromStorage(objId);
    const db = getFirestoreDb();
    if (!db) return;
    try {
      await withTimeout(deleteDoc(doc(db, "room_objects", objId)));
    } catch {
      /* ignore */
    }
  },

  async deleteRoom(roomId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error("Firebase is not initialized");
    const ref = doc(db, "rooms", roomId);
    await deleteDoc(ref);
  },

  subscribeToRooms(callback: (rooms: Room[]) => void, userId?: string): Unsubscribe {
    const db = getFirestoreDb();
    if (!db) return () => {};
    try {
      const col = collection(db, "rooms");
      const q = userId
        ? query(col, where("user_id", "==", userId))
        : query(col, orderBy("created_at"));
      return onSnapshot(
        q,
        (snap) => {
          const rooms = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<Room, "id">),
          }));
          callback(rooms);
        },
        () => {
          /* ignore error on snapshot */
        },
      );
    } catch {
      return () => {};
    }
  },

  /* ---------------- Devices ---------------- */
  async getDevices(userId?: string): Promise<Device[]> {
    const db = getFirestoreDb();
    const rtdb = getFirebaseRtdb();
    const effectiveUserId = getEffectiveUserId(userId);

    let firestoreDevs: Device[] = [];
    if (db) {
      try {
        const col = collection(db, "devices");
        const q = userId ? query(col, where("user_id", "==", userId)) : col;
        const snapshot = await withTimeout(getDocs(q), 2500);
        firestoreDevs = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Device, "id">),
        }));
      } catch (err) {
        logFirestoreWarning("Fetching devices fallback", err);
      }
    }

    let rtdbDevs: Device[] = [];
    if (rtdb && effectiveUserId) {
      const uidsToQuery = Array.from(new Set([effectiveUserId, DEFAULT_RTDB_USER_ID]));
      for (const uid of uidsToQuery) {
        try {
          const devRef = rtdbRef(rtdb, `users/${uid}/devices`);
          const snap = await withTimeout(rtdbGet(devRef), 2500);
          if (snap.exists()) {
            const val = snap.val() as Record<string, RtdbDevicePayload>;
            const nowIso = new Date().toISOString();
            for (const [devKey, devVal] of Object.entries(val)) {
              const latest = devVal?.latest;
              const isOnline = Boolean(latest);
              rtdbDevs.push({
                id: devKey,
                user_id: uid,
                device_id: devKey,
                device_name: `Radar Hub (${devKey})`,
                device_type: "esp32",
                room_id: devVal?.room_id ?? "b2c3d4e5-6677-8899-0011-223344556677",
                status: isOnline ? "connected" : "disconnected",
                last_seen: isOnline ? nowIso : null,
                created_at: nowIso,
                updated_at: nowIso,
              });
            }
          }
        } catch (err) {
          const msg = String(err);
          if (
            msg.includes("Permission denied") ||
            (err as { code?: string })?.code === "PERMISSION_DENIED"
          ) {
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("roomtrace_rtdb_permission_denied", { detail: { uid } }),
              );
            }
          }
        }
      }
    }

    const mergedMap = new Map<string, Device>();
    for (const d of firestoreDevs) {
      mergedMap.set(d.device_id, d);
    }
    for (const rd of rtdbDevs) {
      const existing = mergedMap.get(rd.device_id);
      if (existing) {
        mergedMap.set(rd.device_id, {
          ...existing,
          status: rd.status,
          last_seen: rd.last_seen || existing.last_seen,
        });
      } else {
        mergedMap.set(rd.device_id, rd);
      }
    }

    return [...mergedMap.values()];
  },

  async createDevice(device: Omit<Device, "id">): Promise<string> {
    const db = getFirestoreDb();
    if (!db) throw new Error("Firebase is not initialized");
    const col = collection(db, "devices");
    const docRef = await addDoc(col, {
      ...device,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return docRef.id;
  },

  async updateDevice(deviceId: string, updates: Partial<Device>): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error("Firebase is not initialized");
    const ref = doc(db, "devices", deviceId);
    await updateDoc(ref, {
      ...updates,
      updated_at: new Date().toISOString(),
    });
  },

  async deleteDevice(deviceId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error("Firebase is not initialized");
    const ref = doc(db, "devices", deviceId);
    await deleteDoc(ref);
  },

  async assignDeviceRoom(deviceId: string, roomId: string | null): Promise<void> {
    await this.updateDevice(deviceId, { room_id: roomId });
  },

  subscribeToDevices(callback: (devices: Device[]) => void, userId?: string): Unsubscribe {
    const db = getFirestoreDb();
    const rtdb = getFirebaseRtdb();
    const effectiveUserId = getEffectiveUserId(userId);

    let firestoreDevs: Device[] = [];
    let rtdbDevs: Device[] = [];

    const emitMerged = () => {
      const mergedMap = new Map<string, Device>();
      for (const d of firestoreDevs) {
        mergedMap.set(d.device_id, d);
      }
      for (const rd of rtdbDevs) {
        const existing = mergedMap.get(rd.device_id);
        if (existing) {
          mergedMap.set(rd.device_id, {
            ...existing,
            status: rd.status,
            last_seen: rd.last_seen || existing.last_seen,
          });
        } else {
          mergedMap.set(rd.device_id, rd);
        }
      }
      callback([...mergedMap.values()]);
    };

    let unsubFirestore: Unsubscribe = () => {};
    if (db) {
      try {
        const col = collection(db, "devices");
        const q = userId ? query(col, where("user_id", "==", userId)) : col;
        unsubFirestore = onSnapshot(
          q,
          (snap) => {
            firestoreDevs = snap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<Device, "id">),
            }));
            emitMerged();
          },
          () => {
            /* ignore error */
          },
        );
      } catch {
        /* ignore */
      }
    }

    const unsubsRtdb: Unsubscribe[] = [];
    if (rtdb) {
      const uids = Array.from(new Set([effectiveUserId, DEFAULT_RTDB_USER_ID]));
      for (const uid of uids) {
        try {
          const devRef = rtdbRef(rtdb, `users/${uid}/devices`);
          const unsub = rtdbOnValue(
            devRef,
            (snap) => {
              if (snap.exists()) {
                const val = snap.val() as Record<string, RtdbDevicePayload>;
                const nowIso = new Date().toISOString();
                rtdbDevs = Object.entries(val).map(([devKey, devVal]) => {
                  const latest = devVal?.latest;
                  const isOnline = Boolean(latest);
                  return {
                    id: devKey,
                    user_id: uid,
                    device_id: devKey,
                    device_name: `Radar Hub (${devKey})`,
                    device_type: "esp32",
                    room_id: devVal?.room_id ?? "b2c3d4e5-6677-8899-0011-223344556677",
                    status: isOnline ? "connected" : "disconnected",
                    last_seen: isOnline ? nowIso : null,
                    created_at: nowIso,
                    updated_at: nowIso,
                  };
                });
                emitMerged();
              }
            },
            (err) => {
              console.warn("[RTDB Devices] Read error:", err);
              const msg = String(err);
              if (
                msg.includes("Permission denied") ||
                (err as { code?: string })?.code === "PERMISSION_DENIED"
              ) {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("roomtrace_rtdb_permission_denied", { detail: { uid } }),
                  );
                }
              }
            },
          );
          unsubsRtdb.push(unsub);
        } catch (err) {
          console.warn("[RTDB Devices] Setup error:", err);
        }
      }
    }

    return () => {
      unsubFirestore();
      unsubsRtdb.forEach((u) => u());
    };
  },

  subscribeToRtdbLiveTelemetry(
    userId: string | undefined,
    callback: (telemetry: { deviceId: string; timestamp: number; targets: LD2450Target[] }) => void,
  ): Unsubscribe {
    const rtdb = getFirebaseRtdb();
    const effectiveUserId = getEffectiveUserId(userId);
    if (!rtdb) return () => {};

    const uidsToListen = Array.from(new Set([effectiveUserId, DEFAULT_RTDB_USER_ID]));
    const unsubs: Unsubscribe[] = [];

    for (const uid of uidsToListen) {
      try {
        const devRef = rtdbRef(rtdb, `users/${uid}/devices`);
        const unsub = rtdbOnValue(
          devRef,
          (snap) => {
            if (!snap.exists()) return;
            const val = snap.val() as Record<string, RtdbDevicePayload>;
            for (const [devKey, devVal] of Object.entries(val)) {
              const latest = devVal?.latest;
              if (!latest) continue;

              const rd60 = latest.rd60 || latest.rd61;
              const target = rd60?.target || latest.target;
              const targets: LD2450Target[] = [];

              if (target && (target.present || Number(target.count) > 0 || target.x_mm !== undefined)) {
                targets.push({
                  target_id: 1,
                  x_mm: Number(target.x_mm) || 0,
                  y_mm: Number(target.y_mm) || 0,
                  speed_cms: Number(target.speed_cm_s ?? target.speed_cms) || 0,
                });
              } else if (Array.isArray(latest.targets)) {
                for (let i = 0; i < latest.targets.length; i++) {
                  const t = latest.targets[i];
                  if (!t) continue;
                  targets.push({
                    target_id: t.target_id ?? t.id ?? i + 1,
                    x_mm: Number(t.x_mm) || 0,
                    y_mm: Number(t.y_mm) || 0,
                    speed_cms: Number(t.speed_cms ?? t.speed_cm_s) || 0,
                  });
                }
              }

              callback({
                deviceId: devKey,
                timestamp: Date.now(),
                targets,
              });
            }
          },
          (err) => {
            console.warn("[RTDB Telemetry] Read error:", err);
            const msg = String(err);
            if (
              msg.includes("Permission denied") ||
              (err as { code?: string })?.code === "PERMISSION_DENIED"
            ) {
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("roomtrace_rtdb_permission_denied", { detail: { uid } }),
                );
              }
            }
          },
        );
        unsubs.push(unsub);
      } catch (err) {
        console.warn("[RTDB Telemetry] Setup error:", err);
      }
    }

    return () => {
      unsubs.forEach((u) => u());
    };
  },

  /* ---------------- Sensors ---------------- */
  async getSensors(deviceId?: string, userId?: string): Promise<Sensor[]> {
    const db = getFirestoreDb();
    let firestoreSensors: Sensor[] = [];
    if (db && userId) {
      try {
        const col = collection(db, "sensors");
        const q = deviceId
          ? query(col, where("user_id", "==", userId), where("device_id", "==", deviceId))
          : query(col, where("user_id", "==", userId));
        const snapshot = await withTimeout(getDocs(q), 2500);
        firestoreSensors = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Sensor, "id">),
        }));
      } catch {
        /* fallback */
      }
    }
    if (firestoreSensors.length > 0) return firestoreSensors;

    // Default hardware sensors for roomtrace_01
    if (!deviceId || deviceId === "roomtrace_01") {
      return [
        {
          id: "sensor-ld2450-roomtrace-01",
          device_id: "roomtrace_01",
          user_id: userId || DEFAULT_RTDB_USER_ID,
          sensor_type: "ld2450",
          model: "HLK-LD2450",
          status: "active",
          configuration: { baud_rate: 256000, target_mode: "multi-target" },
          created_at: new Date().toISOString(),
        },
        {
          id: "sensor-rd61-roomtrace-01",
          device_id: "roomtrace_01",
          user_id: userId || DEFAULT_RTDB_USER_ID,
          sensor_type: "rd61",
          model: "Ai-Thinker RD-61",
          status: "active",
          configuration: { baud_rate: 115200, firmware_build: "#2967 Standard Point Cloud V1.0.0" },
          created_at: new Date().toISOString(),
        },
      ];
    }
    return [];
  },

  async updateSensor(sensorId: string, updates: Partial<Sensor>): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error("Firebase is not initialized");
    const ref = doc(db, "sensors", sensorId);
    await updateDoc(ref, updates as Record<string, unknown>);
  },

  /* ---------------- Occupancy Events ---------------- */
  async getEvents(filters?: {
    roomId?: string | undefined;
    fromIso?: string | undefined;
    toIso?: string | undefined;
    eventType?: string | undefined;
    sensorType?: string | undefined;
    severity?: AlertSeverity | undefined;
    acknowledged?: boolean | undefined;
    includeSimulated?: boolean | undefined;
    limitCount?: number | undefined;
  }): Promise<{ rows: OccupancyEvent[]; count: number }> {
    const filterLocal = (events: OccupancyEvent[]) => {
      let res = events;
      if (filters?.roomId) res = res.filter((r) => r.room_id === filters.roomId);
      if (filters?.sensorType) res = res.filter((r) => r.sensor_type === filters.sensorType);
      if (filters?.eventType) res = res.filter((r) => r.event_type === filters.eventType);
      if (filters?.severity) res = res.filter((r) => r.severity === filters.severity);
      if (filters?.acknowledged !== undefined)
        res = res.filter((r) => (r.acknowledged ?? false) === filters.acknowledged);
      if (filters?.includeSimulated === false) res = res.filter((r) => !r.simulated);
      if (filters?.fromIso) res = res.filter((r) => r.timestamp >= filters.fromIso!);
      if (filters?.toIso) res = res.filter((r) => r.timestamp <= filters.toIso!);
      return { rows: res.slice(0, filters?.limitCount ?? 50), count: res.length };
    };

    if (!filters?.roomId) {
      // Security: never run an unscoped query against occupancy_events.
      return filterLocal(getLocalEventsFromStorage());
    }

    const db = getFirestoreDb();
    if (!db) return filterLocal(getLocalEventsFromStorage());
    try {
      const col = collection(db, "occupancy_events");
      const q = query(
        col,
        where("room_id", "==", filters.roomId),
        orderBy("timestamp", "desc"),
        limit(filters?.limitCount ?? 50),
      );
      const snapshot = await withTimeout(getDocs(q));
      let rows = snapshot.docs.map((d) => {
        const data = d.data();
        let ackAt = data["acknowledged_at"];
        if (
          ackAt &&
          typeof ackAt === "object" &&
          typeof (ackAt as { toDate?: () => Date }).toDate === "function"
        ) {
          ackAt = (ackAt as { toDate: () => Date }).toDate().toISOString();
        }
        return {
          id: d.id,
          ...(data as Omit<OccupancyEvent, "id">),
          acknowledged_at: typeof ackAt === "string" ? ackAt : ackAt ? String(ackAt) : null,
        };
      });
      if (filters?.sensorType) {
        rows = rows.filter((r) => r.sensor_type === filters.sensorType);
      }
      if (filters?.eventType) {
        rows = rows.filter((r) => r.event_type === filters.eventType);
      }
      if (filters?.severity) {
        rows = rows.filter((r) => r.severity === filters.severity);
      }
      if (filters?.acknowledged !== undefined) {
        rows = rows.filter((r) => (r.acknowledged ?? false) === filters.acknowledged);
      }
      if (filters?.includeSimulated === false) {
        rows = rows.filter((r) => !r.simulated);
      }
      if (filters?.fromIso) {
        rows = rows.filter((r) => r.timestamp >= filters.fromIso!);
      }
      if (filters?.toIso) {
        rows = rows.filter((r) => r.timestamp <= filters.toIso!);
      }
      if (rows.length === 0) {
        const local = filterLocal(getLocalEventsFromStorage());
        if (local.rows.length > 0) return local;
      }
      return { rows, count: rows.length };
    } catch (err) {
      logFirestoreWarning("Events query fallback", err);
      return filterLocal(getLocalEventsFromStorage());
    }
  },

  async recordEvent(event: Omit<OccupancyEvent, "id">): Promise<string> {
    const fallbackId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    saveLocalEventToStorage({ id: fallbackId, ...event });

    const db = getFirestoreDb();
    if (!db) return fallbackId;
    try {
      const col = collection(db, "occupancy_events");
      const docRef = await withTimeout(addDoc(col, event));
      return docRef.id;
    } catch {
      return fallbackId;
    }
  },

  async acknowledgeEvent(options: {
    eventId: string;
    roomId: string;
    simulated: boolean;
    userId: string;
  }): Promise<void> {
    const ackTime = new Date().toISOString();
    // Update local storage
    const local = getLocalEventsFromStorage();
    const found = local.find((e) => e.id === options.eventId);
    if (found) {
      found.acknowledged = true;
      found.acknowledged_at = ackTime;
      found.acknowledged_by = options.userId;
      saveLocalEventToStorage(found);
    }
    const memFound = inMemoryEventsCache.find((e) => e.id === options.eventId);
    if (memFound) {
      memFound.acknowledged = true;
      memFound.acknowledged_at = ackTime;
      memFound.acknowledged_by = options.userId;
    }

    const db = getFirestoreDb();
    if (!db) return;
    try {
      const ref = doc(db, "occupancy_events", options.eventId);
      await updateDoc(ref, {
        acknowledged: true,
        acknowledged_at: serverTimestamp(),
        acknowledged_by: options.userId,
      });
    } catch {
      /* ignore */
    }
  },

  async clearSimulatedEvents(roomId: string): Promise<void> {
    if (!roomId) return;
    const kept = inMemoryEventsCache.filter((e) => !e.simulated || e.room_id !== roomId);
    inMemoryEventsCache.length = 0;
    inMemoryEventsCache.push(...kept);

    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(KEY_EVENTS, JSON.stringify(kept));
      } catch {
        /* ignore */
      }
    }
    const db = getFirestoreDb();
    if (!db) return;
    try {
      const col = collection(db, "occupancy_events");
      const q = query(col, where("room_id", "==", roomId), where("simulated", "==", true));
      const snapshot = await withTimeout(getDocs(q));
      const deletes = snapshot.docs.map((d) => deleteDoc(d.ref));
      await Promise.all(deletes);
    } catch {
      /* ignore */
    }
  },

  subscribeToLiveEvents(
    callback: (events: OccupancyEvent[]) => void,
    roomId: string,
    limitCount = 20,
  ): Unsubscribe {
    const db = getFirestoreDb();
    if (!db || !roomId) return () => {};
    try {
      const col = collection(db, "occupancy_events");
      const q = query(
        col,
        where("room_id", "==", roomId),
        orderBy("timestamp", "desc"),
        limit(limitCount),
      );
      return onSnapshot(
        q,
        (snap) => {
          const events = snap.docs.map((d) => {
            const data = d.data();
            let ackAt = data["acknowledged_at"];
            if (
              ackAt &&
              typeof ackAt === "object" &&
              typeof (ackAt as { toDate?: () => Date }).toDate === "function"
            ) {
              ackAt = (ackAt as { toDate: () => Date }).toDate().toISOString();
            }
            return {
              id: d.id,
              ...(data as Omit<OccupancyEvent, "id">),
              acknowledged_at: typeof ackAt === "string" ? ackAt : ackAt ? String(ackAt) : null,
            };
          });
          callback(events);
        },
        () => {
          /* ignore error */
        },
      );
    } catch {
      return () => {};
    }
  },

  /* ---------------- Telemetry ---------------- */
  async getLatestTelemetry(roomId: string): Promise<TelemetryRecord[]> {
    if (!roomId) return [];
    const db = getFirestoreDb();
    if (!db) return [];
    try {
      const col = collection(db, "telemetry");
      const q = query(col, where("room_id", "==", roomId), orderBy("timestamp", "desc"), limit(50));
      const snapshot = await withTimeout(getDocs(q));
      return snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<TelemetryRecord, "id">),
      }));
    } catch {
      return [];
    }
  },

  subscribeToLatestTelemetry(
    callback: (records: TelemetryRecord[]) => void,
    roomId: string,
  ): Unsubscribe {
    const db = getFirestoreDb();
    if (!db || !roomId) return () => {};
    try {
      const col = collection(db, "telemetry");
      const q = query(col, where("room_id", "==", roomId), orderBy("timestamp", "desc"), limit(30));
      return onSnapshot(
        q,
        (snap) => {
          const items = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<TelemetryRecord, "id">),
          }));
          callback(items);
        },
        () => {
          /* ignore error */
        },
      );
    } catch {
      return () => {};
    }
  },

  /* ---------------- Trajectories (Phase 2) ---------------- */
  async saveTrajectorySegment(segment: TrajectorySegment): Promise<string> {
    saveLocalTrajectoryToStorage(segment);
    const db = getFirestoreDb();
    if (!db) return segment.id;
    try {
      const col = collection(db, "trajectory_segments");
      await withTimeout(setDoc(doc(col, segment.id), segment, { merge: true }));
      return segment.id;
    } catch (err) {
      logFirestoreWarning("Save trajectory segment fallback", err);
      return segment.id;
    }
  },

  async saveTrajectoryBatch(segments: TrajectorySegment[]): Promise<void> {
    for (const s of segments) saveLocalTrajectoryToStorage(s);
    const db = getFirestoreDb();
    if (!db) return;
    try {
      const col = collection(db, "trajectory_segments");
      await withTimeout(
        Promise.all(segments.map((seg) => setDoc(doc(col, seg.id), seg, { merge: true }))),
      );
    } catch (err) {
      logFirestoreWarning("Save trajectory batch fallback", err);
    }
  },

  async getTrajectorySegments(options: {
    roomId: string;
    fromIso?: string | undefined;
    toIso?: string | undefined;
    simulated?: boolean | undefined;
    sensorType?: "ld2450" | "rd61" | undefined;
    targetId?: number | undefined;
    limitCount?: number | undefined;
  }): Promise<TrajectorySegment[]> {
    const fallback = () =>
      getLocalTrajectoriesFromStorage({
        roomId: options.roomId,
        simulated: options.simulated,
        sensorType: options.sensorType,
        targetId: options.targetId,
        fromIso: options.fromIso,
        toIso: options.toIso,
      });

    const db = getFirestoreDb();
    if (!db) return fallback();
    try {
      const col = collection(db, "trajectory_segments");
      let q = query(
        col,
        where("room_id", "==", options.roomId),
        orderBy("start_epoch", "asc"),
        limit(options.limitCount ?? 300),
      );
      if (options.simulated !== undefined) {
        q = query(
          col,
          where("room_id", "==", options.roomId),
          where("simulated", "==", options.simulated),
          orderBy("start_epoch", "asc"),
          limit(options.limitCount ?? 300),
        );
      }
      const snapshot = await withTimeout(getDocs(q));
      let list = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<TrajectorySegment, "id">),
      }));
      if (options.sensorType) {
        list = list.filter((s) => s.sensor_type === options.sensorType);
      }
      if (options.targetId !== undefined) {
        list = list.filter((s) => s.target_id === options.targetId);
      }
      if (options.fromIso) {
        list = list.filter((s) => s.end_time >= options.fromIso!);
      }
      if (options.toIso) {
        list = list.filter((s) => s.start_time <= options.toIso!);
      }
      if (list.length === 0) return fallback();
      return list;
    } catch (err) {
      logFirestoreWarning("Get trajectory segments fallback", err);
      return fallback();
    }
  },

  async clearSimulatedTrajectories(roomId: string): Promise<void> {
    if (!roomId) return;
    const kept = inMemoryTrajectoryCache.filter((s) => !s.simulated || s.room_id !== roomId);
    inMemoryTrajectoryCache.length = 0;
    inMemoryTrajectoryCache.push(...kept);

    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(KEY_TRAJECTORIES, JSON.stringify(kept));
      } catch {
        /* ignore */
      }
    }
    const db = getFirestoreDb();
    if (!db) return;
    try {
      const col = collection(db, "trajectory_segments");
      const q = query(col, where("room_id", "==", roomId), where("simulated", "==", true));
      const snapshot = await withTimeout(getDocs(q));
      const deletes = snapshot.docs.map((d) => deleteDoc(d.ref));
      await Promise.all(deletes);
    } catch {
      /* ignore */
    }
  },
};

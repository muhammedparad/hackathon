import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { firebaseDb, type Device } from "@/lib/firebase/db";
import { authClient } from "@/lib/auth";
import { connectLive } from "@/lib/live/ws-client";
import { roomsQuery, type Room } from "@/lib/data";
import { RoomSimulator, type Scenario } from "./simulation";
import { RD61Tracker } from "./rd61-tracker";
import { AlertEngine } from "./alert-engine";
import type {
  AlertSeverity,
  DataMode,
  EventEvidence,
  EventType,
  LD2450Frame,
  RD61Frame,
} from "./types";
import { STALE_AFTER_MS } from "./types";

export interface RoomLive {
  ld?: LD2450Frame | undefined;
  rd?: RD61Frame | undefined;
}
export interface LiveEvent {
  id: string;
  room_id: string;
  event_type: EventType;
  description: string;
  target_id?: number | undefined;
  sensor_type?: "ld2450" | "rd61" | null | undefined;
  simulated: boolean;
  timestamp: number;
  severity?: AlertSeverity | undefined;
  zone_id?: string | null | undefined;
  zone_name?: string | null | undefined;
  x_mm?: number | null | undefined;
  y_mm?: number | null | undefined;
  z_mm?: number | null | undefined;
  evidence?: EventEvidence | undefined;
  confidence?: "low" | "medium" | "high" | undefined;
}
export type SimStatus = "running" | "paused" | "stopped";
const WS_FRESH_MS = 3000;
export type StreamStatus = "simulated" | "connecting" | "live" | "offline";

interface Ctx {
  mode: DataMode;
  setMode: (m: DataMode) => void;
  simStatus: SimStatus;
  start: () => void;
  pause: () => void;
  stop: () => void;
  reset: () => void;
  speed: number;
  setSpeed: (n: number) => void;
  scenarios: Record<string, Scenario>;
  setScenario: (roomId: string, s: Scenario) => void;
  frames: Record<string, RoomLive>;
  liveEvents: LiveEvent[];
  streamStatus: StreamStatus;
  persistSimEvents: boolean;
  setPersistSimEvents: (b: boolean) => void;
  selectedRoomId: string | null;
  setSelectedRoomId: (id: string) => void;
  now: number;
}

const LiveCtx = createContext<Ctx | null>(null);
const TICK_MS = 150;

function useStored<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setV(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
  }, [key]);
  const set = useCallback(
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(key, JSON.stringify(n));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set] as const;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { data: rooms = [] } = useQuery(roomsQuery);
  const qc = useQueryClient();
  const [mode, setMode] = useStored<DataMode>("rt.mode", "simulation");
  const [speed, setSpeed] = useStored<number>("rt.speed", 1);
  const [persistSimEvents, setPersistSimEvents] = useStored<boolean>("rt.persistSim", true);
  const [selectedRoomId, setSelectedRoomIdRaw] = useStored<string | null>("rt.room", null);
  const [simStatus, setSimStatus] = useState<SimStatus>("running");
  const [scenarios, setScenarios] = useState<Record<string, Scenario>>({});
  const [frames, setFrames] = useState<Record<string, RoomLive>>({});
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("simulated");
  const [now, setNow] = useState(() => Date.now());
  const sims = useRef(new Map<string, RoomSimulator>());
  const rd61Trackers = useRef(new Map<string, RD61Tracker>());
  // Time of the last frame pushed over the live WebSocket. While it is fresh, slower Firestore
  // snapshots must not overwrite it with an older frame.
  const wsLastFrameAt = useRef(0);
  const alertEngines = useRef(new Map<string, AlertEngine>());
  const prevIds = useRef(new Map<string, Set<number>>());
  const prevConnected = useRef(new Map<string, boolean>());
  const lastMoveEvt = useRef(new Map<string, number>());
  const persistRef = useRef(persistSimEvents);
  persistRef.current = persistSimEvents;

  const selected = rooms.find((r) => r.id === selectedRoomId)?.id ?? rooms[0]?.id ?? null;

  // keep simulators in sync with configured rooms
  useEffect(() => {
    const m = sims.current;
    for (const r of rooms) {
      const ex = m.get(r.id);
      if (!ex || ex.room.width_mm !== r.width_mm || ex.room.length_mm !== r.length_mm) {
        m.set(r.id, new RoomSimulator(r, scenarios[r.id] ?? "multiple"));
      }
    }
    for (const id of [...m.keys()]) if (!rooms.some((r) => r.id === id)) m.delete(id);
  }, [rooms]); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = useCallback(
    (
      room: Room,
      type: EventType,
      description: string,
      target_id?: number,
      sensorType: "ld2450" | "rd61" | null = "ld2450",
      severity: AlertSeverity = "info",
      extra?: {
        zone_id?: string | null;
        zone_name?: string | null;
        x_mm?: number | null;
        y_mm?: number | null;
        z_mm?: number | null;
        evidence?: EventEvidence | undefined;
        confidence?: "low" | "medium" | "high" | undefined;
      },
    ) => {
      const ev: LiveEvent = {
        id: crypto.randomUUID(),
        room_id: room.id,
        event_type: type,
        description,
        target_id,
        sensor_type: sensorType,
        simulated: true,
        timestamp: Date.now(),
        severity,
        zone_id: extra?.zone_id ?? null,
        zone_name: extra?.zone_name ?? null,
        x_mm: extra?.x_mm ?? null,
        y_mm: extra?.y_mm ?? null,
        z_mm: extra?.z_mm ?? null,
        evidence: extra?.evidence,
        confidence: extra?.confidence,
      };
      setLiveEvents((l) => [ev, ...l].slice(0, 50));
      if (persistRef.current) {
        void firebaseDb
          .recordEvent({
            room_id: room.id,
            event_type: type,
            description,
            target_id: target_id ?? null,
            sensor_type: sensorType,
            simulated: true,
            timestamp: new Date().toISOString(),
            severity,
            zone_id: extra?.zone_id ?? null,
            zone_name: extra?.zone_name ?? null,
            x_mm: extra?.x_mm ?? null,
            y_mm: extra?.y_mm ?? null,
            z_mm: extra?.z_mm ?? null,
            evidence: extra?.evidence,
            confidence: extra?.confidence,
          })
          .then((id) => {
            if (id) {
              qc.invalidateQueries({ queryKey: ["events"] });
            }
          })
          .catch(() => {
            /* ignore */
          });
      }
    },
    [qc],
  );

  // simulation loop
  useEffect(() => {
    if (mode !== "simulation") return;
    setStreamStatus("simulated");
    if (simStatus !== "running") return;
    const id = setInterval(() => {
      const t = Date.now();
      const next: Record<string, RoomLive> = {};
      for (const room of rooms) {
        const sim = sims.current.get(room.id);
        if (!sim) continue;
        sim.step((TICK_MS / 1000) * speed);
        const ld = sim.ld2450Frame(t) ?? undefined;
        const rd = sim.rd61Frame(t) ?? undefined;
        next[room.id] = { ld, rd };

        // derive sensor connection events
        const wasConn = prevConnected.current.get(room.id);
        if (wasConn !== undefined && wasConn !== sim.connected)
          emit(
            room,
            sim.connected ? "sensor_reconnected" : "sensor_disconnected",
            sim.connected ? "Simulated sensor reconnected" : "Simulated telemetry stopped",
            undefined,
            null,
            "info",
          );
        prevConnected.current.set(room.id, sim.connected);

        // 1. Process LD2450 target events & rule-based alerts
        if (ld) {
          const ids = new Set(ld.targets.map((x) => x.target_id));
          const prev = prevIds.current.get(room.id);
          if (prev) {
            for (const i of ids)
              if (!prev.has(i))
                emit(
                  room,
                  "target_detected",
                  `Target ${i} entered detection zone`,
                  i,
                  "ld2450",
                  "info",
                );
            for (const i of prev)
              if (!ids.has(i))
                emit(room, "target_lost", `Target ${i} left detection zone`, i, "ld2450", "info");
            if (prev.size === 0 && ids.size > 0)
              emit(
                room,
                "room_occupied",
                `${room.name} became occupied`,
                undefined,
                "ld2450",
                "info",
              );
            if (prev.size > 0 && ids.size === 0)
              emit(room, "room_vacant", `${room.name} became vacant`, undefined, "ld2450", "info");
            const moving = ld.targets.find((x) => Math.abs(x.speed_cms) > 30);
            const last = lastMoveEvt.current.get(room.id) ?? 0;
            if (moving && t - last > 30000) {
              lastMoveEvt.current.set(room.id, t);
              emit(
                room,
                "target_moved",
                `Target ${moving.target_id} moving at ${Math.abs(moving.speed_cms)} cm/s`,
                moving.target_id,
                "ld2450",
                "info",
              );
            }
          }
          prevIds.current.set(room.id, ids);

          // AlertEngine: explainable rules evaluation
          let engine = alertEngines.current.get(room.id);
          if (!engine) {
            engine = new AlertEngine(room);
            alertEngines.current.set(room.id, engine);
          } else {
            engine.updateRoom(room);
          }

          const detectedAlerts = engine.processTargets(ld.targets, t, true);
          for (const a of detectedAlerts) {
            emit(
              room,
              a.event_type,
              a.description,
              a.target_id ?? undefined,
              a.sensor_type,
              a.severity,
              {
                zone_id: a.zone_id ?? null,
                zone_name: a.zone_name ?? null,
                x_mm: a.x_mm,
                y_mm: a.y_mm,
                z_mm: a.z_mm ?? null,
                evidence: a.evidence,
                confidence: a.confidence,
              },
            );
          }
        }

        // 2. Process RD-61 point cloud events
        let tracker = rd61Trackers.current.get(room.id);
        if (!tracker) {
          tracker = new RD61Tracker();
          rd61Trackers.current.set(room.id, tracker);
        }
        tracker.processFrame(rd ?? null, room, emit);
      }
      setFrames(next);
      setNow(t);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [mode, simStatus, speed, rooms, emit]);

  // Continuous device status tracking from Firestore + RTDB across all pages and modes
  useEffect(() => {
    const unsubDevices = firebaseDb.subscribeToDevices((devices) => {
      qc.setQueryData(["devices"], devices);
    });
    return () => {
      unsubDevices();
    };
  }, [qc]);

  // hardware: only real telemetry, via Cloud Firestore + Realtime Database realtime listeners.
  useEffect(() => {
    if (mode !== "hardware") return;
    setFrames({});
    setStreamStatus("connecting");

    if (!firebaseDb.isReady()) {
      setStreamStatus("offline");
      return;
    }

    let cancelled = false;
    // seed with the latest stored frame per room
    void (async () => {
      try {
        const seed: Record<string, RoomLive> = {};
        for (const room of rooms) {
          const records = await firebaseDb.getLatestTelemetry(room.id);
          if (cancelled) return;
          for (const row of [...records].reverse()) applyRow(seed, row);
        }
        if (Object.keys(seed).length > 0) {
          setFrames(seed);
          setStreamStatus("live");
        }
      } catch {
        setStreamStatus("offline");
      }
    })();

    // Subscribe to Firestore live telemetry updates per room
    const unsubsTelemetry = rooms.map((room) =>
      firebaseDb.subscribeToLatestTelemetry((records) => {
        if (records.length > 0) setStreamStatus("live");
        setFrames((f) => {
          if (Date.now() - wsLastFrameAt.current < WS_FRESH_MS) return f;
          const n = { ...f };
          for (const rec of records) applyRow(n, rec);
          return n;
        });
      }, room.id),
    );

    const unsubsEvents = rooms.map((room) =>
      firebaseDb.subscribeToLiveEvents(() => {
        qc.invalidateQueries({ queryKey: ["events"] });
        qc.invalidateQueries({ queryKey: ["analytics-events"] });
      }, room.id),
    );

    // Live push from the server over WebSocket. Frames carry the device's room, so nothing is guessed
    // or made up here; "connected" for a device still comes only from the server's last_seen.
    const stopLive = connectLive({
      getToken: async () => (await authClient.getSession())?.token ?? null,
      onMessage: (m) => {
        if (cancelled) return;
        if (m.type === "frame") {
          qc.setQueryData<Device[]>(["devices"], (prev) =>
            prev?.map((d) => (d.id === m.device_id ? { ...d, last_seen: m.received_at } : d)),
          );
          const roomId = m.room_id;
          if (!roomId) return; // device not assigned to a room yet: nowhere to draw it
          wsLastFrameAt.current = Date.now();
          setStreamStatus("live");
          setFrames((f) => ({
            ...f,
            [roomId]: {
              ...f[roomId],
              ld: {
                sensor_type: "ld2450",
                origin: "hardware",
                room_id: roomId,
                timestamp: Date.now(),
                targets: m.targets,
              },
            },
          }));
        } else if (m.type === "device") {
          qc.setQueryData<Device[]>(["devices"], (prev) =>
            prev?.map((d) => (d.id === m.device_id ? { ...d, last_seen: m.last_seen } : d)),
          );
        }
      },
    });

    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(tick);
      unsubsTelemetry.forEach((u) => u());
      unsubsEvents.forEach((u) => u());
      stopLive();
    };
  }, [mode, qc, rooms, selected]);

  const value = useMemo<Ctx>(
    () => ({
      mode,
      setMode: (m) => {
        setMode(m);
        setLiveEvents([]);
        prevIds.current.clear();
        rd61Trackers.current.forEach((t) => t.reset());
        alertEngines.current.forEach((e) => e.reset());
      },
      simStatus,
      start: () => setSimStatus("running"),
      pause: () => setSimStatus("paused"),
      stop: () => {
        setSimStatus("stopped");
        setFrames({});
        prevIds.current.clear();
        rd61Trackers.current.forEach((t) => t.reset());
        alertEngines.current.forEach((e) => e.reset());
      },
      reset: () => {
        for (const [id, s] of sims.current) s.setScenario(scenarios[id] ?? "multiple");
        prevIds.current.clear();
        rd61Trackers.current.forEach((t) => t.reset());
        alertEngines.current.forEach((e) => e.reset());
        setLiveEvents([]);
        setSimStatus("running");
      },
      speed,
      setSpeed,
      scenarios,
      setScenario: (roomId, s) => {
        setScenarios((x) => ({ ...x, [roomId]: s }));
        sims.current.get(roomId)?.setScenario(s);
        rd61Trackers.current.get(roomId)?.reset();
        alertEngines.current.get(roomId)?.reset();
      },
      frames,
      liveEvents,
      streamStatus,
      persistSimEvents,
      setPersistSimEvents,
      selectedRoomId: selected,
      setSelectedRoomId: (id) => setSelectedRoomIdRaw(id),
      now,
    }),
    [
      mode,
      setMode,
      simStatus,
      speed,
      setSpeed,
      scenarios,
      frames,
      liveEvents,
      streamStatus,
      persistSimEvents,
      setPersistSimEvents,
      selected,
      setSelectedRoomIdRaw,
      now,
    ],
  );

  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

interface TelemetryRow {
  room_id: string | null;
  sensor_type: string;
  timestamp: string;
  payload: unknown;
}
function applyRow(map: Record<string, RoomLive>, row: TelemetryRow) {
  if (!row.room_id) return;
  const cur = (map[row.room_id] ??= {});
  const ts = new Date(row.timestamp).getTime();
  if (row.sensor_type === "ld2450") {
    const p = row.payload as { targets?: LD2450Frame["targets"] };
    cur.ld = {
      sensor_type: "ld2450",
      origin: "hardware",
      room_id: row.room_id,
      timestamp: ts,
      targets: p.targets ?? [],
    };
  } else if (row.sensor_type === "rd61") {
    const p = row.payload as { points?: RD61Frame["points"] };
    cur.rd = {
      sensor_type: "rd61",
      origin: "hardware",
      room_id: row.room_id,
      timestamp: ts,
      points: p.points ?? [],
    };
  }
}

export function useLive() {
  const c = useContext(LiveCtx);
  if (!c) throw new Error("useLive must be used inside LiveProvider");
  return c;
}

export function isStale(ts: number | undefined, now: number) {
  return ts === undefined || now - ts > STALE_AFTER_MS;
}

/** Room state derived from the latest LD2450 frame, or RD-61 point cloud when active. */
export function roomState(live: RoomLive | undefined, now: number, mode: DataMode) {
  if (!live?.ld && !live?.rd)
    return mode === "simulation" ? ("sensor_offline" as const) : ("unknown" as const);
  if (live.ld && !isStale(live.ld.timestamp, now)) {
    return live.ld.targets.length > 0 ? ("occupied" as const) : ("vacant" as const);
  }
  if (live.rd && !isStale(live.rd.timestamp, now)) {
    const activePoints = live.rd.points.filter((p) => p.snr >= 7.5);
    return activePoints.length >= 3 ? ("occupied" as const) : ("vacant" as const);
  }
  return "sensor_offline" as const;
}

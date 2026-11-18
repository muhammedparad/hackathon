import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { firebaseDb, type Device, type OccupancyEvent } from "@/lib/firebase/db";
import { authClient } from "@/lib/auth";
import { connectLive, type LiveConnState } from "@/lib/live/ws-client";
import { roomsQuery } from "@/lib/data";
import type { AlertSeverity, EventEvidence, EventType, LD2450Frame, RD61Frame } from "./types";
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
  sensor_type?: string | null | undefined;
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
/** connecting: waiting for the first data. live: real frames are arriving. offline: Firebase not configured. */
export type StreamStatus = "connecting" | "live" | "offline";

interface Ctx {
  /** Latest real frame per room (from the live WebSocket, falling back to stored telemetry). */
  frames: Record<string, RoomLive>;
  /** Real events recorded by the server, newest first. */
  liveEvents: LiveEvent[];
  streamStatus: StreamStatus;
  /**
   * How live data reaches this page right now: "websocket" = instant push from the server; "firestore" =
   * the slower stored-data listener (used when the socket is not connected); "none" = nothing arriving.
   */
  transport: "websocket" | "firestore" | "none";
  selectedRoomId: string | null;
  setSelectedRoomId: (id: string) => void;
  now: number;
}

const LiveCtx = createContext<Ctx | null>(null);

/** While the WebSocket delivered a frame this recently, slower Firestore snapshots must not overwrite it. */
const WS_FRESH_MS = 3000;

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

function toLiveEvent(e: OccupancyEvent): LiveEvent {
  return {
    id: e.id,
    room_id: e.room_id,
    event_type: e.event_type,
    description: e.description,
    target_id: e.target_id ?? undefined,
    sensor_type: e.sensor_type ?? null,
    timestamp: new Date(e.timestamp).getTime(),
    severity: e.severity,
    zone_id: e.zone_id ?? null,
    zone_name: e.zone_name ?? null,
    x_mm: e.x_mm ?? null,
    y_mm: e.y_mm ?? null,
    z_mm: e.z_mm ?? null,
    evidence: e.evidence,
    confidence: e.confidence,
  };
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { data: rooms = [] } = useQuery(roomsQuery);
  const qc = useQueryClient();
  const [selectedRoomId, setSelectedRoomIdRaw] = useStored<string | null>("rt.room", null);
  const [frames, setFrames] = useState<Record<string, RoomLive>>({});
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [wsState, setWsState] = useState<LiveConnState>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const wsLastFrameAt = useRef(0);

  const selected = rooms.find((r) => r.id === selectedRoomId)?.id ?? rooms[0]?.id ?? null;
  // Stable key: the rooms query returns a new array on every refetch, which must not reset listeners.
  const roomIdsKey = useMemo(() => rooms.map((r) => r.id).join(","), [rooms]);

  // Device list (and therefore "connected" state) always comes from the server's last_seen.
  useEffect(() => {
    let cancelled = false;
    let unsubDevices: () => void = () => {};
    void authClient.getUser().then((user) => {
      if (cancelled || !user) return;
      unsubDevices = firebaseDb.subscribeToDevices((devices) => {
        qc.setQueryData(["devices"], devices);
      }, user.id);
    });
    return () => {
      cancelled = true;
      unsubDevices();
    };
  }, [qc]);

  // Stored telemetry + real events per room (Firestore).
  useEffect(() => {
    if (!firebaseDb.isReady()) {
      setStreamStatus("offline");
      return;
    }
    const roomIds = roomIdsKey ? roomIdsKey.split(",") : [];
    let cancelled = false;

    // Seed with the latest stored frame per room so the page is not empty while waiting for live data.
    void (async () => {
      try {
        const seed: Record<string, RoomLive> = {};
        for (const roomId of roomIds) {
          const records = await firebaseDb.getLatestTelemetry(roomId);
          if (cancelled) return;
          for (const row of [...records].reverse()) applyRow(seed, row);
        }
        if (Object.keys(seed).length > 0) {
          setFrames((f) => ({ ...seed, ...f }));
          setStreamStatus("live");
        }
      } catch {
        /* the live feed may still deliver */
      }
    })();

    const unsubsTelemetry = roomIds.map((roomId) =>
      firebaseDb.subscribeToLatestTelemetry((records) => {
        if (records.length > 0) setStreamStatus("live");
        setFrames((f) => {
          if (Date.now() - wsLastFrameAt.current < WS_FRESH_MS) return f;
          const n = { ...f };
          for (const rec of records) applyRow(n, rec);
          return n;
        });
      }, roomId),
    );

    const perRoomEvents = new Map<string, LiveEvent[]>();
    const unsubsEvents = roomIds.map((roomId) =>
      firebaseDb.subscribeToLiveEvents((events) => {
        perRoomEvents.set(roomId, events.map(toLiveEvent));
        setLiveEvents(
          [...perRoomEvents.values()]
            .flat()
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50),
        );
        qc.invalidateQueries({ queryKey: ["events"] });
        qc.invalidateQueries({ queryKey: ["analytics-events"] });
      }, roomId),
    );

    return () => {
      cancelled = true;
      unsubsTelemetry.forEach((u) => u());
      unsubsEvents.forEach((u) => u());
    };
  }, [qc, roomIdsKey]);

  // Live push from the server over WebSocket. Frames carry the device's room, so nothing is guessed;
  // "connected" for a device still comes only from the server's last_seen.
  useEffect(() => {
    if (!firebaseDb.isReady()) return;
    let cancelled = false;
    const stopLive = connectLive({
      getToken: async () => (await authClient.getSession())?.token ?? null,
      onState: (s) => {
        if (!cancelled) setWsState(s);
      },
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
    return () => {
      cancelled = true;
      stopLive();
    };
  }, [qc]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const anyFresh = Object.values(frames).some((f) => f.ld && !isStale(f.ld.timestamp, now));
  const transport: Ctx["transport"] =
    wsState === "live" ? "websocket" : anyFresh || streamStatus === "live" ? "firestore" : "none";

  const value = useMemo<Ctx>(
    () => ({
      frames,
      liveEvents,
      streamStatus,
      transport,
      selectedRoomId: selected,
      setSelectedRoomId: (id) => setSelectedRoomIdRaw(id),
      now,
    }),
    [frames, liveEvents, streamStatus, transport, selected, setSelectedRoomIdRaw, now],
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

/**
 * Room state derived from the latest real LD2450 frame (or RD-61 point cloud when present).
 * "unknown" = no data has ever arrived; "sensor_offline" = data existed but stopped arriving.
 */
export function roomState(live: RoomLive | undefined, now: number) {
  if (!live?.ld && !live?.rd) return "unknown" as const;
  if (live.ld && !isStale(live.ld.timestamp, now)) {
    return live.ld.targets.length > 0 ? ("occupied" as const) : ("vacant" as const);
  }
  if (live.rd && !isStale(live.rd.timestamp, now)) {
    const activePoints = live.rd.points.filter((p) => p.snr >= 7.5);
    return activePoints.length >= 3 ? ("occupied" as const) : ("vacant" as const);
  }
  return "sensor_offline" as const;
}

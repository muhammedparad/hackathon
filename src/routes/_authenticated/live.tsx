import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Boxes, ShieldAlert, X } from "lucide-react";
import { devicesQuery, roomsQuery, trajectoriesQuery } from "@/lib/data";
import { isStale, roomState, useLive, type RoomLive } from "@/lib/radar/live";
import { deviceConnection, isPointInPolygon, type LD2450Target } from "@/lib/radar/types";
import { calculateMovementHeatmap, type SensorMountTransform } from "@/lib/analytics";
import { Empty, timeAgo } from "@/components/app/status";
import { LD2450View } from "@/components/radar/ld2450-view";
import { LiveRadarView, type SignalSample } from "@/components/radar/live-radar-view";
import { MovementHeatmap } from "@/components/analytics/movement-heatmap";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/live")({
  head: () => ({
    meta: [
      { title: "Live Radar — RoomTrace" },
      {
        name: "description",
        content: "Real-time camera-free occupancy and target tracking for a selected room.",
      },
      { property: "og:title", content: "Live Radar — RoomTrace" },
      {
        property: "og:description",
        content: "Real-time camera-free occupancy and target tracking for a selected room.",
      },
    ],
  }),
  component: LivePage,
});

const TRAIL_POINTS = 40;
const SERIES_POINTS = 90;

type Trails = Record<number, Array<{ x_mm: number; y_mm: number }>>;

function LivePage() {
  const { data: rooms = [], isLoading } = useQuery(roomsQuery);
  const { data: devices = [] } = useQuery(devicesQuery);
  const live = useLive();
  const room = rooms.find((r) => r.id === live.selectedRoomId) ?? rooms[0];
  const [frozen, setFrozen] = useState<RoomLive | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const current = room ? live.frames[room.id] : undefined;
  const view = frozen ?? current;
  const status = roomState(current, live.now);
  const stale = isStale(view?.ld?.timestamp, live.now);
  const targets = useMemo(() => (view?.ld?.targets ?? []) as LD2450Target[], [view?.ld?.targets]);

  // Recent positions and a short signal history, built from the real frames as they arrive.
  const [trails, setTrails] = useState<Trails>({});
  const [series, setSeries] = useState<SignalSample[]>([]);
  const lastSeenTs = useRef<number | undefined>(undefined);
  const roomIdRef = useRef(room?.id);
  const frameTs = current?.ld?.timestamp;
  const frameTargets = current?.ld?.targets;

  useEffect(() => {
    if (roomIdRef.current !== room?.id) {
      roomIdRef.current = room?.id;
      lastSeenTs.current = undefined;
      setTrails({});
      setSeries([]);
      setFrozen(null);
      setSelected(null);
    }
  }, [room?.id]);

  useEffect(() => {
    if (frozen || frameTs === undefined || frameTs === lastSeenTs.current) return;
    lastSeenTs.current = frameTs;
    const ts = (frameTargets ?? []) as LD2450Target[];
    setTrails((prev) => {
      const next: Trails = {};
      for (const t of ts) {
        next[t.target_id] = [...(prev[t.target_id] ?? []), { x_mm: t.x_mm, y_mm: t.y_mm }].slice(
          -TRAIL_POINTS,
        );
      }
      return next;
    });
    const nearest = ts.length
      ? Math.min(...ts.map((t) => Math.hypot(t.x_mm, t.y_mm))) / 1000
      : null;
    const fastest = ts.length ? Math.max(...ts.map((t) => Math.abs(t.speed_cms))) / 100 : 0;
    setSeries((prev) =>
      [
        ...prev,
        {
          label: new Date(frameTs).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          targets: ts.length,
          nearest: nearest === null ? null : Math.round(nearest * 100) / 100,
          speed: Math.round(fastest * 100) / 100,
        },
      ].slice(-SERIES_POINTS),
    );
  }, [frameTs, frameTargets, frozen]);

  // Bed exit: someone was in the bed zone and is still detected, but no longer in it.
  const bedZone = room?.zones?.find((z) => z.type === "bed");
  const isTargetInBed = (t: LD2450Target) => {
    if (!bedZone || bedZone.polygon.length < 3 || !room) return false;
    return isPointInPolygon(t.x_mm + room.width_mm / 2, t.y_mm, bedZone.polygon);
  };
  const isInBed = targets.length > 0 && targets.some(isTargetInBed);
  const prevInBed = useRef(false);
  const [bedExitBanner, setBedExitBanner] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (prevInBed.current && !isInBed && targets.length > 0) {
      setBedExitBanner(true);
      timer = setTimeout(() => setBedExitBanner(false), 9000);
    }
    prevInBed.current = isInBed;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isInBed, targets.length]);

  // Stored movement today, for the heatmap tab.
  const todayIso = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const trajectories = useQuery(
    trajectoriesQuery({ roomId: room?.id, fromIso: todayIso, limitCount: 500 }),
  );
  const heatmapData = useMemo(() => {
    if (!room) return null;
    const mount: SensorMountTransform = {
      mountX_mm: room.width_mm / 2,
      mountY_mm: 0,
      orientationDeg: 0,
    };
    return calculateMovementHeatmap(
      trajectories.data ?? [],
      room.width_mm,
      room.length_mm,
      20,
      mount,
    );
  }, [room, trajectories.data]);

  if (isLoading) return <Skeleton className="h-[520px] rounded-2xl" />;

  if (rooms.length === 0 || !room)
    return (
      <div className="py-8">
        <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <Empty
            icon={<Boxes className="size-6 text-slate-400" />}
            title="No rooms to monitor"
            action={
              <Button asChild className="rounded-xl bg-blue-600 hover:bg-blue-700">
                <Link to="/rooms">Create your first room</Link>
              </Button>
            }
          >
            Add a room first to start monitoring.
          </Empty>
        </div>
      </div>
    );

  const assigned = devices.find((d) => d.room_id === room.id);
  const hub = assigned
    ? {
        label: assigned.device_name || "Radar Hub",
        online: deviceConnection(assigned.last_seen, live.now) === "connected",
      }
    : null;

  const activeAlert = live.liveEvents.find(
    (e) =>
      e.room_id === room.id &&
      (e.event_type === "candidate_fall" || e.event_type === "hazard_zone_entry") &&
      live.now - e.timestamp < 120_000,
  );

  const banners = (
    <>
      {activeAlert && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-rose-600" />
          <div className="text-sm">
            <div className="font-bold">
              {activeAlert.event_type === "candidate_fall"
                ? "Possible fall"
                : "Hazard zone entered"}
            </div>
            <div>{activeAlert.description}</div>
          </div>
        </div>
      )}
      {bedExitBanner && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-2xl bg-slate-900 p-3.5 px-4 text-white"
        >
          <div className="flex items-center gap-3 text-sm">
            <Activity className="size-5 text-blue-400" />
            <span>
              <span className="font-semibold">Bed exit detected</span> in {room.name}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setBedExitBanner(false)}
            className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </>
  );

  return (
    <LiveRadarView
      room={room}
      status={status}
      hasBed={Boolean(bedZone)}
      targets={targets}
      trails={trails}
      points={view?.rd?.points}
      hub={hub}
      stale={stale && !frozen}
      lastUpdateLabel={view?.ld ? timeAgo(view.ld.timestamp, live.now) : "—"}
      series={series}
      topView={
        view?.ld ? (
          <LD2450View
            widthMm={room.width_mm}
            lengthMm={room.length_mm}
            doors={room.doors}
            zones={room.zones}
            objects={room.objects}
            frame={view.ld}
            selected={selected}
            onSelect={setSelected}
            stale={stale && !frozen}
          />
        ) : (
          <p className="py-20 text-center text-sm text-slate-500">
            No data has been received for this room yet.
          </p>
        )
      }
      heatmap={
        heatmapData && (trajectories.data?.length ?? 0) > 0 ? (
          <MovementHeatmap
            heatmapData={heatmapData}
            roomWidthMm={room.width_mm}
            roomLengthMm={room.length_mm}
            zones={room.zones ?? []}
            doors={room.doors ?? []}
          />
        ) : (
          <p className="px-6 py-20 text-center text-sm text-slate-500">
            No stored movement for this room today yet. The heatmap fills in as people are tracked.
          </p>
        )
      }
      frozen={Boolean(frozen)}
      onToggleFrozen={() => setFrozen(frozen ? null : (current ?? {}))}
      banners={banners}
      selectedId={selected}
      onSelect={setSelected}
    />
  );
}

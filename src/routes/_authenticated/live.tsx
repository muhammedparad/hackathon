import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bed,
  Boxes,
  ChevronLeft,
  Maximize2,
  Pause,
  Play,
  Plus,
  Radar,
  Settings,
  ShieldAlert,
  User,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { roomsQuery } from "@/lib/data";
import { isStale, roomState, useLive, type RoomLive } from "@/lib/radar/live";
import { EVENT_LABELS, isPointInPolygon, type LD2450Target } from "@/lib/radar/types";
import {
  Empty,
  Pill,
  RoomBadge,
  SimTag,
  timeAgo,
} from "@/components/app/status";
import { EventRow } from "@/components/app/event-row";
import { ModeToggle, SimControls } from "@/components/app/sim-controls";
import { LD2450View } from "@/components/radar/ld2450-view";
import { RD61View } from "@/components/radar/rd61-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/live")({
  head: () => ({
    meta: [
      { title: "Live Room Radar — RoomTrace" },
      {
        name: "description",
        content: "Real-time camera-free occupancy and target tracking for a selected room.",
      },
      { property: "og:title", content: "Live Room Radar — RoomTrace" },
      {
        property: "og:description",
        content: "Real-time camera-free occupancy and target tracking for a selected room.",
      },
    ],
  }),
  component: LivePage,
});

function LivePage() {
  const { data: rooms = [], isLoading } = useQuery(roomsQuery);
  const live = useLive();
  const room = rooms.find((r) => r.id === live.selectedRoomId) ?? rooms[0];
  const [frozen, setFrozen] = useState<RoomLive | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const current = room ? live.frames[room.id] : undefined;
  const view = frozen ?? current;
  const sim = live.mode === "simulation";
  const stale = isStale(view?.ld?.timestamp, live.now);
  const state = roomState(current, live.now, live.mode);
  const lastRoom = useRef(room?.id);

  // Bed presence detection
  const bedZone = room?.zones?.find((z) => z.type === "bed");
  const targets = (view?.ld?.targets ?? []) as LD2450Target[];
  const isTargetInBed = (t: LD2450Target) => {
    if (!bedZone || bedZone.polygon.length < 3) return false;
    const rx = t.x_mm + (room?.width_mm ?? 5000) / 2;
    const ry = t.y_mm;
    return isPointInPolygon(rx, ry, bedZone.polygon);
  };
  const isInBed = targets.length > 0 && targets.some(isTargetInBed);

  // Bed exit notification toast (matching frame_009 in video)
  const prevInBed = useRef(false);
  const [bedExitBanner, setBedExitBanner] = useState(false);
  const [rtdbPermissionDenied, setRtdbPermissionDenied] = useState(false);

  useEffect(() => {
    const handler = () => setRtdbPermissionDenied(true);
    window.addEventListener("roomtrace_rtdb_permission_denied", handler);
    return () => window.removeEventListener("roomtrace_rtdb_permission_denied", handler);
  }, []);

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

  useEffect(() => {
    if (lastRoom.current !== room?.id) {
      setFrozen(null);
      lastRoom.current = room?.id;
    }
  }, [room?.id]);

  if (!isLoading && rooms.length === 0)
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

  const roomEvents = live.liveEvents.filter((e) => e.room_id === room?.id);
  const activeAlert = roomEvents.find(
    (e) => (e.event_type === "candidate_fall" || e.event_type === "hazard_zone_entry") && live.now - e.timestamp < 120000,
  );

  return (
    <div className="relative pb-12">
      {/* Floating Push Notification Banner (matching frame_009 in video) */}
      {bedExitBanner && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-md animate-[rt-slide-down_0.35s_ease-out]">
          <div className="flex items-center justify-between rounded-2xl bg-slate-900/95 p-3.5 px-4 text-white shadow-2xl backdrop-blur-md border border-white/10">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-blue-600/90 text-white shadow-sm">
                <Activity className="size-5" />
              </div>
              <div className="leading-tight">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <span>Bed Exit Detected</span>
                  <span className="text-[11px] font-normal text-slate-400">now</span>
                </div>
                <div className="text-xs text-slate-300">
                  G&apos;s Home: Bed exit detected in {room?.name ?? "Bedroom"}.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setBedExitBanner(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
              aria-label="Dismiss alert"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Firebase RTDB Permission Notice */}
      {rtdbPermissionDenied && (
        <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-200 text-amber-800">
              <AlertTriangle className="size-5" />
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-bold text-amber-900">
                Firebase Realtime Database: Permission Denied
              </div>
              <p className="mt-1 text-amber-800 leading-relaxed text-xs">
                Your ESP32 is uploading telemetry to Firebase, but your Realtime Database security rules are currently blocking read access from the web dashboard.
              </p>
              <div className="mt-2 rounded-xl bg-amber-100/90 p-2.5 font-mono text-[11px] text-amber-900 border border-amber-200">
                <span className="font-sans font-semibold text-amber-800 block mb-1">
                  1-click fix in Firebase Console → Realtime Database → Rules tab:
                </span>
                {`{\n  "rules": {\n    ".read": true,\n    ".write": true\n  }\n}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRtdbPermissionDenied(false)}
              className="rounded-lg p-1 text-amber-600 hover:bg-amber-200/60"
              aria-label="Dismiss notice"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Screen Sub-Header (matching mobile app header in video) */}
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/overview"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ChevronLeft className="size-5" />
          <span>Room</span>
        </Link>
        <div className="flex items-center gap-2">
          {sim && <SimTag />}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-9 rounded-xl text-slate-600 hover:bg-slate-100"
          >
            <Link to="/rooms" aria-label="Room Settings">
              <Settings className="size-5" />
            </Link>
          </Button>
        </div>
      </div>

      {/* Room Name & Category Badge */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          {room?.name ?? "Room"}
        </h1>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
            <Bed className="size-3.5" />
            {room?.name ?? "Bedroom"}
          </span>
        </div>
      </div>

      {/* Prominent Status Banner Card (The centerpiece of video frame_005 & frame_008) */}
      <div className="mb-5 rounded-2xl border border-slate-200/90 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            {/* Status Icon */}
            <div
              className={cn(
                "flex size-11 items-center justify-center rounded-xl text-white shadow-sm",
                activeAlert
                  ? "bg-rose-500 animate-pulse"
                  : isInBed
                    ? "bg-blue-600"
                    : state === "occupied"
                      ? "bg-blue-600"
                      : "bg-slate-100 text-slate-400",
              )}
            >
              {activeAlert ? (
                <ShieldAlert className="size-5.5 text-white" />
              ) : isInBed ? (
                <Bed className="size-5.5 text-white" />
              ) : state === "occupied" ? (
                <User className="size-5.5 text-white" />
              ) : (
                <User className="size-5.5 text-slate-400" />
              )}
            </div>

            {/* Status Text & Elapsed Time */}
            <div>
              <div className="text-base font-bold text-slate-900">
                {activeAlert
                  ? "Fall Detected"
                  : isInBed
                    ? "In Bed"
                    : state === "occupied"
                      ? "Occupied"
                      : "Vacant"}
              </div>
              <div className="text-xs font-medium text-slate-400">
                {activeAlert ? (
                  <span className="text-rose-600 font-semibold">Immediate attention needed</span>
                ) : isInBed ? (
                  <span>
                    {timeAgo(view?.ld?.timestamp, live.now)} | One presence
                  </span>
                ) : state === "occupied" ? (
                  <span>
                    {timeAgo(view?.ld?.timestamp, live.now)} |{" "}
                    {targets.length > 1 ? `${targets.length} presences` : "One presence"}
                  </span>
                ) : (
                  <span>Vacant | No presence</span>
                )}
              </div>
            </div>
          </div>

          {/* Wi-Fi / Radar Signal Strength Indicator (Green) */}
          <div className="flex items-center gap-2">
            {!sim && live.streamStatus !== "live" ? (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium">
                <WifiOff className="size-4" />
                Connecting…
              </span>
            ) : (
              <div
                className="flex items-center gap-1.5 text-emerald-600"
                title="Radar sensor online & streaming"
              >
                <Wifi className="size-5 text-emerald-500" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action Bar (+ Add Zone, Expand, Freeze, Controls) */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            asChild
            className="rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 font-medium text-white shadow-sm hover:from-blue-700 hover:to-indigo-700"
          >
            <Link to="/rooms">
              <Plus className="size-4 mr-1.5" />
              Add Zone
            </Link>
          </Button>

          <Button
            variant="outline"
            size="icon"
            asChild
            className="size-9 rounded-xl border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <Link to="/rooms" aria-label="Floor plan editor">
              <Maximize2 className="size-4" />
            </Link>
          </Button>

          {/* Quick trigger to preview Bed Exit Notification banner */}
          <button
            type="button"
            onClick={() => {
              setBedExitBanner(true);
              setTimeout(() => setBedExitBanner(false), 8000);
            }}
            className="text-xs text-blue-600 hover:underline px-2"
          >
            Preview Bed Exit
          </button>
        </div>

        <div className="flex items-center gap-2">
          <SimControls roomId={room?.id ?? null} />
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-xl border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => setFrozen(frozen ? null : (current ?? {}))}
          >
            {frozen ? (
              <>
                <Play className="size-3.5 mr-1 text-emerald-600" /> Resume View
              </>
            ) : (
              <>
                <Pause className="size-3.5 mr-1 text-slate-500" /> Freeze View
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Main Grid: Architectural Radar Canvas + Details Sidebar */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Floor Plan / Radar Canvas (Architectural vector room from video) */}
        <div className="rounded-2xl border-2 border-slate-200/90 bg-white p-3 sm:p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Architectural Radar Canvas
            </div>
            {frozen && <Pill t="warning">Frozen</Pill>}
          </div>

          {room && view?.ld ? (
            <div className="overflow-hidden rounded-xl border border-slate-100">
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
                door={sim}
              />
            </div>
          ) : (
            <div className="py-20 text-center">
              <Empty
                icon={<Radar className="size-8 text-slate-400 mx-auto" />}
                title={
                  sim
                    ? live.simStatus === "stopped"
                      ? "Simulation stopped"
                      : "Sensor offline (simulated)"
                    : "No telemetry received"
                }
              >
                {sim
                  ? "Start the simulation or pick another scenario."
                  : "No hardware data has been received for this room. Assign a registered ESP32-S3 to this room and send telemetry."}
              </Empty>
            </div>
          )}
        </div>

        {/* Live Details & Target Telemetry Panel */}
        <div className="space-y-5">
          {/* Room Details Card */}
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
              Realtime State
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-slate-500">Status</div>
                <div className="mt-1 font-semibold text-slate-900 capitalize">
                  {isInBed ? "In Bed" : state}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Active Targets</div>
                <div className="mt-1 font-mono text-xl font-bold text-blue-600">
                  {view?.ld && !stale ? view.ld.targets.length : "0"}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Data Source</div>
                <div className="mt-1">
                  {sim ? <SimTag /> : <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">Hardware ESP32</span>}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Signal Health</div>
                <div className="mt-1 text-xs font-medium text-emerald-600 flex items-center gap-1">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  {stale ? "Stale" : "Active"}
                </div>
              </div>
            </div>
          </div>

          {/* Targets Table Card */}
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
              Target Coordinates
            </h3>
            {view?.ld && view.ld.targets.length > 0 ? (
              <div className="space-y-2">
                {view.ld.targets.map((t) => (
                  <div
                    key={t.target_id}
                    onClick={() => setSelected(t.target_id)}
                    className={cn(
                      "flex items-center justify-between rounded-xl p-2.5 transition border cursor-pointer",
                      selected === t.target_id
                        ? "border-blue-500 bg-blue-50/70"
                        : "border-slate-100 hover:bg-slate-50",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">
                        #{t.target_id}
                      </div>
                      <div className="text-xs">
                        <div className="font-semibold text-slate-800">
                          {isTargetInBed(t) ? "In Bed" : "In Room"}
                        </div>
                        <div className="text-slate-400 font-mono">
                          X: {t.x_mm}mm · Y: {t.y_mm}mm
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-xs">
                      <div
                        className={cn(
                          "font-mono font-medium",
                          t.speed_cms > 10
                            ? "text-amber-600"
                            : t.speed_cms < -10
                              ? "text-emerald-600"
                              : "text-slate-400",
                        )}
                      >
                        {t.speed_cms} cm/s
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-slate-400">
                No active targets detected.
              </p>
            )}
          </div>

          {/* Activity Log Card */}
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
              Recent Logbook
            </h3>
            {roomEvents.length ? (
              <ol className="space-y-2">
                {roomEvents.slice(0, 5).map((e) => (
                  <EventRow
                    key={e.id}
                    dense
                    now={live.now}
                    event={{ ...e, label: EVENT_LABELS[e.event_type] }}
                  />
                ))}
              </ol>
            ) : (
              <p className="py-4 text-center text-xs text-slate-400">No events logged yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

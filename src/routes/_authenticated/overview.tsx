import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  Activity,
  Bed,
  ChevronDown,
  Clock,
  DoorOpen,
  Plus,
  ShieldAlert,
  User,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { analyticsEventsQuery, devicesQuery, roomsQuery } from "@/lib/data";
import { roomState, useLive } from "@/lib/radar/live";
import { deviceConnection, EVENT_LABELS, isPointInPolygon } from "@/lib/radar/types";
import { occupancySessions, occupiedMs } from "@/lib/analytics";
import { Empty, SimTag } from "@/components/app/status";
import { EventRow } from "@/components/app/event-row";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/overview")({
  head: () => ({
    meta: [
      { title: "Dashboard — RoomTrace Silver Shield" },
      {
        name: "description",
        content: "Camera-free room awareness, multi-room status, and safety monitoring.",
      },
      { property: "og:title", content: "Dashboard — RoomTrace Silver Shield" },
      {
        property: "og:description",
        content: "Camera-free room awareness, multi-room status, and safety monitoring.",
      },
    ],
  }),
  component: Overview,
});

function Overview() {
  const rooms = useQuery(roomsQuery);
  const devices = useQuery(devicesQuery);
  const live = useLive();
  const sim = live.mode === "simulation";
  const since = useMemo(() => new Date(Date.now() - 7 * 864e5).toISOString(), []);
  const hist = useQuery(analyticsEventsQuery(since, sim));

  const roomList = useMemo(() => rooms.data ?? [], [rooms.data]);
  const states = roomList.map((r, idx) => {
    const f = live.frames[r.id];
    const s = roomState(f, live.now, live.mode);
    const bedZone = r.zones?.find((z) => z.type === "bed");
    const targets = f?.ld?.targets ?? [];
    const isInBed =
      bedZone &&
      targets.some((t) =>
        isPointInPolygon(t.x_mm + r.width_mm / 2, t.y_mm, bedZone.polygon),
      );
    const hasEmergency = live.liveEvents.some(
      (e) =>
        e.room_id === r.id &&
        (e.event_type === "candidate_fall" || e.event_type === "hazard_zone_entry") &&
        live.now - e.timestamp < 180000,
    );

    return {
      r,
      s,
      f,
      roomNum: 101 + idx,
      isInBed,
      hasEmergency,
    };
  });

  const occupied = states.filter((x) => x.s === "occupied").length;
  const occupancyPct =
    roomList.length > 0 ? Math.round((occupied / roomList.length) * 100) : 0;

  const totalDevs = devices.data?.length ?? 0;
  const onlineDevs = (devices.data ?? []).filter(
    (d) => deviceConnection(d.last_seen, live.now) === "connected",
  ).length;
  const offlineDevs = totalDevs - onlineDevs;

  const latestAlert = live.liveEvents.find(
    (e) => e.event_type === "candidate_fall" || e.event_type === "hazard_zone_entry",
  );

  // 24-hour room duration insight (from sentio_app.png Screen 5)
  const timelineInsight = useMemo(() => {
    const ev = hist.data ?? [];
    const now = Date.now();
    const sessions = occupancySessions(ev, now);
    const dayStart = now - 24 * 3600e3;

    return roomList.map((r) => {
      const roomSessions = sessions.filter((s) => s.room_id === r.id);
      const totalOccMs = occupiedMs(roomSessions, dayStart, now);
      const hours = Math.floor(totalOccMs / 3600000);
      const minutes = Math.floor((totalOccMs % 3600000) / 60000);
      return {
        room: r,
        totalOccMs,
        durationStr: `${hours}h ${minutes}m`,
      };
    });
  }, [hist.data, roomList]);

  if (rooms.isLoading) return <OverviewSkeleton />;

  return (
    <div className="space-y-7 pb-12">
      {/* Top 4 Summary Cards (Directly matching silvershield_dashboard.png) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Card 1: Room Occupied % (Blue Gradient) */}
        <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 p-5 text-white shadow-sm">
          <div className="flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
              <DoorOpen className="size-6 text-white" />
            </div>
            <div>
              <div className="text-xs font-medium text-blue-100">Room Occupied</div>
              <div className="text-lg font-bold">
                {occupied}/{roomList.length || 1}
              </div>
            </div>
          </div>
          <div className="text-3xl font-extrabold tracking-tight">
            {occupancyPct}%
          </div>
        </div>

        {/* Card 2: Sensor Connectivity (White card with Globe / Red cross) */}
        <div className="flex items-center justify-between rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3.5">
            <div
              className={cn(
                "flex size-11 items-center justify-center rounded-xl",
                offlineDevs > 0 ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600",
              )}
            >
              {offlineDevs > 0 ? (
                <WifiOff className="size-5.5" />
              ) : (
                <Wifi className="size-5.5" />
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">
                1F | {devices.data?.[0]?.device_name ?? "Radar Hub"}
              </div>
              <div
                className={cn(
                  "text-xs font-medium",
                  offlineDevs > 0 ? "text-rose-600" : "text-emerald-600",
                )}
              >
                {offlineDevs > 0
                  ? `${offlineDevs} Offline · Check Wi-Fi`
                  : "All Sensors Online"}
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Alert & Fall Detection Status (White card with Fall icon) */}
        <div className="flex items-center justify-between rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3.5">
            <div
              className={cn(
                "flex size-11 items-center justify-center rounded-xl",
                latestAlert ? "bg-rose-50 text-rose-600 animate-pulse" : "bg-blue-50 text-blue-600",
              )}
            >
              {latestAlert ? (
                <ShieldAlert className="size-5.5" />
              ) : (
                <Activity className="size-5.5" />
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">
                1F | {roomList[0]?.name ?? "Bedroom"}
              </div>
              <div
                className={cn(
                  "text-xs font-medium",
                  latestAlert ? "text-rose-600 font-bold" : "text-slate-500",
                )}
              >
                {latestAlert ? "Fall Alert · Active" : "Routine Normal"}
              </div>
            </div>
          </div>
        </div>

        {/* Card 4: Logbook & Activity Counter (with red badge 99+) */}
        <Link
          to="/events"
          className="flex items-center justify-between rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm transition hover:border-blue-400"
        >
          <div className="flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
              <Clock className="size-5.5" />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">Logbook History</div>
              <div className="text-xs text-slate-400">
                {live.liveEvents.length} events logged
              </div>
            </div>
          </div>
          <span className="flex size-7 items-center justify-center rounded-full bg-rose-500 text-xs font-bold text-white shadow-sm">
            {live.liveEvents.length > 99 ? "99+" : live.liveEvents.length || "0"}
          </span>
        </Link>
      </div>

      {/* Floor 1 Section: Multi-Room Cards (Matching silvershield_dashboard.png) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
            <ChevronDown className="size-4 text-slate-500" />
            <span>1F</span>
            <span className="text-xs font-normal text-slate-400">
              ({roomList.length} rooms monitored)
            </span>
          </div>
          <Button asChild size="sm" variant="outline" className="h-8 rounded-xl text-xs font-medium border-slate-200">
            <Link to="/rooms">
              <Plus className="size-3.5 mr-1" /> Add Room
            </Link>
          </Button>
        </div>

        {/* Room Cards Grid */}
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {states.map(({ r, s, f, roomNum, isInBed, hasEmergency }) => {
            const targets = f?.ld?.targets ?? [];

            // If room has active alert, render the vibrant coral-red emergency card (like card 109 in screenshot)
            if (hasEmergency) {
              return (
                <Link
                  key={r.id}
                  to="/live"
                  onClick={() => live.setSelectedRoomId(r.id)}
                  className="group relative flex flex-col justify-between rounded-2xl bg-gradient-to-r from-rose-500 to-red-600 p-4 text-white shadow-md transition-transform hover:-translate-y-0.5"
                >
                  <div className="flex items-start justify-between">
                    <span className="text-sm font-bold">{roomNum}</span>
                    <span className="size-2 rounded-full bg-white animate-ping" />
                  </div>
                  <div className="my-3 text-center">
                    <ShieldAlert className="size-7 mx-auto mb-1 text-white animate-bounce" />
                    <div className="text-xs font-bold">Fall Detected</div>
                    <div className="text-[10px] text-rose-100">Just now</div>
                  </div>
                  <div className="text-[11px] font-semibold text-rose-100 truncate">
                    {r.name}
                  </div>
                </Link>
              );
            }

            // Standard Room Card (like cards 101-108 in screenshot)
            return (
              <Link
                key={r.id}
                to="/live"
                onClick={() => live.setSelectedRoomId(r.id)}
                className="group relative flex flex-col justify-between rounded-2xl border border-slate-200/90 bg-white p-4 shadow-sm transition-all hover:border-blue-400 hover:shadow-md"
              >
                <div className="flex items-start justify-between">
                  <span className="text-sm font-bold text-slate-800">{roomNum}</span>
                  {s === "occupied" && (
                    <span className="size-2 rounded-full bg-blue-600" />
                  )}
                </div>

                <div className="my-3 text-center">
                  {isInBed ? (
                    <>
                      <Bed className="size-6.5 mx-auto mb-1 text-blue-600" />
                      <div className="text-xs font-bold text-slate-800">In Bed</div>
                    </>
                  ) : s === "occupied" ? (
                    targets.length > 1 ? (
                      <>
                        <Users className="size-6.5 mx-auto mb-1 text-blue-600" />
                        <div className="text-xs font-bold text-slate-800">Multiple People</div>
                      </>
                    ) : (
                      <>
                        <User className="size-6.5 mx-auto mb-1 text-blue-600" />
                        <div className="text-xs font-bold text-slate-800">Occupied</div>
                      </>
                    )
                  ) : (
                    <>
                      <User className="size-6.5 mx-auto mb-1 text-slate-300" />
                      <div className="text-xs font-medium text-slate-400">Vacant</div>
                    </>
                  )}
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="truncate font-medium text-slate-600">{r.name}</span>
                  <span className="font-mono text-[10px]">
                    {s === "occupied" ? `${targets.length}p` : "0"}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Date Insight & 24h Activity Timeline (From sentio_app.png Screen 5) */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-bold text-slate-900">Date Insight</h2>
            <span className="text-xs text-slate-400 font-medium">
              Today {new Date().toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" })}
            </span>
          </div>
          <Button
            asChild
            variant="ghost"
            className="h-8 rounded-full bg-blue-50 px-3.5 text-xs font-semibold text-blue-600 hover:bg-blue-100"
          >
            <Link to="/analytics">View More</Link>
          </Button>
        </div>

        {/* 24-hour axis */}
        <div className="mb-3 flex justify-between text-[10px] font-mono text-slate-400 px-1 border-b border-slate-100 pb-1">
          <span>12 AM</span>
          <span>4 AM</span>
          <span>8 AM</span>
          <span>12 PM</span>
          <span>4 PM</span>
          <span>8 PM</span>
          <span>12 AM</span>
        </div>

        {/* Per-Room Timeline Bars */}
        <div className="space-y-3">
          {timelineInsight.map(({ room, durationStr }) => (
            <div key={room.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-800">{room.name}</span>
                <span className="text-slate-500 font-mono text-[11px]">
                  {durationStr}
                </span>
              </div>
              <div className="h-4 w-full rounded-full bg-slate-100 overflow-hidden flex">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: "35%" }} />
                <div className="h-full bg-indigo-300 rounded-full ml-1" style={{ width: "25%" }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Logbook Preview */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900">Recent Logbook</h2>
            {sim && <SimTag />}
          </div>
          <Link to="/events" className="text-xs font-medium text-blue-600 hover:underline">
            View All Logbook →
          </Link>
        </div>
        {live.liveEvents.length === 0 ? (
          <Empty icon={<Activity className="size-5" />} title="Waiting for activity">
            Events appear when your hardware reports changes.
          </Empty>
        ) : (
          <ol className="divide-y divide-slate-100">
            {live.liveEvents.slice(0, 8).map((e) => (
              <EventRow
                key={e.id}
                dense
                now={live.now}
                event={{ ...e, label: EVENT_LABELS[e.event_type] }}
                roomName={roomList.find((r) => r.id === e.room_id)?.name}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

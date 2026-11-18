import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { analyticsEventsQuery, devicesQuery, roomsQuery } from "@/lib/data";
import { roomState, useLive } from "@/lib/radar/live";
import { deviceConnection } from "@/lib/radar/types";
import { isAlertEvent, occupancySessions, occupiedMs } from "@/lib/analytics";
import {
  DashboardView,
  type DashboardRoom,
  type TimelineRow,
} from "@/components/dashboard/dashboard-view";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/overview")({
  head: () => ({
    meta: [
      { title: "Dashboard — RoomTrace" },
      {
        name: "description",
        content: "Camera-free room awareness, multi-room status, and safety monitoring.",
      },
      { property: "og:title", content: "Dashboard — RoomTrace" },
      {
        property: "og:description",
        content: "Camera-free room awareness, multi-room status, and safety monitoring.",
      },
    ],
  }),
  component: Overview,
});

const MOVEMENT_TYPES = new Set(["target_moved", "target_detected"]);

function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function Overview() {
  const navigate = useNavigate();
  const rooms = useQuery(roomsQuery);
  const devices = useQuery(devicesQuery);
  const live = useLive();
  const since = useMemo(() => new Date(Date.now() - 7 * 864e5).toISOString(), []);
  const hist = useQuery(analyticsEventsQuery(since));

  const roomList = useMemo(() => rooms.data ?? [], [rooms.data]);

  const roomCards = useMemo<DashboardRoom[]>(
    () =>
      roomList.map((r) => {
        const f = live.frames[r.id];
        const status = roomState(f, live.now);
        const emergency = live.liveEvents.some(
          (e) =>
            e.room_id === r.id &&
            (e.event_type === "candidate_fall" || e.event_type === "hazard_zone_entry") &&
            live.now - e.timestamp < 180_000,
        );
        return {
          id: r.id,
          name: r.name,
          sizeLabel: `${(r.width_mm / 1000).toFixed(1)} × ${(r.length_mm / 1000).toFixed(1)} m`,
          hasBed: Boolean(r.zones?.some((z) => z.type === "bed")),
          status,
          people: status === "occupied" ? (f?.ld?.targets.length ?? 0) : 0,
          emergency,
        };
      }),
    [roomList, live.frames, live.liveEvents, live.now],
  );
  const occupiedCount = roomCards.filter((r) => r.status === "occupied").length;

  const deviceSummary = useMemo(() => {
    const list = devices.data ?? [];
    const withState = list.map((d) => ({
      d,
      online: deviceConnection(d.last_seen, live.now) === "connected",
      seen: d.last_seen ? new Date(d.last_seen).getTime() : 0,
    }));
    const primary = [...withState].sort((a, b) => b.seen - a.seen)[0];
    return {
      total: list.length,
      online: withState.filter((x) => x.online).length,
      primary: primary
        ? {
            name: primary.d.device_name,
            deviceId: primary.d.device_id,
            online: primary.online,
            lastSeenLabel: primary.seen ? ageLabel(live.now - primary.seen) : "never",
          }
        : null,
    };
  }, [devices.data, live.now]);

  const day = useMemo(() => {
    const start = new Date(live.now);
    start.setHours(0, 0, 0, 0);
    const events = hist.data ?? [];
    const dayStart = start.getTime();
    const today = events.filter((e) => new Date(e.timestamp).getTime() >= dayStart);
    const sessions = occupancySessions(events, live.now);

    const rows: TimelineRow[] = roomList.map((r) => {
      const mine = sessions.filter((s) => s.room_id === r.id && s.end > dayStart);
      const bins = new Array<number>(24).fill(0);
      for (const e of today) {
        if (e.room_id !== r.id || !MOVEMENT_TYPES.has(e.event_type)) continue;
        const h = new Date(e.timestamp).getHours();
        bins[h] = (bins[h] ?? 0) + 1;
      }
      return {
        roomId: r.id,
        roomName: r.name,
        hasBed: Boolean(r.zones?.some((z) => z.type === "bed")),
        occupied: mine.map((s) => ({
          start: Math.max(s.start, dayStart),
          end: Math.min(s.end, live.now),
          open: s.status === "open",
        })),
        movementBins: bins,
        totalMs: occupiedMs(mine, dayStart, live.now),
      };
    });

    const unacked = events.filter((e) => isAlertEvent(e) && !e.acknowledged);
    unacked.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return { dayStart, rows, eventsToday: today.length, unacked };
  }, [hist.data, roomList, live.now]);

  if (rooms.isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const roomName = (id: string) => roomList.find((r) => r.id === id)?.name;

  return (
    <DashboardView
      rooms={roomCards}
      occupiedCount={occupiedCount}
      devices={deviceSummary}
      alerts={{ active: day.unacked.length, latest: day.unacked[0]?.description ?? null }}
      eventsToday={day.eventsToday}
      timeline={{ dayStart: day.dayStart, now: live.now, rows: day.rows }}
      recentEvents={live.liveEvents}
      now={live.now}
      roomName={roomName}
      onOpenRoom={(id) => {
        live.setSelectedRoomId(id);
        void navigate({ to: "/live" });
      }}
    />
  );
}

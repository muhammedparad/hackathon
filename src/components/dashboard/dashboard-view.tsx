import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  Activity,
  Bed,
  ChevronRight,
  Clock,
  DoorOpen,
  FileText,
  LayoutGrid,
  Plus,
  Radio,
  ShieldAlert,
  User,
  WifiOff,
} from "lucide-react";
import { EventRow } from "@/components/app/event-row";
import { EVENT_LABELS } from "@/lib/radar/types";
import type { LiveEvent } from "@/lib/radar/live";
import { cn } from "@/lib/utils";

export type RoomStatus = "occupied" | "vacant" | "sensor_offline" | "unknown";

export interface DashboardRoom {
  id: string;
  name: string;
  /** e.g. "4.2 × 4.6 m" from the room's real dimensions. */
  sizeLabel: string;
  hasBed: boolean;
  status: RoomStatus;
  people: number;
  emergency: boolean;
}

export interface TimelineRow {
  roomId: string;
  roomName: string;
  hasBed: boolean;
  /** Occupied intervals today, epoch ms, already clipped to the day. */
  occupied: Array<{ start: number; end: number; open: boolean }>;
  /** Movement events per hour of today (24 numbers). */
  movementBins: number[];
  totalMs: number;
}

export interface DashboardProps {
  rooms: DashboardRoom[];
  occupiedCount: number;
  devices: {
    total: number;
    online: number;
    primary: { name: string; deviceId: string; online: boolean; lastSeenLabel: string } | null;
  };
  alerts: { active: number; latest: string | null };
  eventsToday: number;
  timeline: { dayStart: number; now: number; rows: TimelineRow[] };
  recentEvents: LiveEvent[];
  now: number;
  roomName: (id: string) => string | undefined;
  onOpenRoom: (roomId: string) => void;
}

const DAY_MS = 24 * 3600_000;
const CARD = "rounded-2xl border border-slate-100 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.06)]";

export function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return `${h}h ${m}m`;
}

function Ring({ pct }: { pct: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-16 shrink-0" role="img" aria-label={`${pct}% of rooms occupied`}>
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="white"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-extrabold text-white">
        {pct}%
      </div>
    </div>
  );
}

function SummaryCards({ p }: { p: DashboardProps }) {
  const pct = p.rooms.length > 0 ? Math.round((p.occupiedCount / p.rooms.length) * 100) : 0;
  const dev = p.devices.primary;
  const allOnline = p.devices.total > 0 && p.devices.online === p.devices.total;
  return (
    <section aria-label="Summary" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* Occupancy */}
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-gradient-to-br from-blue-600 via-blue-600 to-indigo-700 p-5 text-white shadow-[0_14px_34px_-12px_rgba(37,99,235,0.7)]">
        <div className="flex items-center gap-3.5">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-white/20">
            <Bed className="size-6" />
          </div>
          <div>
            <div className="text-sm font-medium text-blue-100">Room Occupied</div>
            <div className="text-2xl font-bold tabular-nums">
              {p.occupiedCount} / {p.rooms.length}
            </div>
          </div>
        </div>
        <Ring pct={pct} />
      </div>

      {/* Device */}
      <Link to="/devices" className={cn(CARD, "flex items-center gap-3.5 p-5 hover:shadow-lg")}>
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-2xl",
            dev
              ? dev.online
                ? "bg-emerald-50 text-emerald-600"
                : "bg-rose-50 text-rose-600"
              : "bg-slate-100 text-slate-500",
          )}
        >
          {dev && !dev.online ? <WifiOff className="size-6" /> : <Radio className="size-6" />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">
            {dev ? dev.name : "No device registered"}
          </div>
          {dev ? (
            <>
              <div className="truncate text-xs text-slate-500">{dev.deviceId}</div>
              <div
                className={cn(
                  "truncate text-xs font-semibold",
                  dev.online ? "text-emerald-600" : "text-rose-600",
                )}
              >
                {dev.online
                  ? allOnline && p.devices.total > 1
                    ? `All ${p.devices.total} online`
                    : `Online · ${dev.lastSeenLabel}`
                  : "Offline · Check Wi-Fi"}
              </div>
            </>
          ) : (
            <div className="text-xs font-semibold text-blue-600">Register a device →</div>
          )}
        </div>
      </Link>

      {/* Alerts */}
      <Link to="/events" className={cn(CARD, "flex items-center gap-3.5 p-5 hover:shadow-lg")}>
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-2xl",
            p.alerts.active > 0
              ? "animate-pulse bg-rose-50 text-rose-600"
              : "bg-blue-50 text-blue-600",
          )}
        >
          {p.alerts.active > 0 ? (
            <ShieldAlert className="size-6" />
          ) : (
            <Activity className="size-6" />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">Alerts</div>
          <div
            className={cn(
              "truncate text-xs font-semibold",
              p.alerts.active > 0 ? "text-rose-600" : "text-slate-500",
            )}
          >
            {p.alerts.active > 0 ? `${p.alerts.active} unacknowledged` : "No active alerts"}
          </div>
          {p.alerts.latest && (
            <div className="truncate text-xs text-slate-500">{p.alerts.latest}</div>
          )}
        </div>
      </Link>

      {/* Logbook */}
      <Link
        to="/events"
        className={cn(CARD, "flex items-center justify-between gap-3 p-5 hover:shadow-lg")}
      >
        <div className="flex items-center gap-3.5">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-600">
            <FileText className="size-6" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Logbook</div>
            <div className="text-xs text-slate-500">{p.eventsToday} events today</div>
          </div>
        </div>
        <ChevronRight className="size-5 text-slate-400" />
      </Link>
    </section>
  );
}

const STATUS_STYLE: Record<RoomStatus, { label: string; text: string; dot: string }> = {
  occupied: { label: "Occupied", text: "text-emerald-600", dot: "bg-emerald-500" },
  vacant: { label: "Vacant", text: "text-slate-500", dot: "bg-slate-300" },
  sensor_offline: { label: "Sensor offline", text: "text-amber-600", dot: "bg-amber-400" },
  unknown: { label: "No data yet", text: "text-slate-400", dot: "bg-slate-300" },
};

function RoomCards({ p }: { p: DashboardProps }) {
  return (
    <section aria-labelledby="rooms-h">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="rooms-h" className="flex items-center gap-2 text-lg font-bold text-slate-900">
          <LayoutGrid className="size-5 text-slate-500" />
          Rooms <span className="font-medium text-slate-400">({p.rooms.length})</span>
        </h2>
        <Link
          to="/rooms"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
        >
          <Plus className="size-4" /> Add Room
        </Link>
      </div>

      {p.rooms.length === 0 ? (
        <div className={cn(CARD, "p-8 text-center")}>
          <DoorOpen className="mx-auto size-8 text-slate-300" />
          <p className="mt-2 text-sm font-semibold text-slate-700">No rooms yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Add a room, then assign a registered device to it to see live data.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {p.rooms.map((r) => {
            const st = STATUS_STYLE[r.status];
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => p.onOpenRoom(r.id)}
                  className={cn(
                    CARD,
                    "w-full p-5 text-left transition hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500",
                    r.emergency && "border-rose-300 ring-2 ring-rose-200",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-bold text-slate-900">{r.name}</div>
                      <div className="text-xs text-slate-500">{r.sizeLabel}</div>
                    </div>
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      {r.hasBed ? <Bed className="size-5" /> : <DoorOpen className="size-5" />}
                    </div>
                  </div>
                  <div className="mt-5 flex items-center gap-2 text-sm font-medium">
                    <User className="size-5 text-slate-400" />
                    <span className={cn("flex items-center gap-1.5", st.text)}>
                      <span className={cn("size-2 rounded-full", st.dot)} />
                      {r.emergency ? "Alert" : st.label}
                      {r.status === "occupied" && r.people > 0
                        ? ` · ${r.people} ${r.people === 1 ? "person" : "people"}`
                        : ""}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const AXIS = ["12 AM", "4 AM", "8 AM", "12 PM", "4 PM", "8 PM", "12 AM"];

function DateInsight({ p }: { p: DashboardProps }) {
  const [mode, setMode] = useState<"occupancy" | "movement">("occupancy");
  const { dayStart, now, rows } = p.timeline;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - dayStart) / DAY_MS) * 100));
  const maxBin = Math.max(1, ...rows.flatMap((r) => r.movementBins));
  const dateLabel = new Date(now).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <section aria-labelledby="insight-h" className={cn(CARD, "p-5 sm:p-6")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="insight-h"
          className="flex flex-wrap items-baseline gap-x-3 text-lg font-bold text-slate-900"
        >
          <span className="flex items-center gap-2">
            <Activity className="size-5 text-slate-500" /> Date Insight
          </span>
          <span className="text-sm font-normal text-slate-500">Today, {dateLabel}</span>
        </h2>
        <div className="flex items-center gap-2">
          <div
            className="inline-flex rounded-xl bg-slate-100 p-1"
            role="group"
            aria-label="Insight type"
          >
            {(["occupancy", "movement"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "min-h-8 rounded-lg px-4 text-sm font-semibold capitalize transition",
                  mode === m
                    ? "bg-blue-600 text-white shadow"
                    : "text-slate-600 hover:text-slate-900",
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <Link
            to="/analytics"
            className="hidden min-h-9 items-center gap-1 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-blue-600 hover:bg-blue-50 sm:inline-flex"
          >
            View More <ChevronRight className="size-4" />
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">
          Add a room to see its activity here.
        </p>
      ) : (
        <div className="mt-5">
          {/* time axis (desktop) */}
          <div className="hidden grid-cols-[10rem_1fr_4.5rem] items-end gap-4 pb-2 text-xs text-slate-400 sm:grid">
            <span />
            <div className="flex justify-between">
              {AXIS.map((a, i) => (
                <span key={i}>{a}</span>
              ))}
            </div>
            <span />
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li
                key={row.roomId}
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 py-3.5 sm:grid-cols-[10rem_1fr_4.5rem]"
              >
                <div className="flex min-w-0 items-center gap-2.5 text-sm font-semibold text-slate-800">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                    {row.hasBed ? <Bed className="size-4" /> : <DoorOpen className="size-4" />}
                  </span>
                  <span className="truncate">{p.roomName(row.roomId) ?? row.roomName}</span>
                </div>
                <div className="text-right font-mono text-sm tabular-nums text-slate-600 sm:order-3">
                  {formatDuration(row.totalMs)}
                </div>
                <div
                  className="relative col-span-2 h-3 overflow-hidden rounded-full bg-slate-100 sm:col-span-1"
                  role="img"
                  aria-label={`${row.roomName}: ${formatDuration(row.totalMs)} occupied today`}
                >
                  {mode === "occupancy"
                    ? row.occupied.map((s, i) => (
                        <span
                          key={i}
                          className={cn(
                            "absolute inset-y-0 rounded-full",
                            s.open ? "bg-indigo-300" : "bg-blue-600",
                          )}
                          style={{
                            left: `${pct(s.start)}%`,
                            width: `${Math.max(0.6, pct(s.end) - pct(s.start))}%`,
                          }}
                        />
                      ))
                    : row.movementBins.map((n, h) =>
                        n > 0 ? (
                          <span
                            key={h}
                            className="absolute inset-y-0 rounded-sm bg-blue-600"
                            style={{
                              left: `${(h / 24) * 100}%`,
                              width: `${100 / 24 - 0.4}%`,
                              opacity: 0.25 + 0.75 * (n / maxBin),
                            }}
                            title={`${n} movement events`}
                          />
                        ) : null,
                      )}
                  {/* now marker */}
                  <span
                    className="absolute inset-y-0 w-px bg-slate-400/70"
                    style={{ left: `${pct(now)}%` }}
                    aria-hidden
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RecentActivity({ p }: { p: DashboardProps }) {
  return (
    <section aria-labelledby="recent-h" className={cn(CARD, "p-5 sm:p-6")}>
      <div className="flex items-center justify-between">
        <h2 id="recent-h" className="flex items-center gap-2 text-lg font-bold text-slate-900">
          <Clock className="size-5 text-slate-500" /> Recent Activity
        </h2>
        <Link
          to="/events"
          className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600"
        >
          View Logbook <ChevronRight className="size-4" />
        </Link>
      </div>
      {p.recentEvents.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-slate-100 py-10 text-center">
          <FileText className="mx-auto size-6 text-slate-300" />
          <p className="mt-2 text-sm font-semibold text-slate-700">No recent events</p>
          <p className="text-xs text-slate-500">
            Room activities and system events will appear here.
          </p>
        </div>
      ) : (
        <ul className="mt-2">
          {p.recentEvents.slice(0, 6).map((e) => (
            <EventRow
              key={e.id}
              now={p.now}
              event={{ ...e, label: EVENT_LABELS[e.event_type] }}
              roomName={p.roomName(e.room_id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DashboardView(p: DashboardProps) {
  return (
    <div className="space-y-6 lg:space-y-7">
      <SummaryCards p={p} />
      <RoomCards p={p} />
      <DateInsight p={p} />
      <RecentActivity p={p} />
    </div>
  );
}

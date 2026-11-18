import type { OccupancyEvent } from "@/lib/firebase/db";
import { HEARTBEAT_TIMEOUT_MS } from "@/lib/radar/types";
import {
  formatCalendarDayLabel,
  getCalendarDayIntervals,
  getCalendarDayStart,
  type TimezoneOption,
} from "./time";
import type {
  ActivitySummary,
  DailyActivitySummary,
  DetailedSession,
  OfflineInterval,
  Session,
} from "./types";

/**
 * Deduplicate events that occur within `debounceMs` of each other with identical attributes.
 * Prevents sensor duplicate echoes or network re-transmissions from skewing session counts.
 */
export function deduplicateEvents(events: OccupancyEvent[], debounceMs = 500): OccupancyEvent[] {
  if (events.length <= 1) return [...events];
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const result: OccupancyEvent[] = [];

  for (const e of sorted) {
    const t = new Date(e.timestamp).getTime();
    if (isNaN(t)) continue; // Discard invalid timestamp records

    const prev = result[result.length - 1];
    if (
      prev &&
      prev.room_id === e.room_id &&
      prev.event_type === e.event_type &&
      prev.target_id === e.target_id &&
      Math.abs(t - new Date(prev.timestamp).getTime()) <= debounceMs
    ) {
      continue; // Skip duplicate echo
    }
    result.push(e);
  }
  return result;
}

/**
 * Detect sensor offline/disconnected intervals from explicit sensor_disconnected events
 * or heartbeat gaps exceeding `heartbeatTimeoutMs`.
 */
export function detectOfflineIntervals(
  events: Pick<OccupancyEvent, "room_id" | "event_type" | "timestamp">[],
  from: number,
  to: number,
  heartbeatTimeoutMs?: number,
): OfflineInterval[] {
  const valid = events.filter((e) => e && e.timestamp && !isNaN(new Date(e.timestamp).getTime()));
  const sorted = [...valid].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const rawIntervals: OfflineInterval[] = [];
  const openDisconnects = new Map<string, number>();
  const lastEventTimeByRoom = new Map<string, number>();

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const t = new Date(e.timestamp).getTime();
    const roomId = e.room_id;
    if (!roomId) continue;

    const prevT = lastEventTimeByRoom.get(roomId);

    // Check heartbeat gap between consecutive events for this room if timeout is configured
    if (heartbeatTimeoutMs && prevT !== undefined) {
      const gap = t - prevT;
      // Only record heartbeat timeout if room was not already explicitly disconnected during this gap
      if (gap > heartbeatTimeoutMs && !openDisconnects.has(roomId)) {
        rawIntervals.push({
          room_id: roomId,
          start: prevT + heartbeatTimeoutMs,
          end: t,
          reason: "heartbeat_timeout",
        });
      }
    }

    if (e.event_type === "sensor_disconnected") {
      if (!openDisconnects.has(roomId)) {
        openDisconnects.set(roomId, t);
      }
    } else if (e.event_type === "sensor_reconnected") {
      const discStart = openDisconnects.get(roomId);
      if (discStart !== undefined) {
        rawIntervals.push({
          room_id: roomId,
          start: discStart,
          end: Math.max(discStart, t),
          reason: "sensor_disconnected",
        });
        openDisconnects.delete(roomId);
      }
    }

    lastEventTimeByRoom.set(roomId, t);
  }

  // Close any unclosed disconnect intervals at window end
  for (const [roomId, discStart] of openDisconnects) {
    rawIntervals.push({
      room_id: roomId,
      start: discStart,
      end: Math.max(discStart, to),
      reason: "sensor_disconnected",
    });
  }

  // Filter to window overlap
  const clamped = rawIntervals.filter((iv) => iv.end > from && iv.start < to);

  // Group by room and merge any overlapping or contiguous intervals to prevent double-counting
  const byRoom = new Map<string, OfflineInterval[]>();
  for (const iv of clamped) {
    let list = byRoom.get(iv.room_id);
    if (!list) {
      list = [];
      byRoom.set(iv.room_id, list);
    }
    list.push(iv);
  }

  const mergedIntervals: OfflineInterval[] = [];
  for (const [, list] of byRoom) {
    list.sort((a, b) => a.start - b.start);
    let current = list[0];
    if (!current) continue;

    for (let j = 1; j < list.length; j++) {
      const next = list[j]!;
      if (next.start <= current.end) {
        // Merge overlapping or adjacent intervals
        current = {
          room_id: current.room_id,
          start: current.start,
          end: Math.max(current.end, next.end),
          reason:
            current.reason === "sensor_disconnected" || next.reason === "sensor_disconnected"
              ? "sensor_disconnected"
              : "heartbeat_timeout",
        };
      } else {
        mergedIntervals.push(current);
        current = next;
      }
    }
    mergedIntervals.push(current);
  }

  return mergedIntervals.sort((a, b) => a.start - b.start);
}

/**
 * Pair room_occupied → room_vacant events into occupancy sessions per room.
 *
 * Capping rules:
 * - When `windowTo` is specified, open sessions are capped at `Math.min(now, windowTo)`.
 *   This strictly prevents historical query windows from leaking into the present or future.
 * - Monotonicity is enforced (end >= start).
 * - Disconnect handling: when an active session encounters a `sensor_disconnected` event
 *   or heartbeat timeout, the session is capped at the disconnect timestamp and marked
 *   as "censored_by_disconnect", rather than claiming continuous occupancy.
 */
export function occupancySessions(
  events: Pick<OccupancyEvent, "room_id" | "event_type" | "timestamp">[],
  now: number,
  windowTo?: number,
  options?: { heartbeatTimeoutMs?: number },
): Session[] {
  const effectiveEnd = windowTo !== undefined ? Math.min(now, windowTo) : now;
  const open = new Map<string, { start: number; lastSeen: number }>();
  const out: Session[] = [];
  const valid = events.filter((e) => e && e.timestamp && !isNaN(new Date(e.timestamp).getTime()));
  const sorted = [...valid].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const heartbeatTimeout = options?.heartbeatTimeoutMs;

  for (const e of sorted) {
    if (!e.room_id) continue;
    const t = new Date(e.timestamp).getTime();

    // Check if open session for this room had a heartbeat timeout before event `e`
    const openState = open.get(e.room_id);
    if (openState && heartbeatTimeout && t - openState.lastSeen > heartbeatTimeout) {
      // Sensor went silent during occupancy: censor session at lastSeen + timeout
      const censoredEnd = Math.min(openState.lastSeen + heartbeatTimeout, effectiveEnd);
      out.push({
        room_id: e.room_id,
        start: openState.start,
        end: Math.max(openState.start, censoredEnd),
        status: "censored_by_disconnect",
      });
      open.delete(e.room_id);
    }

    if (e.event_type === "room_occupied") {
      // If not already open, record new session start
      if (!open.has(e.room_id)) {
        open.set(e.room_id, { start: t, lastSeen: t });
      } else {
        open.get(e.room_id)!.lastSeen = t;
      }
    } else if (e.event_type === "room_vacant") {
      const s = open.get(e.room_id);
      if (s !== undefined) {
        // Enforce monotonicity
        const end = Math.max(s.start, Math.min(t, effectiveEnd));
        out.push({ room_id: e.room_id, start: s.start, end });
        open.delete(e.room_id);
      }
    } else if (e.event_type === "sensor_disconnected") {
      const s = open.get(e.room_id);
      if (s !== undefined) {
        // Prolonged sensor disconnect while occupied: truncate session, do not claim continued occupancy
        const end = Math.max(s.start, Math.min(t, effectiveEnd));
        out.push({ room_id: e.room_id, start: s.start, end, status: "censored_by_disconnect" });
        open.delete(e.room_id);
      }
    } else {
      // Other events update lastSeen for open session
      const s = open.get(e.room_id);
      if (s) {
        s.lastSeen = t;
      }
    }
  }

  // Capped open sessions that never had a room_vacant event before window end
  for (const [room_id, s] of open) {
    // If heartbeat timeout is active and gap to effectiveEnd exceeds timeout, censor
    if (heartbeatTimeout && effectiveEnd - s.lastSeen > heartbeatTimeout) {
      const censoredEnd = Math.min(s.lastSeen + heartbeatTimeout, effectiveEnd);
      out.push({
        room_id,
        start: s.start,
        end: Math.max(s.start, censoredEnd),
        status: "censored_by_disconnect",
      });
    } else {
      const end = Math.max(s.start, effectiveEnd);
      const isHistoricalWindow = windowTo !== undefined && windowTo < now;
      if (isHistoricalWindow) {
        out.push({
          room_id,
          start: s.start,
          end,
          status: "censored_by_window",
        });
      } else {
        out.push({
          room_id,
          start: s.start,
          end,
        });
      }
    }
  }

  return out;
}

/**
 * Extract detailed session objects with duration measurements and open-state flags.
 */
export function detailedOccupancySessions(
  events: Pick<OccupancyEvent, "room_id" | "event_type" | "timestamp">[],
  now: number,
  windowTo?: number,
  options?: { heartbeatTimeoutMs?: number },
): DetailedSession[] {
  const baseSessions = occupancySessions(events, now, windowTo, options);
  const effectiveEnd = windowTo !== undefined ? Math.min(now, windowTo) : now;

  return baseSessions.map((s) => {
    const durMs = Math.max(0, s.end - s.start);
    return {
      ...s,
      durationMs: durMs,
      durationMinutes: Math.round((durMs / 60000) * 10) / 10,
      open:
        s.status === "open" ||
        (s.end >= effectiveEnd - 1000 && s.status !== "censored_by_disconnect"),
    };
  });
}

/** Occupied milliseconds of `sessions` that overlap [from, to). */
export function occupiedMs(sessions: Session[], from: number, to: number, roomId?: string): number {
  let ms = 0;
  for (const s of sessions) {
    if (roomId && s.room_id !== roomId) continue;
    const overlap = Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
    ms += overlap;
  }
  return ms;
}

/** Utilisation as a percentage (0–100, one decimal) of the window. */
export function utilisation(
  sessions: Session[],
  from: number,
  to: number,
  roomId?: string,
): number {
  const span = to - from;
  if (span <= 0) return 0;
  const occ = occupiedMs(sessions, from, to, roomId);
  return Math.min(100, Math.round((occ / span) * 1000) / 10);
}

/** Bucket events into `n` uniform time slices over [from, from + bucketMs * n). */
export function bucketCounts(
  events: Pick<OccupancyEvent, "timestamp" | "event_type">[],
  from: number,
  bucketMs: number,
  n: number,
  types: string[],
): number[] {
  const arr = Array.from({ length: n }, () => 0);
  for (const e of events) {
    if (!e || !types.includes(e.event_type)) continue;
    const t = new Date(e.timestamp).getTime();
    if (isNaN(t)) continue;
    const i = Math.floor((t - from) / bucketMs);
    if (i >= 0 && i < n) {
      arr[i] = (arr[i] ?? 0) + 1;
    }
  }
  return arr;
}

/**
 * Comprehensive activity calculation: aggregates occupancy durations, sessions,
 * target detection counts, data coverage, and duration distributions.
 */
export function calculateActivitySummary(
  events: OccupancyEvent[],
  from: number,
  to: number,
  roomId?: string,
  options?: {
    now?: number;
    windowTo?: number;
    heartbeatTimeoutMs?: number;
    roomIds?: string[];
  },
): ActivitySummary {
  const scoped = roomId ? events.filter((e) => e.room_id === roomId) : events;
  const inWindow = scoped.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t >= from && t <= to;
  });

  const curNow = options?.now ?? to;
  const winTo = options?.windowTo ?? to;
  const timeoutMs = options?.heartbeatTimeoutMs;
  const sessions = occupancySessions(
    scoped,
    curNow,
    winTo,
    timeoutMs !== undefined ? { heartbeatTimeoutMs: timeoutMs } : undefined,
  );

  // Filter sessions that intersect the window
  const winSessions = sessions.filter(
    (s) => s.end > from && s.start < to && (!roomId || s.room_id === roomId),
  );

  // Determine included rooms for aggregate observation calculation
  let includedRooms: string[];
  if (roomId) {
    includedRooms = [roomId];
  } else if (options?.roomIds && options.roomIds.length > 0) {
    includedRooms = Array.from(new Set(options.roomIds));
  } else {
    const detected = Array.from(
      new Set(scoped.map((e) => e.room_id).filter((id): id is string => Boolean(id))),
    );
    includedRooms = detected.length > 0 ? detected : ["default"];
  }

  const roomSpanMs = Math.max(0, to - from);
  const totalPotentialSpanMs = roomSpanMs * includedRooms.length;

  // Compute offline / censored interval duration per room
  const offlineIntervals = detectOfflineIntervals(scoped, from, to, options?.heartbeatTimeoutMs);
  let totalOfflineMs = 0;
  let totalValidObservationMs = 0;
  let totalOccMs = 0;

  for (const rid of includedRooms) {
    let roomOfflineMs = 0;
    for (const iv of offlineIntervals) {
      if (iv.room_id !== rid) continue;
      const overlap = Math.max(0, Math.min(iv.end, to) - Math.max(iv.start, from));
      roomOfflineMs += overlap;
    }
    roomOfflineMs = Math.min(roomSpanMs, roomOfflineMs);
    totalOfflineMs += roomOfflineMs;

    const roomValidMs = Math.max(0, roomSpanMs - roomOfflineMs);
    totalValidObservationMs += roomValidMs;

    const roomOccMs = occupiedMs(winSessions, from, to, rid);
    // Occupied time cannot exceed valid observation time for the room
    const clampedRoomOccMs = Math.min(roomValidMs, roomOccMs);
    totalOccMs += clampedRoomOccMs;
  }

  // Aggregate coverage percentage across all included rooms
  const dataCoveragePct =
    totalPotentialSpanMs > 0
      ? Math.min(100, Math.round((totalValidObservationMs / totalPotentialSpanMs) * 1000) / 10)
      : 0;

  // Aggregate vacant time and utilization percentage strictly relative to valid observation time
  const totalVacantMs = Math.max(0, totalValidObservationMs - totalOccMs);
  const util =
    totalValidObservationMs > 0
      ? Math.min(100, Math.max(0, Math.round((totalOccMs / totalValidObservationMs) * 1000) / 10))
      : 0;

  // Session durations in minutes for window-clamped portions
  const durationsMin = winSessions.map(
    (s) => Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)) / 60000,
  );

  durationsMin.sort((a, b) => a - b);
  const avgDuration =
    durationsMin.length > 0
      ? Math.round((durationsMin.reduce((a, b) => a + b, 0) / durationsMin.length) * 10) / 10
      : 0;

  let medianDuration = 0;
  if (durationsMin.length > 0) {
    const mid = Math.floor(durationsMin.length / 2);
    medianDuration =
      durationsMin.length % 2 !== 0
        ? Math.round((durationsMin[mid] ?? 0) * 10) / 10
        : Math.round((((durationsMin[mid - 1] ?? 0) + (durationsMin[mid] ?? 0)) / 2) * 10) / 10;
  }
  const maxDuration =
    durationsMin.length > 0
      ? Math.round((durationsMin[durationsMin.length - 1] ?? 0) * 10) / 10
      : 0;

  // Target detections and movement events
  const targetDetections = inWindow.filter((e) => e.event_type === "target_detected").length;
  const movementEvents = inWindow.filter((e) => e.event_type === "target_moved").length;

  const targetChannels = new Set<number>();
  for (const e of inWindow) {
    if (typeof e.target_id === "number" && e.target_id > 0) {
      targetChannels.add(e.target_id);
    }
  }

  // Duration histogram bins
  const binDefs = [
    { label: "<1m", min: 0, max: 1 },
    { label: "1–5m", min: 1, max: 5 },
    { label: "5–15m", min: 5, max: 15 },
    { label: "15–30m", min: 15, max: 30 },
    { label: "30–60m", min: 30, max: 60 },
    { label: ">1h", min: 60, max: 1e9 },
  ] as const;

  const durationsHistogram = binDefs.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: durationsMin.filter((d) => d >= b.min && d < b.max).length,
  }));

  return {
    totalOccupiedMs: totalOccMs,
    totalVacantMs,
    offlineDurationMs: totalOfflineMs,
    dataCoveragePct,
    utilisationPct: util,
    totalSessions: winSessions.length,
    avgSessionDurationMinutes: avgDuration,
    medianSessionDurationMinutes: medianDuration,
    maxSessionDurationMinutes: maxDuration,
    totalTargetDetections: targetDetections,
    totalMovementEvents: movementEvents,
    uniqueTargetChannels: Array.from(targetChannels).sort((a, b) => a - b),
    durationsHistogram,
  };
}

/**
 * Aggregate daily activity metrics for calendar days in [from, to) using unified timezone policy.
 * Handles 23-hour and 25-hour days across daylight saving transitions and scales all-room
 * aggregate denominators consistently across included rooms.
 */
export function calculateDailySummaries(
  sessions: Session[],
  events: OccupancyEvent[],
  from: number,
  to: number,
  roomId?: string,
  timezone?: TimezoneOption,
  options?: { roomIds?: string[] },
): DailyActivitySummary[] {
  const result: DailyActivitySummary[] = [];
  if (to <= from) return result;

  const intervals = getCalendarDayIntervals(from, to, timezone);

  // Determine room count for all-room aggregate denominator scaling
  let roomCount = 1;
  if (!roomId) {
    if (options?.roomIds && options.roomIds.length > 0) {
      roomCount = new Set(options.roomIds).size;
    } else {
      const distinct = new Set<string>();
      for (const s of sessions) if (s.room_id) distinct.add(s.room_id);
      for (const e of events) if (e.room_id) distinct.add(e.room_id);
      roomCount = Math.max(1, distinct.size);
    }
  }

  for (const iv of intervals) {
    const dayStart = iv.start;
    const dayEnd = iv.end;
    const nominalDaySpan = Math.max(0, dayEnd - dayStart);
    if (nominalDaySpan <= 0) continue;

    const totalDaySpan = nominalDaySpan * roomCount;

    const occ = occupiedMs(sessions, dayStart, dayEnd, roomId);
    const occMin = Math.round(occ / 60000);
    const util = Math.min(100, Math.round((occ / totalDaySpan) * 1000) / 10);

    const daySessions = sessions.filter(
      (s) => s.end > dayStart && s.start < dayEnd && (!roomId || s.room_id === roomId),
    ).length;

    const dayDetections = events.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return (
        t >= dayStart &&
        t < dayEnd &&
        (!roomId || e.room_id === roomId) &&
        (e.event_type === "target_detected" || e.event_type === "target_moved")
      );
    }).length;

    result.push({
      dateIso: iv.dateIso,
      label: iv.label,
      dayOfWeek: iv.dayOfWeek,
      occupiedMinutes: occMin,
      utilisationPct: util,
      sessionCount: daySessions,
      detectionCount: dayDetections,
    });
  }

  return result;
}

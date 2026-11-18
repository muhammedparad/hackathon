// Works out when a room had NO DATA (device or sensor offline), as opposed to a room that was simply empty.
// Playback counts that time but marks it explicitly, like a camera feed that shows "no signal".
import type { OccupancyEvent } from "@/lib/firebase/db";

export type CoverageKind = "device_offline" | "sensor_offline";

export interface CoverageGap {
  from: number; // epoch ms
  to: number; // epoch ms
  kind: CoverageKind;
  /** Still offline right now (no end yet; `to` is the current time) */
  ongoing: boolean;
}

export const OFFLINE_AFTER_MS = 60_000;
const MIN_GAP_MS = 1000;

type EventLike = Pick<
  OccupancyEvent,
  "event_type" | "timestamp" | "gap_started_at" | "gap_ended_at"
>;

export function buildCoverageGaps(
  events: EventLike[],
  opts: {
    windowStart: number;
    windowEnd: number;
    nowMs: number;
    /** Newest last_seen among the room's devices, to catch an outage that has not ended yet */
    lastSeenMs?: number | null | undefined;
    offlineAfterMs?: number | undefined;
  },
): CoverageGap[] {
  const raw: CoverageGap[] = [];
  const nowInWindow = opts.nowMs >= opts.windowStart && opts.nowMs <= opts.windowEnd;

  // 1. Silence the server recorded when the device came back (power, Wi-Fi, server restart)
  for (const e of events) {
    if (e.event_type !== "data_gap") continue;
    const from = Date.parse(e.gap_started_at ?? "");
    const to = Date.parse(e.gap_ended_at ?? e.timestamp);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      raw.push({ from, to, kind: "device_offline", ongoing: false });
    }
  }

  // 2. The device was up but its radar sensor was silent: disconnected ... reconnected
  const sensorEvents = events
    .filter((e) => e.event_type === "sensor_disconnected" || e.event_type === "sensor_reconnected")
    .map((e) => ({ type: e.event_type, at: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  let openedAt: number | null = null;
  for (const e of sensorEvents) {
    if (e.type === "sensor_disconnected" && openedAt === null) openedAt = e.at;
    else if (e.type === "sensor_reconnected" && openedAt !== null) {
      raw.push({ from: openedAt, to: e.at, kind: "sensor_offline", ongoing: false });
      openedAt = null;
    }
  }
  if (openedAt !== null) {
    const end = nowInWindow ? opts.nowMs : opts.windowEnd;
    raw.push({ from: openedAt, to: end, kind: "sensor_offline", ongoing: nowInWindow });
  }

  // 3. An outage still going on: the device has not reported for a while
  const offlineAfter = opts.offlineAfterMs ?? OFFLINE_AFTER_MS;
  if (
    nowInWindow &&
    opts.lastSeenMs != null &&
    Number.isFinite(opts.lastSeenMs) &&
    opts.nowMs - opts.lastSeenMs >= offlineAfter
  ) {
    raw.push({
      from: Math.max(opts.lastSeenMs, opts.windowStart),
      to: opts.nowMs,
      kind: "device_offline",
      ongoing: true,
    });
  }

  // Clip to the window, drop slivers, merge overlaps (a device outage outranks a sensor one)
  const clipped = raw
    .map((g) => ({
      ...g,
      from: Math.max(g.from, opts.windowStart),
      to: Math.min(g.to, opts.windowEnd),
    }))
    .filter((g) => g.to - g.from >= MIN_GAP_MS)
    .sort((a, b) => a.from - b.from);

  const merged: CoverageGap[] = [];
  for (const g of clipped) {
    const last = merged[merged.length - 1];
    if (last && g.from <= last.to) {
      last.to = Math.max(last.to, g.to);
      last.ongoing = last.ongoing || g.ongoing;
      if (g.kind === "device_offline") last.kind = "device_offline";
    } else {
      merged.push({ ...g });
    }
  }
  return merged;
}

export function gapLabel(g: Pick<CoverageGap, "kind">): string {
  return g.kind === "device_offline" ? "Device offline — no data" : "Sensor offline — no data";
}

import type { OccupancyEvent } from "@/lib/firebase/db";
import type { RoomZone, TrajectorySegment } from "@/lib/radar/types";
import { calculateActivitySummary, occupancySessions } from "./activity";
import { isAlertEvent } from "./alerts";
import { calculateZoneDwellAndActivity } from "./spatial";
import type { PeriodComparisonResult, PeriodMetrics } from "./types";

/**
 * Compare room activity and occupancy metrics between two distinct time windows (Current vs Previous/Baseline).
 */
export function comparePeriods(
  events: OccupancyEvent[],
  currentRange: { from: number; to: number; label?: string | undefined },
  previousRange: { from: number; to: number; label?: string | undefined },
  options?: {
    roomId?: string | undefined;
    zones?: RoomZone[] | undefined;
    currentSegments?: TrajectorySegment[] | undefined;
    previousSegments?: TrajectorySegment[] | undefined;
  },
): PeriodComparisonResult {
  const { roomId, zones = [], currentSegments = [], previousSegments = [] } = options ?? {};

  // Current Period Metrics
  const curSummary = calculateActivitySummary(events, currentRange.from, currentRange.to, roomId);
  const curAlerts = events.filter((e) => {
    if (roomId && e.room_id !== roomId) return false;
    const t = new Date(e.timestamp).getTime();
    return t >= currentRange.from && t <= currentRange.to && isAlertEvent(e);
  }).length;

  const currentMetrics: PeriodMetrics = {
    label: currentRange.label ?? "Current Period",
    from: currentRange.from,
    to: currentRange.to,
    occupiedHours: Math.round((curSummary.totalOccupiedMs / 3600_000) * 10) / 10,
    utilisationPct: curSummary.utilisationPct,
    sessionCount: curSummary.totalSessions,
    avgDurationMinutes: curSummary.avgSessionDurationMinutes,
    alertCount: curAlerts,
    detections: curSummary.totalTargetDetections + curSummary.totalMovementEvents,
  };

  // Previous Period Metrics
  const prevSummary = calculateActivitySummary(
    events,
    previousRange.from,
    previousRange.to,
    roomId,
  );
  const prevAlerts = events.filter((e) => {
    if (roomId && e.room_id !== roomId) return false;
    const t = new Date(e.timestamp).getTime();
    return t >= previousRange.from && t <= previousRange.to && isAlertEvent(e);
  }).length;

  const previousMetrics: PeriodMetrics = {
    label: previousRange.label ?? "Previous Period",
    from: previousRange.from,
    to: previousRange.to,
    occupiedHours: Math.round((prevSummary.totalOccupiedMs / 3600_000) * 10) / 10,
    utilisationPct: prevSummary.utilisationPct,
    sessionCount: prevSummary.totalSessions,
    avgDurationMinutes: prevSummary.avgSessionDurationMinutes,
    alertCount: prevAlerts,
    detections: prevSummary.totalTargetDetections + prevSummary.totalMovementEvents,
  };

  // Calculate Deltas
  const occHoursDelta =
    Math.round((currentMetrics.occupiedHours - previousMetrics.occupiedHours) * 10) / 10;
  const occHoursPctChange =
    previousMetrics.occupiedHours > 0
      ? Math.round(
          ((currentMetrics.occupiedHours - previousMetrics.occupiedHours) /
            previousMetrics.occupiedHours) *
            1000,
        ) / 10
      : currentMetrics.occupiedHours > 0
        ? 100
        : 0;

  const utilDelta =
    Math.round((currentMetrics.utilisationPct - previousMetrics.utilisationPct) * 10) / 10;
  const sessionCountDelta = currentMetrics.sessionCount - previousMetrics.sessionCount;
  const alertCountDelta = currentMetrics.alertCount - previousMetrics.alertCount;
  const detectionsDelta = currentMetrics.detections - previousMetrics.detections;

  // Zone Dwell Shifts
  const curZoneActivity = calculateZoneDwellAndActivity(currentSegments, zones);
  const prevZoneActivity = calculateZoneDwellAndActivity(previousSegments, zones);

  const zoneShifts = zones.map((z) => {
    const curZ = curZoneActivity.find((a) => a.zoneId === z.id);
    const prevZ = prevZoneActivity.find((a) => a.zoneId === z.id);
    const curMin = curZ?.dwellMinutes ?? 0;
    const prevMin = prevZ?.dwellMinutes ?? 0;
    return {
      zoneId: z.id,
      zoneName: z.name,
      currentMinutes: curMin,
      previousMinutes: prevMin,
      deltaMinutes: Math.round((curMin - prevMin) * 10) / 10,
    };
  });

  return {
    current: currentMetrics,
    previous: previousMetrics,
    deltas: {
      occupiedHoursDelta: occHoursDelta,
      occupiedHoursPctChange: occHoursPctChange,
      utilisationDelta: utilDelta,
      sessionCountDelta: sessionCountDelta,
      alertCountDelta: alertCountDelta,
      detectionsDelta: detectionsDelta,
    },
    zoneShifts,
  };
}

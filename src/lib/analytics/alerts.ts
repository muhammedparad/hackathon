import type { AlertSeverity, EventType } from "@/lib/radar/types";
import type { OccupancyEvent } from "@/lib/firebase/db";
import type { AlertsSummary } from "./types";

const ALERT_EVENT_TYPES = new Set<string>([
  "restricted_zone_entry",
  "restricted_zone_exit",
  "hazard_zone_entry",
  "hazard_prolonged_presence",
  "unexpected_entry",
  "unusual_movement",
  "prolonged_presence",
  "routine_deviation",
  "candidate_fall",
]);

/**
 * Check if an event record represents an alert or hazard event.
 */
export function isAlertEvent(event: OccupancyEvent): boolean {
  if (event.severity && event.severity !== "info") return true;
  if (ALERT_EVENT_TYPES.has(event.event_type)) return true;
  return false;
}

/**
 * Pure, read-only alert analytics aggregator.
 * Summarizes alerts by severity, event type, acknowledgment status, affected zones,
 * and detects recurring patterns over time. Never generates or modifies alert records.
 */
export function calculateAlertsSummary(
  events: OccupancyEvent[],
  from: number,
  to: number,
  roomId?: string,
): AlertsSummary {
  const scoped = events.filter((e) => {
    if (roomId && e.room_id !== roomId) return false;
    const t = new Date(e.timestamp).getTime();
    return t >= from && t <= to && isAlertEvent(e);
  });

  const bySeverity: Record<AlertSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  const byType: Record<string, number> = {};
  let acknowledgedCount = 0;
  let unacknowledgedCount = 0;
  let totalAckTimeMs = 0;
  let ackTimeCount = 0;

  const zoneCountMap = new Map<string, number>();
  const dailyTrendsMap = new Map<string, { count: number; criticalOrHighCount: number }>();

  for (const e of scoped) {
    // Severity tally
    const sev = (e.severity ?? "info") as AlertSeverity;
    if (bySeverity[sev] !== undefined) {
      bySeverity[sev]++;
    } else {
      bySeverity.info++;
    }

    // Type tally
    byType[e.event_type] = (byType[e.event_type] ?? 0) + 1;

    // Acknowledgment stats
    if (e.acknowledged) {
      acknowledgedCount++;
      if (e.acknowledged_at) {
        const createT = new Date(e.timestamp).getTime();
        const ackT = new Date(e.acknowledged_at).getTime();
        if (ackT >= createT) {
          totalAckTimeMs += ackT - createT;
          ackTimeCount++;
        }
      }
    } else {
      unacknowledgedCount++;
    }

    // Zone tally
    const zoneName =
      e.zone_name ?? e.evidence?.zone_name ?? (e.zone_id ? `Zone ${e.zone_id}` : null);
    if (zoneName) {
      zoneCountMap.set(zoneName, (zoneCountMap.get(zoneName) ?? 0) + 1);
    }

    // Daily trend tally
    const d = new Date(e.timestamp);
    const dateKey = d.toISOString().split("T")[0] ?? d.toDateString();
    let trend = dailyTrendsMap.get(dateKey);
    if (!trend) {
      trend = { count: 0, criticalOrHighCount: 0 };
      dailyTrendsMap.set(dateKey, trend);
    }
    trend.count++;
    if (sev === "critical" || sev === "high") {
      trend.criticalOrHighCount++;
    }
  }

  const totalAlerts = scoped.length;
  const acknowledgementRatePct =
    totalAlerts > 0 ? Math.round((acknowledgedCount / totalAlerts) * 1000) / 10 : 100;
  const avgTimeToAcknowledgeMs =
    ackTimeCount > 0 ? Math.round(totalAckTimeMs / ackTimeCount) : null;

  // Top affected zones
  const topAffectedZones = Array.from(zoneCountMap.entries())
    .map(([zoneName, count]) => ({ zoneName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Identify repeated patterns (clusters of repeated alerts in same zone or type)
  const repeatedPatterns: { title: string; count: number; description: string }[] = [];

  for (const [zoneName, count] of zoneCountMap.entries()) {
    if (count >= 3) {
      repeatedPatterns.push({
        title: `Repeated Zone Triggers: ${zoneName}`,
        count,
        description: `${count} alerts recorded in zone '${zoneName}' within the selected period.`,
      });
    }
  }

  for (const [type, count] of Object.entries(byType)) {
    if (count >= 4) {
      repeatedPatterns.push({
        title: `Frequent Event Type: ${type.replace(/_/g, " ")}`,
        count,
        description: `${count} incidents of '${type}' detected across the room.`,
      });
    }
  }

  // Daily trends sorted chronologically
  const dailyTrends = Array.from(dailyTrendsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date: new Date(date).toLocaleDateString([], { month: "short", day: "numeric" }),
      count: data.count,
      criticalOrHighCount: data.criticalOrHighCount,
    }));

  return {
    totalAlerts,
    bySeverity,
    byType,
    acknowledgedCount,
    unacknowledgedCount,
    acknowledgementRatePct,
    avgTimeToAcknowledgeMs,
    topAffectedZones,
    repeatedPatterns,
    dailyTrends,
  };
}

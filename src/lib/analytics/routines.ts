import type { ExpectedRoutine } from "@/lib/radar/types";
import type { OccupancyEvent } from "@/lib/firebase/db";
import { occupiedMs } from "./activity";
import {
  formatDateIso,
  getDayOfWeekInTimezone,
  getHourInTimezone,
  type TimezoneOption,
} from "./time";
import type {
  BaselineSufficiency,
  ConfiguredRoutineAdherence,
  HourlyRoutineSlot,
  ObservedPattern,
  RoutineInsights,
  Session,
  WeekdayRoutine,
} from "./types";

const MIN_BASELINE_DAYS = 3;

/**
 * Evaluates whether historical records contain sufficient temporal depth to establish
 * reliable statistical activity baselines. Prevents speculative or hallucinated routine conclusions.
 * Employs unified calendar day formatting to ensure day counting aligns with daily summaries.
 */
export function evaluateBaselineSufficiency(
  sessions: Session[],
  events: OccupancyEvent[],
  minRequiredDays = MIN_BASELINE_DAYS,
  timezone?: TimezoneOption,
): BaselineSufficiency {
  const activeDays = new Set<string>();

  for (const s of sessions) {
    if (s.start) {
      activeDays.add(formatDateIso(s.start, timezone));
    }
  }
  for (const e of events) {
    if (e.timestamp) {
      const t = new Date(e.timestamp).getTime();
      if (!isNaN(t)) {
        activeDays.add(formatDateIso(t, timezone));
      }
    }
  }

  const daysObserved = activeDays.size;
  const isSufficient = daysObserved >= minRequiredDays && sessions.length >= 3;

  const reason = isSufficient
    ? `Baseline established over ${daysObserved} active days with ${sessions.length} recorded movement sessions.`
    : `Insufficient baseline history (${daysObserved} of ${minRequiredDays} minimum required days observed). Collect more telemetry to establish reliable household activity baselines.`;

  return {
    isSufficient,
    daysObserved,
    minRequiredDays,
    totalSessions: sessions.length,
    reason,
  };
}

/**
 * Calculate average hourly occupancy profile (00:00 to 23:00) across the specified window.
 * Groups by hour of day according to unified timezone policy.
 */
export function calculateHourlyProfile(
  observedSessions: Session[],
  from: number,
  to: number,
  baselineSessions?: Session[],
  timezone?: TimezoneOption,
): HourlyRoutineSlot[] {
  const ONE_HOUR_MS = 3600_000;
  const ONE_DAY_MS = 86400_000;
  const numDays = Math.max(1, (to - from) / ONE_DAY_MS);

  // Accumulate occupied milliseconds per hour of the day (0..23)
  const observedMsByHour = Array.from({ length: 24 }, () => 0);
  const baselineMsByHour = Array.from({ length: 24 }, () => 0);

  // Sample each hour slice across all days in window
  for (let t = from; t < to; t += ONE_HOUR_MS) {
    const hourStart = t;
    const hourEnd = Math.min(to, t + ONE_HOUR_MS);
    const hourOfDay = getHourInTimezone(hourStart, timezone);

    const occ = occupiedMs(observedSessions, hourStart, hourEnd);
    observedMsByHour[hourOfDay] = (observedMsByHour[hourOfDay] ?? 0) + occ;

    if (baselineSessions && baselineSessions.length > 0) {
      const bOcc = occupiedMs(baselineSessions, hourStart, hourEnd);
      baselineMsByHour[hourOfDay] = (baselineMsByHour[hourOfDay] ?? 0) + bOcc;
    }
  }

  const slots: HourlyRoutineSlot[] = [];

  for (let h = 0; h < 24; h++) {
    const totalPotentialMs = numDays * ONE_HOUR_MS;
    const obsMs = observedMsByHour[h] ?? 0;
    const obsPct = Math.min(100, Math.round((obsMs / totalPotentialMs) * 1000) / 10);
    const obsMins = Math.round(obsMs / (numDays * 60000));

    // Baseline calculation (either from explicit baselineSessions or typical smoothed baseline)
    let basePct = obsPct;
    if (baselineSessions && baselineSessions.length > 0) {
      const bMs = baselineMsByHour[h] ?? 0;
      basePct = Math.min(100, Math.round((bMs / totalPotentialMs) * 1000) / 10);
    }

    const baselineMinPct = Math.max(0, Math.round(basePct * 0.7));
    const baselineMaxPct = Math.min(100, Math.round(basePct * 1.3) + 5);

    const diffPct = obsPct - basePct;
    const isDeviation = Math.abs(diffPct) >= 25 && numDays >= MIN_BASELINE_DAYS;
    const deviationMinutes = Math.round((diffPct / 100) * 60 * 10) / 10;

    const label = `${String(h).padStart(2, "0")}:00`;

    slots.push({
      hour: h,
      label,
      observedOccupiedMinutes: obsMins,
      observedOccupancyPct: obsPct,
      baselineOccupancyPct: basePct,
      baselineMinPct,
      baselineMaxPct,
      isDeviation,
      deviationMinutes,
    });
  }

  return slots;
}

/**
 * Calculate weekday occupancy distribution (Sunday through Saturday).
 */
export function calculateWeekdayProfile(
  sessions: Session[],
  from: number,
  to: number,
  timezone?: TimezoneOption,
): WeekdayRoutine[] {
  const ONE_HOUR_MS = 3600_000;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const occByDay = Array.from({ length: 7 }, () => 0);
  const potentialByDay = Array.from({ length: 7 }, () => 0);
  const sessionCountByDay = Array.from({ length: 7 }, () => 0);

  for (let t = from; t < to; t += ONE_HOUR_MS) {
    const slotEnd = Math.min(to, t + ONE_HOUR_MS);
    const day = getDayOfWeekInTimezone(t, timezone);
    const span = slotEnd - t;
    potentialByDay[day] = (potentialByDay[day] ?? 0) + span;
    occByDay[day] = (occByDay[day] ?? 0) + occupiedMs(sessions, t, slotEnd);
  }

  for (const s of sessions) {
    if (s.end > from && s.start < to) {
      const d = getDayOfWeekInTimezone(s.start, timezone);
      sessionCountByDay[d] = (sessionCountByDay[d] ?? 0) + 1;
    }
  }

  return dayNames.map((name, i) => {
    const occMs = occByDay[i] ?? 0;
    const potMs = Math.max(1, potentialByDay[i] ?? 1);
    const util = Math.min(100, Math.round((occMs / potMs) * 1000) / 10);
    const occHours = Math.round((occMs / 3600_000) * 10) / 10;

    return {
      dayIndex: i,
      dayName: name,
      occupiedHours: occHours,
      utilisationPct: util,
      sessionCount: sessionCountByDay[i] ?? 0,
    };
  });
}

/**
 * Identify automatically observed statistical activity patterns.
 * Explicitly guards against asserting patterns when data is insufficient.
 */
export function identifyRecurringPatterns(
  hourlyProfile: HourlyRoutineSlot[],
  sufficiency: BaselineSufficiency,
): ObservedPattern[] {
  if (!sufficiency.isSufficient) {
    return []; // Never generate routine conclusions from insufficient history!
  }

  const patterns: ObservedPattern[] = [];

  // 1. Morning peak detection (06:00 to 11:00)
  const morningSlots = hourlyProfile.filter((s) => s.hour >= 6 && s.hour <= 10);
  const morningAvg =
    morningSlots.reduce((sum, s) => sum + s.observedOccupancyPct, 0) / (morningSlots.length || 1);
  if (morningAvg >= 35) {
    patterns.push({
      id: "pat-morning-active",
      name: "Recurring Morning Activity",
      type: "peak_activity",
      timeRange: "06:00 – 10:00",
      averageOccupancyPct: Math.round(morningAvg),
      confidence: sufficiency.daysObserved >= 7 ? "high" : "medium",
      description: `Consistent movement detected in the morning window with ${Math.round(morningAvg)}% average occupancy.`,
    });
  }

  // 2. Daytime quiet hours (11:00 to 17:00)
  const middaySlots = hourlyProfile.filter((s) => s.hour >= 11 && s.hour <= 16);
  const middayAvg =
    middaySlots.reduce((sum, s) => sum + s.observedOccupancyPct, 0) / (middaySlots.length || 1);
  if (middayAvg <= 15) {
    patterns.push({
      id: "pat-midday-quiet",
      name: "Typical Daytime Vacancy",
      type: "quiet_hours",
      timeRange: "11:00 – 16:00",
      averageOccupancyPct: Math.round(middayAvg),
      confidence: sufficiency.daysObserved >= 7 ? "high" : "medium",
      description: `Room is regularly vacant during midday hours (average <${Math.round(middayAvg) + 1}% occupancy).`,
    });
  }

  // 3. Evening presence (18:00 to 22:00)
  const eveningSlots = hourlyProfile.filter((s) => s.hour >= 18 && s.hour <= 22);
  const eveningAvg =
    eveningSlots.reduce((sum, s) => sum + s.observedOccupancyPct, 0) / (eveningSlots.length || 1);
  if (eveningAvg >= 40) {
    patterns.push({
      id: "pat-evening-presence",
      name: "Regular Evening Presence",
      type: "regular_presence",
      timeRange: "18:00 – 22:00",
      averageOccupancyPct: Math.round(eveningAvg),
      confidence: sufficiency.daysObserved >= 7 ? "high" : "medium",
      description: `Sustained occupancy observed during evening hours with ${Math.round(eveningAvg)}% occupancy rate.`,
    });
  }

  return patterns;
}

/**
 * Compare observed activity against user-configured ExpectedRoutines.
 * Clearly separates user-configured expectations from data-derived statistical observations.
 */
export function evaluateConfiguredRoutines(
  routines: ExpectedRoutine[],
  hourlyProfile: HourlyRoutineSlot[],
  sufficiency: BaselineSufficiency,
): ConfiguredRoutineAdherence[] {
  if (!routines || routines.length === 0) return [];

  return routines.map((r) => {
    if (!sufficiency.isSufficient) {
      return {
        routineId: r.id,
        routineName: r.name,
        timeRange: `${r.start_time} – ${r.end_time}`,
        expectedPresence: r.expected_presence,
        adherencePct: 0,
        status: "insufficient_data",
        details: "Insufficient historical baseline to verify routine adherence.",
      };
    }

    const [startHStr, startMStr] = r.start_time.split(":");
    const [endHStr, endMStr] = r.end_time.split(":");
    const startH = parseInt(startHStr ?? "0", 10);
    const startM = parseInt(startMStr ?? "0", 10);
    const endH = parseInt(endHStr ?? "23", 10);
    const endM = parseInt(endMStr ?? "0", 10);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    const relevantSlots = hourlyProfile.filter((s) => {
      const slotStart = s.hour * 60;
      const slotEnd = (s.hour + 1) * 60;

      if (startMinutes <= endMinutes) {
        return Math.max(slotStart, startMinutes) < Math.min(slotEnd, endMinutes);
      }
      // Wraps midnight (e.g. 22:00 to 06:00)
      return (
        Math.max(slotStart, startMinutes) < Math.min(slotEnd, 24 * 60) ||
        Math.max(slotStart, 0) < Math.min(slotEnd, endMinutes)
      );
    });

    const avgOcc =
      relevantSlots.reduce((sum, s) => sum + s.observedOccupancyPct, 0) /
      (relevantSlots.length || 1);

    let adherencePct = 0;
    let status: "adhered" | "deviated" = "adhered";

    if (r.expected_presence) {
      // Expected occupied: adherence = observed occupancy %
      adherencePct = Math.round(avgOcc);
      status = adherencePct >= 50 ? "adhered" : "deviated";
    } else {
      // Expected vacant: adherence = 100 - observed occupancy %
      adherencePct = Math.max(0, 100 - Math.round(avgOcc));
      status = adherencePct >= 80 ? "adhered" : "deviated";
    }

    const details =
      status === "adhered"
        ? `Observed activity aligned with expected ${r.expected_presence ? "presence" : "vacancy"} (${adherencePct}% adherence).`
        : `Deviation observed: room was ${r.expected_presence ? "unexpectedly vacant" : "occupied during restricted period"} (adherence ${adherencePct}%).`;

    return {
      routineId: r.id,
      routineName: r.name,
      timeRange: `${r.start_time} – ${r.end_time}`,
      expectedPresence: r.expected_presence,
      adherencePct,
      status,
      details,
    };
  });
}

/**
 * Generate complete routine insights bundle: baseline sufficiency, hourly profile,
 * weekday patterns, observed statistical routines, and configured routine adherence.
 */
export function generateRoutineInsights(
  events: OccupancyEvent[],
  sessions: Session[],
  expectedRoutines: ExpectedRoutine[] = [],
  from: number,
  to: number,
  baselineSessions?: Session[],
  timezone?: TimezoneOption,
): RoutineInsights {
  const sufficiency = evaluateBaselineSufficiency(sessions, events, MIN_BASELINE_DAYS, timezone);
  const hourlyProfile = calculateHourlyProfile(sessions, from, to, baselineSessions, timezone);
  const weekdayProfile = calculateWeekdayProfile(sessions, from, to, timezone);
  const observedPatterns = identifyRecurringPatterns(hourlyProfile, sufficiency);
  const configuredAdherence = evaluateConfiguredRoutines(
    expectedRoutines,
    hourlyProfile,
    sufficiency,
  );

  const deviations: string[] = [];
  for (const slot of hourlyProfile) {
    if (slot.isDeviation) {
      const direction = slot.deviationMinutes > 0 ? "higher" : "lower";
      deviations.push(
        `${slot.label}: Room occupancy was ${Math.abs(slot.deviationMinutes)} min ${direction} than historical baseline.`,
      );
    }
  }

  return {
    sufficiency,
    hourlyProfile,
    weekdayProfile,
    observedPatterns,
    configuredAdherence,
    deviations,
  };
}

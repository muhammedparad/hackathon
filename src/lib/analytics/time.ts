/**
 * RoomTrace Analytics — Time & Timezone Utilities
 *
 * Unified date, time, and timezone handling for household activity analytics.
 * Enforces consistent calendar-day boundaries and hour bins across daily summaries,
 * hourly routine profiles, and baseline sufficiency evaluations.
 */

export type TimezoneOption = string | number | undefined;

/**
 * Returns effective minute offset for a given timestamp and timezone option.
 * If tz is a number, it is treated as a fixed UTC offset in minutes (e.g. +330 for UTC+05:30).
 * If tz is a string, it is treated as an IANA timezone name (e.g. "Asia/Kolkata", "America/New_York").
 * If tz is undefined, the environment's local timezone is used.
 */
export function getTimezoneOffsetMinutes(epochMs: number, tz?: TimezoneOption): number {
  if (typeof tz === "number") {
    return tz;
  }
  if (typeof tz === "string" && tz.trim().length > 0) {
    try {
      const date = new Date(epochMs);
      // Format in UTC and target TZ to compute exact minute delta
      const dtfTz = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: false,
      });
      const parts = dtfTz.formatToParts(date);
      let year = 1970;
      let month = 1;
      let day = 1;
      let hour = 0;
      let minute = 0;
      let second = 0;

      for (const p of parts) {
        if (p.type === "year") year = parseInt(p.value, 10);
        else if (p.type === "month") month = parseInt(p.value, 10);
        else if (p.type === "day") day = parseInt(p.value, 10);
        else if (p.type === "hour") hour = parseInt(p.value, 10);
        else if (p.type === "minute") minute = parseInt(p.value, 10);
        else if (p.type === "second") second = parseInt(p.value, 10);
      }
      if (hour === 24) hour = 0;

      const targetTimeUtc = Date.UTC(year, month - 1, day, hour, minute, second);
      return Math.round((targetTimeUtc - epochMs) / 60000);
    } catch {
      // Fallback to local offset on invalid IANA string
    }
  }
  // Local environment offset in minutes (negated because getTimezoneOffset() returns UTC - Local)
  return -new Date(epochMs).getTimezoneOffset();
}

/**
 * Formats epoch timestamp as "YYYY-MM-DD" in the specified timezone.
 */
export function formatDateIso(epochMs: number, tz?: TimezoneOption): string {
  const offsetMin = getTimezoneOffsetMinutes(epochMs, tz);
  const shifted = new Date(epochMs + offsetMin * 60000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns the hour of the day (0..23) in the specified timezone.
 */
export function getHourInTimezone(epochMs: number, tz?: TimezoneOption): number {
  const offsetMin = getTimezoneOffsetMinutes(epochMs, tz);
  const shifted = new Date(epochMs + offsetMin * 60000);
  return shifted.getUTCHours();
}

/**
 * Returns day of week (0 = Sunday .. 6 = Saturday) in the specified timezone.
 */
export function getDayOfWeekInTimezone(epochMs: number, tz?: TimezoneOption): number {
  const offsetMin = getTimezoneOffsetMinutes(epochMs, tz);
  const shifted = new Date(epochMs + offsetMin * 60000);
  return shifted.getUTCDay();
}

/**
 * Returns epoch timestamp of 00:00:00.000 for the calendar day of `epochMs` in the specified timezone.
 */
export function getCalendarDayStart(epochMs: number, tz?: TimezoneOption): number {
  const offsetMin = getTimezoneOffsetMinutes(epochMs, tz);
  const shifted = new Date(epochMs + offsetMin * 60000);
  const startUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  // Unshift to real epoch ms
  return startUtc - offsetMin * 60000;
}

/**
 * Formats calendar day labels consistently for UI and charts.
 */
export function formatCalendarDayLabel(
  epochMs: number,
  tz?: TimezoneOption,
): { dateIso: string; label: string; dayOfWeek: string } {
  const offsetMin = getTimezoneOffsetMinutes(epochMs, tz);
  const shifted = new Date(epochMs + offsetMin * 60000);

  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const dateIso = `${y}-${m}-${d}`;

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const label = `${monthNames[shifted.getUTCMonth()]} ${shifted.getUTCDate()}`;
  const dayOfWeek = dayNames[shifted.getUTCDay()] ?? "Sun";

  return { dateIso, label, dayOfWeek };
}

/**
 * Parses a date-only string ("YYYY-MM-DD") into epoch milliseconds at either
 * start-of-day (00:00:00.000) or end-of-day (23:59:59.999) in the specified timezone.
 */
export function parseDateOnly(dateStr: string, tz?: TimezoneOption, atEndOfDay = false): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    const fallback = new Date(dateStr).getTime();
    return isNaN(fallback) ? Date.now() : fallback;
  }
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10) - 1;
  const day = parseInt(match[3]!, 10);

  const hour = atEndOfDay ? 23 : 0;
  const minute = atEndOfDay ? 59 : 0;
  const second = atEndOfDay ? 59 : 0;
  const ms = atEndOfDay ? 999 : 0;

  // Approximate UTC time to query offset
  const approxUtc = Date.UTC(year, month, day, hour, minute, second, ms);
  const offsetMin = getTimezoneOffsetMinutes(approxUtc, tz);
  return approxUtc - offsetMin * 60000;
}

export interface CalendarDayInterval {
  start: number;
  end: number;
  dateIso: string;
  label: string;
  dayOfWeek: string;
}

/**
 * Generates timezone-aware, DST-safe calendar day intervals spanning [from, to).
 * Correctly accounts for 23-hour and 25-hour days across daylight saving transitions
 * without skipping, drifting, or duplicating calendar dates.
 */
export function getCalendarDayIntervals(
  from: number,
  to: number,
  tz?: TimezoneOption,
): CalendarDayInterval[] {
  if (to <= from) return [];

  // When tz is unspecified and from/to are UTC midnight multiples, evaluate in UTC
  const effectiveTz =
    tz === undefined && from % 86400_000 === 0 && (to - from) % 86400_000 === 0 ? 0 : tz;

  const intervals: CalendarDayInterval[] = [];
  let currentDateIso = formatDateIso(from, effectiveTz);

  while (true) {
    const dayStartEpoch = parseDateOnly(currentDateIso, effectiveTz, false);
    const [y, m, d] = currentDateIso.split("-").map(Number);
    if (!y || !m || !d) break;

    const nextDate = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    const nextYear = nextDate.getUTCFullYear();
    const nextMonth = String(nextDate.getUTCMonth() + 1).padStart(2, "0");
    const nextDay = String(nextDate.getUTCDate()).padStart(2, "0");
    const nextDateIso = `${nextYear}-${nextMonth}-${nextDay}`;
    const nextDayStartEpoch = parseDateOnly(nextDateIso, effectiveTz, false);

    const effectiveStart = Math.max(from, dayStartEpoch);
    const effectiveEnd = Math.min(to, nextDayStartEpoch);

    if (effectiveEnd > effectiveStart) {
      const { label, dayOfWeek } = formatCalendarDayLabel(effectiveStart, effectiveTz);
      intervals.push({
        start: effectiveStart,
        end: effectiveEnd,
        dateIso: currentDateIso,
        label,
        dayOfWeek,
      });
    }

    if (nextDayStartEpoch >= to) break;
    currentDateIso = nextDateIso;
  }

  return intervals;
}

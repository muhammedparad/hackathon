// Decides which events deserve a popup, and when a reminder is due. Pure, so it is easy to test.
import type { AlertSeverity, EventType } from "@/lib/radar/types";

export type PopupLevel = "critical" | "alert";

const ALERT_TYPES = new Set<string>([
  "restricted_zone_presence",
  "unexpected_entry",
  "sensor_disconnected",
]);

/** Someone in a danger zone, or a possible fall. These get the alarm sound. */
const DANGER_TYPES = new Set<string>([
  "hazard_zone_entry",
  "hazard_prolonged_presence",
  "restricted_zone_entry",
  "restricted_zone_presence",
  "candidate_fall",
]);

export function isDangerEvent(event: { event_type: EventType | string }): boolean {
  return DANGER_TYPES.has(event.event_type);
}

/** Entering a danger zone, or a possible fall, stays on screen until acknowledged. */
const STICKY_TYPES = new Set<string>([
  "hazard_zone_entry",
  "restricted_zone_entry",
  "candidate_fall",
]);

/** Which popup (if any) an event gets. Routine events such as entering through a door stay in the log. */
export function popupLevel(event: {
  event_type: EventType | string;
  severity?: AlertSeverity | undefined;
}): PopupLevel | null {
  if (STICKY_TYPES.has(event.event_type) || event.severity === "critical") return "critical";
  if (event.severity === "high" || event.severity === "medium") return "alert";
  if (ALERT_TYPES.has(event.event_type) || DANGER_TYPES.has(event.event_type)) return "alert";
  return null;
}

/**
 * Identifies one event whether it arrived pushed over the live socket or from the stored copy, so it pops up
 * (and sounds) once, not twice.
 */
export function eventKey(e: {
  room_id: string | null;
  event_type: string;
  timestamp: number;
  target_id?: number | null | undefined;
}): string {
  return `${e.room_id ?? ""}|${e.event_type}|${e.timestamp}|${e.target_id ?? ""}`;
}

/** Only events that happened after the page opened (minus a short grace) pop up; history does not. */
export const POPUP_GRACE_MS = 30_000;

export interface Reminder {
  id: string;
  user_id: string;
  title: string;
  /** Local time, "HH:MM" */
  time: string;
  repeat: "daily" | "once";
  /** Local date "YYYY-MM-DD", used when repeat is "once" */
  date: string | null;
  enabled: boolean;
  /** Local date "YYYY-MM-DD" on which it last popped up */
  last_fired_date: string | null;
  created_at: string;
}

export function localDateString(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function localTimeString(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Due once per day once its time has passed. A one-off reminder is due only on its own date. */
export function isReminderDue(r: Reminder, now: Date): boolean {
  if (!r.enabled || !/^\d{2}:\d{2}$/.test(r.time)) return false;
  const today = localDateString(now);
  if (r.last_fired_date === today) return false;
  if (r.repeat === "once" && r.date !== today) return false;
  return localTimeString(now) >= r.time;
}

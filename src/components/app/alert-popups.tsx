import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/auth";
import { roomsQuery } from "@/lib/data";
import { firebaseDb } from "@/lib/firebase/db";
import { useLive } from "@/lib/radar/live";
import { EVENT_LABELS } from "@/lib/radar/types";
import {
  POPUP_GRACE_MS,
  eventKey,
  isDangerEvent,
  isReminderDue,
  localDateString,
  popupLevel,
} from "@/lib/notify";
import { armAlertSound, playAlarm, type AlarmKind } from "@/lib/alert-sound";
import { remindersQuery, updateReminder } from "@/lib/reminders";

/** Alert sounds are on unless the person switched them off in Settings. */
function soundEnabled(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem("rt.notif") ?? "{}") as { sound?: boolean };
    return saved.sound !== false;
  } catch {
    return true;
  }
}

let soundHintShown = false;
/** Plays the alarm; if the browser has not unlocked audio yet, say what to do (once). */
async function sound(kind: AlarmKind) {
  if (!soundEnabled()) return;
  const played = await playAlarm(kind);
  if (!played && !soundHintShown) {
    soundHintShown = true;
    toast.info("Click anywhere on the page once so alert sounds can play", { duration: 8000 });
  }
}

function desktopNotify(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, tag: title + body });
    }
  } catch {
    /* optional */
  }
}

/**
 * Pops up new alerts as they are recorded: a sticky red popup for falls and critical events (with
 * Acknowledge and a link to Playback at that moment), a normal popup for other alerts. Routine events such as
 * entering through a door stay in the logbook and on the Playback timeline.
 */
export function AlertPopups() {
  const live = useLive();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: rooms = [] } = useQuery(roomsQuery);
  const opened = useRef(Date.now());
  const shown = useRef(new Set<string>());
  useEffect(() => armAlertSound(), []);

  useEffect(() => {
    for (const e of [...live.liveEvents].reverse()) {
      const key = eventKey(e); // the same event may arrive pushed and again from storage
      if (shown.current.has(key)) continue;
      shown.current.add(key);
      if (e.timestamp < opened.current - POPUP_GRACE_MS) continue;
      const level = popupLevel(e);
      if (!level) continue;

      const room = rooms.find((r) => r.id === e.room_id)?.name ?? "Room";
      const label = EVENT_LABELS[e.event_type] ?? e.event_type;
      const title = `${label} · ${room}`;
      const description = e.zone_name ? `${e.description} (${e.zone_name})` : e.description;
      const view = {
        label: "View in Playback",
        onClick: () =>
          void navigate({
            to: "/playback",
            search: { roomId: e.room_id, t: e.timestamp },
          }),
      };

      if (level === "critical") {
        toast.error(title, {
          description,
          duration: Infinity,
          action: view,
          cancel: {
            label: "Acknowledge",
            onClick: () => {
              void authClient.getUser().then((u) => {
                if (!u) return;
                void firebaseDb
                  .acknowledgeEvent({ eventId: e.id, roomId: e.room_id, userId: u.id })
                  .then(() => qc.invalidateQueries({ queryKey: ["events"] }))
                  .catch(() => toast.error("Could not acknowledge the alert"));
              });
            },
          },
        });
      } else {
        toast.warning(title, { description, duration: 12_000, action: view });
      }
      desktopNotify(title, description);
      void sound(isDangerEvent(e) ? "danger" : "notice");
    }
  }, [live.liveEvents, rooms, navigate, qc]);

  return null;
}

/** Checks the user's reminders every 20 s and pops each one up once per day when its time has come. */
export function ReminderTicker() {
  const qc = useQueryClient();
  const { data: reminders = [] } = useQuery(remindersQuery);
  const firing = useRef(new Set<string>());

  useEffect(() => {
    const check = () => {
      const now = new Date();
      for (const r of reminders) {
        if (firing.current.has(r.id) || !isReminderDue(r, now)) continue;
        firing.current.add(r.id);
        toast.info(`Reminder · ${r.title}`, {
          description: `Scheduled for ${r.time}`,
          duration: Infinity,
          cancel: { label: "Done", onClick: () => undefined },
        });
        desktopNotify("Reminder", r.title);
        void sound("notice");
        void updateReminder(r.id, {
          last_fired_date: localDateString(now),
          ...(r.repeat === "once" ? { enabled: false } : {}),
        })
          .then(() => qc.invalidateQueries({ queryKey: ["reminders"] }))
          .catch(() => firing.current.delete(r.id));
      }
    };
    check();
    const timer = setInterval(check, 20_000);
    return () => clearInterval(timer);
  }, [reminders, qc]);

  return null;
}

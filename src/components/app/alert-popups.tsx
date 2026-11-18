import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/auth";
import { roomsQuery } from "@/lib/data";
import { firebaseDb } from "@/lib/firebase/db";
import { useLive } from "@/lib/radar/live";
import { EVENT_LABELS } from "@/lib/radar/types";
import { POPUP_GRACE_MS, isReminderDue, localDateString, popupLevel } from "@/lib/notify";
import { remindersQuery, updateReminder } from "@/lib/reminders";

function soundEnabled(): boolean {
  try {
    return Boolean(
      (JSON.parse(localStorage.getItem("rt.notif") ?? "{}") as { sound?: boolean }).sound,
    );
  } catch {
    return false;
  }
}

function beep(urgent: boolean) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = urgent ? 880 : 660;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (urgent ? 0.5 : 0.25));
    osc.onended = () => void ctx.close();
  } catch {
    /* audio is optional */
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

  useEffect(() => {
    for (const e of [...live.liveEvents].reverse()) {
      if (shown.current.has(e.id)) continue;
      shown.current.add(e.id);
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
      if (soundEnabled()) beep(level === "critical");
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
        if (soundEnabled()) beep(false);
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

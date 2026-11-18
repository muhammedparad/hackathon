import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Clock,
  DoorClosed,
  DoorOpen,
  Flame,
  Footprints,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  UserMinus,
  UserX,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { EventType } from "@/lib/radar/types";
import { cn } from "@/lib/utils";
import { SimTag, timeAgo } from "./status";

const MAP: Record<EventType, { icon: LucideIcon; chip: string }> = {
  target_detected: { icon: Radio, chip: "bg-primary/10 text-primary" },
  target_moved: { icon: Footprints, chip: "bg-warning/15 text-warning-foreground" },
  target_lost: { icon: UserMinus, chip: "bg-muted text-muted-foreground" },
  room_occupied: { icon: DoorOpen, chip: "bg-success/10 text-success" },
  room_vacant: { icon: DoorClosed, chip: "bg-muted text-muted-foreground" },
  sensor_disconnected: { icon: WifiOff, chip: "bg-destructive/10 text-destructive" },
  sensor_reconnected: { icon: Wifi, chip: "bg-success/10 text-success" },
  point_cloud_update: { icon: Activity, chip: "bg-blue-500/10 text-blue-500" },
  restricted_zone_entry: { icon: ShieldAlert, chip: "bg-destructive/15 text-destructive" },
  restricted_zone_exit: { icon: ShieldCheck, chip: "bg-orange-500/15 text-orange-600" },
  hazard_zone_entry: { icon: AlertTriangle, chip: "bg-destructive/20 text-destructive" },
  hazard_prolonged_presence: {
    icon: AlertOctagon,
    chip: "bg-destructive/25 text-destructive font-bold",
  },
  unexpected_entry: { icon: UserX, chip: "bg-amber-500/15 text-amber-600" },
  unusual_movement: { icon: Activity, chip: "bg-yellow-500/15 text-yellow-600" },
  prolonged_presence: { icon: Clock, chip: "bg-purple-500/15 text-purple-600" },
  routine_deviation: { icon: Shuffle, chip: "bg-indigo-500/15 text-indigo-600" },
  candidate_fall: { icon: Flame, chip: "bg-rose-600/20 text-rose-600" },
};

export interface EventLike {
  id: string;
  event_type: EventType;
  description: string;
  timestamp: number;
  simulated: boolean;
  label: string;
}

/** One activity entry: icon, what happened, where, when. */
export function EventRow({
  event,
  roomName,
  now,
  dense,
}: {
  event: EventLike;
  roomName?: string | undefined;
  now: number;
  dense?: boolean | undefined;
}) {
  const { icon: Icon, chip } = MAP[event.event_type] ?? MAP.target_detected;
  const room = roomName && !event.description.includes(roomName) ? roomName : undefined;
  return (
    <li className={cn("flex items-start gap-2 border-b last:border-0", dense ? "py-2" : "py-2.5")}>
      <span
        className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", chip)}
      >
        <Icon className="size-3" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-tight">{event.label}</div>
        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {[room, event.description].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="shrink-0 whitespace-nowrap pt-0.5 text-right">
        <div className="font-mono text-[10px] tabular leading-tight text-muted-foreground">
          {timeAgo(event.timestamp, now)}
        </div>
        {event.simulated && <SimTag className="mt-1" />}
      </div>
    </li>
  );
}

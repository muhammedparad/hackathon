// Called by the device ingest routes to push what a device just reported to the owner's browsers.
// Never throws: live delivery must not break ingest.
import { getLiveHub } from "./hub.server";
import type { LiveTarget } from "./protocol";

interface PublishDevice {
  id: string;
  user_id: string;
  room_id: string | null;
}

/** One real LD2450 frame, exactly as the device sent it. Returns how many browsers received it. */
export function publishLiveFrame(
  device: PublishDevice,
  frame: { timestamp: string; received_at: string; targets: LiveTarget[] },
): number {
  try {
    return getLiveHub().publish(device.user_id, {
      type: "frame",
      device_id: device.id,
      room_id: device.room_id ?? null,
      sensor_type: "ld2450",
      timestamp: frame.timestamp,
      received_at: frame.received_at,
      targets: frame.targets,
    });
  } catch (err) {
    console.warn("[Live] publish frame failed:", err);
    return 0;
  }
}

/** The device made an authenticated call (heartbeat, or a status-only report) at `lastSeen`. */
export function publishDeviceSeen(
  device: PublishDevice,
  lastSeen: string,
  sensorStatus?: "online" | "disconnected" | "error",
): number {
  try {
    return getLiveHub().publish(device.user_id, {
      type: "device",
      device_id: device.id,
      room_id: device.room_id ?? null,
      last_seen: lastSeen,
      ...(sensorStatus ? { sensor_status: sensorStatus } : {}),
    });
  } catch (err) {
    console.warn("[Live] publish device failed:", err);
    return 0;
  }
}

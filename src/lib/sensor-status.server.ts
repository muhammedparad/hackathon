// Keeps `sensors.status` in step with what the device itself reports, so the Devices page can show a
// sensor as connected only when the device said so. Writes only when the status changes.
import type { Firestore } from "firebase-admin/firestore";

export type SensorLiveStatus = "connected" | "disconnected";

const known = new Map<string, SensorLiveStatus>();

export function _resetSensorStatusCache(): void {
  known.clear();
}

export async function syncSensorStatus(
  db: Firestore,
  device: { id: string },
  sensorType: "ld2450" | "rd61",
  status: SensorLiveStatus,
): Promise<void> {
  const key = `${device.id}:${sensorType}`;
  if (known.get(key) === status) return;

  const snap = await db
    .collection("sensors")
    .where("device_id", "==", device.id)
    .where("sensor_type", "==", sensorType)
    .get();
  const nowIso = new Date().toISOString();
  await Promise.all(
    snap.docs
      .filter((d) => d.data()["status"] !== status)
      .map((d) => d.ref.update({ status, updated_at: nowIso })),
  );
  known.set(key, status);
}

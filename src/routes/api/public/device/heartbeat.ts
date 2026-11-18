import { createFileRoute } from "@tanstack/react-router";
import { heartbeatBodySchema } from "@/lib/radar/types";
import { authenticateDevice, json } from "@/lib/device-auth.server";
import { getAdminFirestore } from "@/lib/firebase/admin.server";
import { publishDeviceSeen } from "@/lib/live/publish.server";

// POST /api/public/device/heartbeat — called by the ESP32-S3 every ~15 s.
export const Route = createFileRoute("/api/public/device/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if ("error" in auth) return auth.error;
        const body = heartbeatBodySchema.safeParse(await request.json().catch(() => ({})));
        if (!body.success) {
          return json({ error: "Invalid heartbeat", issues: body.error.issues }, 400);
        }
        const { device } = auth;
        const nowIso = new Date().toISOString();
        const wasOffline = device.status !== "connected";

        // Tell the owner's browsers this device just made an authenticated call (live WebSocket).
        publishDeviceSeen(device, nowIso, body.data.sensor_status);

        const db = getAdminFirestore();
        if (db) {
          try {
            await db
              .collection("devices")
              .doc(device.id)
              .set(
                {
                  status: "connected",
                  last_seen: nowIso,
                  updated_at: nowIso,
                  ...(body.data.firmware_version
                    ? { firmware_version: body.data.firmware_version }
                    : {}),
                  ...(body.data.ip_address ? { ip_address: body.data.ip_address } : {}),
                  ...(body.data.sensor_status ? { sensor_status: body.data.sensor_status } : {}),
                  ...(typeof body.data.ld2450_connected === "boolean"
                    ? { ld2450_connected: body.data.ld2450_connected }
                    : {}),
                },
                { merge: true },
              );

            if (wasOffline && device.last_seen) {
              await db.collection("occupancy_events").add({
                room_id: device.room_id ?? "",
                device_id: device.id,
                event_type: "sensor_reconnected",
                description: `${device.device_name} reconnected`,
                simulated: false,
                timestamp: nowIso,
              });
            }

            // Explicit sensor disconnection reported via heartbeat: only trigger on transition
            const wasSensorConnected =
              (device as unknown as Record<string, unknown>)["ld2450_connected"] !== false;
            if (
              (body.data.sensor_status === "disconnected" ||
                body.data.ld2450_connected === false) &&
              wasSensorConnected
            ) {
              await db.collection("occupancy_events").add({
                room_id: device.room_id ?? "",
                device_id: device.id,
                event_type: "sensor_disconnected",
                description: `Radar sensor on ${device.device_name} disconnected or silent`,
                simulated: false,
                timestamp: nowIso,
              });
            }
          } catch (err) {
            console.warn("[Heartbeat] Error updating Firestore Admin:", err);
          }
        }

        return json({ ok: true, server_time: nowIso });
      },
    },
  },
});

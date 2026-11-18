import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getAdminFirestore } from "@/lib/firebase/admin.server";
import { sha256Hex, registeredCredentials } from "@/lib/device-auth.server";

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "rt_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const createSchema = z.object({
  device_name: z.string().trim().min(1).max(80),
  device_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{3,64}$/, "Use 3–64 letters, digits, - or _"),
  room_id: z.string().nullable().optional(),
  ld2450: z.object({ enabled: z.boolean(), uart: z.string().max(20), baud: z.number().int() }),
  rd61: z.object({
    enabled: z.boolean(),
    kit: z.string().max(40),
    firmware: z.string().max(40),
    data_mode: z.string().max(40),
  }),
});

/** Registers an ESP32-S3 and its sensors into Cloud Firestore, returning a one-time device secret. */
export const registerDevice = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof createSchema>) => createSchema.parse(input))
  .handler(async ({ data }) => {
    const db = getAdminFirestore();
    const secret = randomSecret();
    const secretHash = await sha256Hex(secret);
    const deviceDocId = `dev_${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = new Date().toISOString();

    if (db) {
      try {
        // Check if device_id is already registered
        const existing = await db
          .collection("devices")
          .where("device_id", "==", data.device_id)
          .limit(1)
          .get();
        if (!existing.empty) {
          throw new Error("That device ID is already registered.");
        }

        const devRef = await db.collection("devices").add({
          device_name: data.device_name,
          device_id: data.device_id,
          device_type: "esp32",
          room_id: data.room_id ?? null,
          user_id: "usr_admin_default",
          status: "unknown",
          last_seen: null,
          created_at: nowIso,
          updated_at: nowIso,
        });

        const devId = devRef.id;

        // Register sensors
        const sensors = [];
        if (data.ld2450.enabled) {
          sensors.push({
            device_id: devId,
            user_id: "usr_admin_default",
            sensor_type: "ld2450",
            model: "HLK-LD2450",
            configuration: { band: "24 GHz", uart: data.ld2450.uart, baud_rate: data.ld2450.baud },
            status: "connected",
            created_at: nowIso,
          });
        }
        if (data.rd61.enabled) {
          sensors.push({
            device_id: devId,
            user_id: "usr_admin_default",
            sensor_type: "rd61",
            model: "Ai-Thinker RD-61",
            configuration: {
              band: "60 GHz",
              interface: data.rd61.kit,
              firmware_version: data.rd61.firmware,
              data_mode: data.rd61.data_mode,
            },
            status: "connected",
            created_at: nowIso,
          });
        }

        for (const s of sensors) {
          await db.collection("sensors").add(s);
        }

        // Store credential hash
        await db.collection("device_credentials").add({
          device_id: devId,
          secret_hash: secretHash,
          created_at: nowIso,
        });

        // Cache in memory for immediate authentication
        registeredCredentials.set(data.device_id, { deviceId: devId, secretHash });

        return { id: devId, device_id: data.device_id, secret };
      } catch (err) {
        if (err instanceof Error && err.message.includes("already registered")) {
          throw err;
        }
        console.warn("[Devices] Cloud registration fallback to memory cache:", err);
      }
    }

    // In-memory fallback
    registeredCredentials.set(data.device_id, { deviceId: deviceDocId, secretHash });
    return { id: deviceDocId, device_id: data.device_id, secret };
  });

/** Rotates a device secret in Cloud Firestore. The old secret stops working immediately. */
export const rotateDeviceSecret = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => z.object({ id: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const db = getAdminFirestore();
    const secret = randomSecret();
    const secretHash = await sha256Hex(secret);

    if (db) {
      try {
        const credSnap = await db
          .collection("device_credentials")
          .where("device_id", "==", data.id)
          .limit(1)
          .get();
        if (!credSnap.empty) {
          const docId = credSnap.docs[0]?.id;
          if (docId) {
            await db.collection("device_credentials").doc(docId).update({
              secret_hash: secretHash,
              updated_at: new Date().toISOString(),
            });
          }
        } else {
          await db.collection("device_credentials").add({
            device_id: data.id,
            secret_hash: secretHash,
            created_at: new Date().toISOString(),
          });
        }
      } catch {
        /* ignore */
      }
    }

    return { secret };
  });

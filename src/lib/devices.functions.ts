import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getAdminFirestore, verifyUserToken } from "@/lib/firebase/admin.server";
import { invalidateDeviceAuthCache, sha256Hex } from "@/lib/device-auth.server";

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "rt_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Every call proves who the caller is with their Firebase ID token; the device is owned by that uid. */
async function requireUid(idToken: string): Promise<string> {
  const user = await verifyUserToken(idToken);
  if (!user) throw new Error("You must be signed in to manage devices.");
  return user.uid;
}

function requireDb() {
  const db = getAdminFirestore();
  if (!db) {
    throw new Error("Server is not configured: FIREBASE_SERVICE_ACCOUNT_KEY is missing.");
  }
  return db;
}

const createSchema = z.object({
  id_token: z.string().min(10).max(4096),
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

/** Registers an ESP32-S3 and its sensors for the signed-in user, returning a one-time device secret. */
export const registerDevice = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof createSchema>) => createSchema.parse(input))
  .handler(async ({ data }) => {
    const uid = await requireUid(data.id_token);
    const db = requireDb();
    const secret = randomSecret();
    const secretHash = await sha256Hex(secret);
    const nowIso = new Date().toISOString();

    // The room, if any, must belong to the caller.
    if (data.room_id) {
      const room = await db.collection("rooms").doc(data.room_id).get();
      if (!room.exists || room.data()?.["user_id"] !== uid) {
        throw new Error("That room does not exist or is not yours.");
      }
    }

    const existing = await db
      .collection("devices")
      .where("device_id", "==", data.device_id)
      .limit(1)
      .get();
    if (!existing.empty) throw new Error("That device ID is already registered.");

    const devRef = await db.collection("devices").add({
      device_name: data.device_name,
      device_id: data.device_id,
      device_type: "esp32",
      room_id: data.room_id ?? null,
      user_id: uid,
      status: "unknown",
      last_seen: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const devId = devRef.id;

    // Sensors start as "unknown": a sensor is only reported connected once the device says so.
    if (data.ld2450.enabled) {
      await db.collection("sensors").add({
        device_id: devId,
        user_id: uid,
        sensor_type: "ld2450",
        model: "HLK-LD2450",
        configuration: { band: "24 GHz", uart: data.ld2450.uart, baud_rate: data.ld2450.baud },
        status: "unknown",
        created_at: nowIso,
      });
    }
    if (data.rd61.enabled) {
      await db.collection("sensors").add({
        device_id: devId,
        user_id: uid,
        sensor_type: "rd61",
        model: "Ai-Thinker RD-61",
        configuration: {
          band: "60 GHz",
          interface: data.rd61.kit,
          firmware_version: data.rd61.firmware,
          data_mode: data.rd61.data_mode,
        },
        status: "unknown",
        created_at: nowIso,
      });
    }

    await db.collection("device_credentials").add({
      device_id: devId,
      secret_hash: secretHash,
      created_at: nowIso,
    });

    return { id: devId, device_id: data.device_id, secret };
  });

const rotateSchema = z.object({ id_token: z.string().min(10).max(4096), id: z.string().min(1) });

/** Rotates a device secret. Only the device's owner can do this; the old secret stops working at once. */
export const rotateDeviceSecret = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof rotateSchema>) => rotateSchema.parse(input))
  .handler(async ({ data }) => {
    const uid = await requireUid(data.id_token);
    const db = requireDb();

    const dev = await db.collection("devices").doc(data.id).get();
    if (!dev.exists || dev.data()?.["user_id"] !== uid) {
      throw new Error("That device does not exist or is not yours.");
    }

    const secret = randomSecret();
    const secretHash = await sha256Hex(secret);
    const nowIso = new Date().toISOString();

    const credSnap = await db
      .collection("device_credentials")
      .where("device_id", "==", data.id)
      .limit(1)
      .get();
    const credDoc = credSnap.docs[0];
    if (credDoc) {
      await credDoc.ref.update({ secret_hash: secretHash, updated_at: nowIso });
    } else {
      await db
        .collection("device_credentials")
        .add({ device_id: data.id, secret_hash: secretHash, created_at: nowIso });
    }
    invalidateDeviceAuthCache(); // the old secret must stop working immediately
    return { secret };
  });

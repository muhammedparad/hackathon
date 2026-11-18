// Server-only helpers for device ingest routes and authentication.
import { getAdminFirestore } from "@/lib/firebase/admin.server";

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// In-memory rate limiting per device (e.g. 25 requests/second)
const rateLimits = new Map<string, { count: number; resetAt: number }>();

export function _resetRateLimits(): void {
  rateLimits.clear();
}

export function checkDeviceRateLimit(deviceId: string, maxRequests = 25, windowMs = 1000): boolean {
  const now = Date.now();
  const item = rateLimits.get(deviceId);
  if (!item || now > item.resetAt) {
    rateLimits.set(deviceId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (item.count >= maxRequests) {
    return false;
  }
  item.count++;
  return true;
}

/**
 * Demo/dev shortcuts (built-in demo devices, in-memory credential fallback) are OFF by default.
 * They turn on only under the test runner or when ROOMTRACE_ALLOW_DEMO_DEVICES=true is set explicitly.
 * Production (e.g. Render) must never set it: otherwise a public demo key could authenticate as a device.
 */
export function demoDevicesEnabled(): boolean {
  return Boolean(process.env["VITEST"]) || process.env["ROOMTRACE_ALLOW_DEMO_DEVICES"] === "true";
}

// In-memory store for registered device credentials (used only when Firestore Admin is not configured)
export const registeredCredentials = new Map<string, { deviceId: string; secretHash: string }>();

export interface AuthenticatedDevice {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  room_id: string | null;
  status: string;
  last_seen: string | null;
}

/** Authenticates an ESP32 via X-Device-Id + X-Device-Key headers using Cloud Firestore / Admin SDK. */
export async function authenticateDevice(request: Request) {
  const deviceId = request.headers.get("x-device-id");
  const key = request.headers.get("x-device-key");
  if (!deviceId || !key) {
    return { error: json({ error: "Missing device credentials" }, 401) } as const;
  }

  // Rate limiting check
  if (!checkDeviceRateLimit(deviceId)) {
    return {
      error: json({ error: "Too many requests. Please throttle telemetry rate." }, 429),
    } as const;
  }

  const keyHash = await sha256Hex(key);
  const db = getAdminFirestore();

  if (db) {
    try {
      const devSnap = await db
        .collection("devices")
        .where("device_id", "==", deviceId)
        .limit(1)
        .get();

      if (!devSnap.empty) {
        const docSnap = devSnap.docs[0];
        if (docSnap) {
          const dev = { id: docSnap.id, ...docSnap.data() } as AuthenticatedDevice;

          // Check credentials collection
          const credSnap = await db
            .collection("device_credentials")
            .where("device_id", "==", dev.id)
            .limit(1)
            .get();

          if (!credSnap.empty) {
            const credData = credSnap.docs[0]?.data();
            const secretHash = credData
              ? (credData["secret_hash"] as string | undefined)
              : undefined;
            if (secretHash && timingSafeEqual(secretHash, keyHash)) {
              return { device: dev } as const;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[Device Auth] Firestore lookup failed:", err);
    }
  }

  // In-memory credential cache: only when Firestore Admin is not configured (local dev) or demo mode is on.
  // With Firestore configured, a lookup failure must NOT fall back to a memory cache.
  const cached = !db || demoDevicesEnabled() ? registeredCredentials.get(deviceId) : undefined;
  if (cached && timingSafeEqual(cached.secretHash, keyHash)) {
    const dev: AuthenticatedDevice = {
      id: cached.deviceId,
      user_id: "usr_admin_default",
      device_id: deviceId,
      device_name: deviceId,
      room_id: null,
      status: "connected",
      last_seen: new Date().toISOString(),
    };
    return { device: dev } as const;
  }

  // Allow standard demo lab device for testing (demo mode only)
  if (demoDevicesEnabled() && deviceId === "esp32-lab-01" && key === "rt_demo_secret_key_12345") {
    const dev: AuthenticatedDevice = {
      id: "d1a1b1c1-1111-2222-3333-444455556666",
      user_id: "usr_admin_default",
      device_id: "esp32-lab-01",
      device_name: "Lab Radar Hub",
      room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
      status: "connected",
      last_seen: new Date().toISOString(),
    };
    return { device: dev } as const;
  }

  // Revoked demo device for 403 Forbidden testing (demo mode only)
  if (
    demoDevicesEnabled() &&
    deviceId === "esp32-revoked-01" &&
    key === "rt_demo_secret_key_12345"
  ) {
    return { error: json({ error: "Device access revoked or disabled" }, 403) } as const;
  }

  return { error: json({ error: "Invalid device credentials" }, 401) } as const;
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

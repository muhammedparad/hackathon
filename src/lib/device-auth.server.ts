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

export interface AuthenticatedDevice {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  room_id: string | null;
  status: string;
  last_seen: string | null;
}

/* ---------- Short-lived cache of verified devices ----------
 * Without it every frame costs two Firestore reads (device + credential) BEFORE the frame can be published
 * live, which adds hundreds of milliseconds per frame and burns the read quota. A verified device is
 * remembered for a few seconds, keyed by id + hash of the key, so a wrong key can never hit the cache.
 * Rotating a secret clears it at once; other changes (room assignment, deletion) apply within the TTL.
 */
export const DEVICE_AUTH_CACHE_TTL_MS = 15_000;
const authCache = new Map<string, { device: AuthenticatedDevice; expires: number }>();

export function invalidateDeviceAuthCache(): void {
  authCache.clear();
}

/* ---------- Test-only device registry ----------
 * Consulted ONLY under the test runner (VITEST). In production it is never read, so no device can
 * authenticate except one registered in Firestore. Tests fill it through _registerTestDevice.
 */
interface TestDevice {
  device: AuthenticatedDevice;
  secretHash: string;
  revoked: boolean;
}
const testDevices = new Map<string, TestDevice>();
const inTestRunner = () => Boolean(process.env["VITEST"]);

export async function _registerTestDevice(
  device: AuthenticatedDevice,
  secret: string,
  opts: { revoked?: boolean } = {},
): Promise<void> {
  testDevices.set(device.device_id, {
    device,
    secretHash: await sha256Hex(secret),
    revoked: opts.revoked ?? false,
  });
}

export function _clearTestDevices(): void {
  testDevices.clear();
}

/** Authenticates an ESP32 via X-Device-Id + X-Device-Key headers against Firestore (Admin SDK). */
export async function authenticateDevice(request: Request) {
  return authenticateCredentials(
    request.headers.get("x-device-id"),
    request.headers.get("x-device-key"),
  );
}

/** Same check for any transport: HTTP headers, or the first message on the device WebSocket. */
export async function authenticateCredentials(deviceId: string | null, key: string | null) {
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

  if (inTestRunner()) {
    const t = testDevices.get(deviceId);
    if (t) {
      if (!timingSafeEqual(t.secretHash, keyHash)) {
        return { error: json({ error: "Invalid device credentials" }, 401) } as const;
      }
      if (t.revoked) {
        return { error: json({ error: "Device access revoked or disabled" }, 403) } as const;
      }
      return { device: { ...t.device, last_seen: new Date().toISOString() } } as const;
    }
  }

  const cacheKey = `${deviceId}:${keyHash}`;
  const hit = authCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return { device: { ...hit.device } } as const;
  authCache.delete(cacheKey);

  const db = getAdminFirestore();
  if (!db) {
    // Production without Firebase Admin credentials cannot verify any device: say so clearly.
    return inTestRunner()
      ? ({ error: json({ error: "Invalid device credentials" }, 401) } as const)
      : ({
          error: json(
            { error: "Server is not configured: FIREBASE_SERVICE_ACCOUNT_KEY is missing" },
            503,
          ),
        } as const);
  }

  try {
    const devSnap = await db
      .collection("devices")
      .where("device_id", "==", deviceId)
      .limit(1)
      .get();
    const docSnap = devSnap.docs[0];
    if (docSnap) {
      const dev = { id: docSnap.id, ...docSnap.data() } as AuthenticatedDevice;
      const credSnap = await db
        .collection("device_credentials")
        .where("device_id", "==", dev.id)
        .limit(1)
        .get();
      const secretHash = credSnap.docs[0]?.data()?.["secret_hash"] as string | undefined;
      if (secretHash && timingSafeEqual(secretHash, keyHash)) {
        authCache.set(cacheKey, { device: dev, expires: Date.now() + DEVICE_AUTH_CACHE_TTL_MS });
        return { device: dev } as const;
      }
    }
  } catch (err) {
    console.warn("[Device Auth] Firestore lookup failed:", err);
    return { error: json({ error: "Device lookup failed" }, 503) } as const;
  }

  return { error: json({ error: "Invalid device credentials" }, 401) } as const;
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

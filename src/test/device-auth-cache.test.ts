import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_AUTH_CACHE_TTL_MS,
  _resetRateLimits,
  authenticateDevice,
  invalidateDeviceAuthCache,
  sha256Hex,
} from "@/lib/device-auth.server";
import { fakeDb } from "./fake-firestore";

// Production path: the device is looked up in Firestore (the in-memory fake here).
vi.mock("@/lib/firebase/admin.server", async () => {
  const { fakeDb: db } = await import("./fake-firestore");
  return {
    getAdminFirestore: () => db,
    getAdminAuth: () => null,
    hasServiceAccount: () => true,
    verifyUserToken: async () => null,
  };
});

const SECRET = "rt_cache_test_secret";

function req(key: string) {
  return new Request("http://localhost/api/public/device/telemetry", {
    method: "POST",
    headers: { "x-device-id": "cache-dev", "x-device-key": key },
  });
}

describe("device auth cache (avoids two Firestore reads per frame)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    fakeDb.reset();
    _resetRateLimits();
    invalidateDeviceAuthCache();
    fakeDb.seed("devices", "doc1", {
      device_id: "cache-dev",
      user_id: "u1",
      device_name: "Cache device",
      room_id: "r1",
      status: "connected",
      last_seen: null,
    });
    fakeDb.seed("device_credentials", "c1", {
      device_id: "doc1",
      secret_hash: await sha256Hex(SECRET),
    });
    // Run the production lookup path, not the test-runner shortcut for fixture devices.
    vi.stubEnv("VITEST", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const lookups = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.length;

  it("hits Firestore once, then serves repeated frames from the cache", async () => {
    const spy = vi.spyOn(fakeDb, "collection");
    const first = await authenticateDevice(req(SECRET));
    expect("device" in first).toBe(true);
    const afterFirst = lookups(spy);
    expect(afterFirst).toBe(2); // devices + device_credentials

    for (let i = 0; i < 5; i++) {
      const again = await authenticateDevice(req(SECRET));
      expect("device" in again && again.device.user_id).toBe("u1");
      _resetRateLimits();
    }
    expect(lookups(spy)).toBe(afterFirst); // no further reads
  });

  it("a wrong key never benefits from a cached good one", async () => {
    await authenticateDevice(req(SECRET));
    const bad = await authenticateDevice(req("rt_wrong"));
    expect("error" in bad && bad.error.status).toBe(401);
  });

  it("looks the device up again after the TTL, so changes take effect", async () => {
    await authenticateDevice(req(SECRET));
    fakeDb.seed("devices", "doc1", {
      device_id: "cache-dev",
      user_id: "u1",
      device_name: "Cache device",
      room_id: "r2", // moved to another room
      status: "connected",
      last_seen: null,
    });
    vi.advanceTimersByTime(DEVICE_AUTH_CACHE_TTL_MS + 1000);
    const next = await authenticateDevice(req(SECRET));
    expect("device" in next && next.device.room_id).toBe("r2");
  });

  it("invalidating the cache (secret rotation) forces a fresh check right away", async () => {
    await authenticateDevice(req(SECRET));
    // the secret is rotated: the stored hash changes
    fakeDb.seed("device_credentials", "c1", {
      device_id: "doc1",
      secret_hash: await sha256Hex("rt_new_secret"),
    });
    invalidateDeviceAuthCache();
    const old = await authenticateDevice(req(SECRET));
    expect("error" in old && old.error.status).toBe(401);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetRateLimits, authenticateDevice } from "@/lib/device-auth.server";
import { REVOKED_TEST_DEVICE, TEST_DEVICE, registerFixtureDevices } from "./device-fixtures";

function req(id?: string, key?: string) {
  const headers: Record<string, string> = {};
  if (id) headers["x-device-id"] = id;
  if (key) headers["x-device-key"] = key;
  return new Request("http://localhost/api/public/device/telemetry", { method: "POST", headers });
}

describe("device authentication (no demo or built-in devices)", () => {
  beforeEach(async () => {
    _resetRateLimits();
    await registerFixtureDevices();
  });

  it("accepts a registered device with the right key", async () => {
    const r = await authenticateDevice(req(TEST_DEVICE.device_id, TEST_DEVICE.secret));
    expect("device" in r).toBe(true);
    if ("device" in r) expect(r.device.user_id).toBe(TEST_DEVICE.user_id);
  });

  it("rejects the right device with a wrong key (401)", async () => {
    const r = await authenticateDevice(req(TEST_DEVICE.device_id, "wrong"));
    expect("error" in r && r.error.status).toBe(401);
  });

  it("rejects an unknown device (401)", async () => {
    const r = await authenticateDevice(req("not-registered", "whatever"));
    expect("error" in r && r.error.status).toBe(401);
  });

  it("refuses a revoked device with 403", async () => {
    const r = await authenticateDevice(req(REVOKED_TEST_DEVICE.device_id, TEST_DEVICE.secret));
    expect("error" in r && r.error.status).toBe(403);
  });

  it("rejects missing credentials (401)", async () => {
    const r = await authenticateDevice(req());
    expect("error" in r && r.error.status).toBe(401);
  });

  describe("production behaviour (outside the test runner)", () => {
    const savedVitest = process.env["VITEST"];
    beforeEach(() => {
      delete process.env["VITEST"];
    });
    afterEach(() => {
      if (savedVitest === undefined) delete process.env["VITEST"];
      else process.env["VITEST"] = savedVitest;
    });

    it("never accepts the old demo key or any test fixture", async () => {
      const demo = await authenticateDevice(req("esp32-lab-01", "rt_demo_secret_key_12345"));
      const fixture = await authenticateDevice(req(TEST_DEVICE.device_id, TEST_DEVICE.secret));
      expect("device" in demo).toBe(false);
      expect("device" in fixture).toBe(false);
    });

    it("says the server is not configured when Firebase Admin credentials are missing (503)", async () => {
      const r = await authenticateDevice(req("any-device", "any-key"));
      expect("error" in r && r.error.status).toBe(503);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetRateLimits, authenticateDevice, demoDevicesEnabled } from "@/lib/device-auth.server";

const DEMO_ID = "esp32-lab-01";
const DEMO_KEY = "rt_demo_secret_key_12345";

function req(id: string, key: string) {
  return new Request("http://localhost/api/public/device/telemetry", {
    method: "POST",
    headers: { "x-device-id": id, "x-device-key": key },
  });
}

describe("demo device gate (production safety)", () => {
  const saved = {
    vitest: process.env["VITEST"],
    allow: process.env["ROOMTRACE_ALLOW_DEMO_DEVICES"],
  };

  beforeEach(() => {
    _resetRateLimits();
    delete process.env["VITEST"];
    delete process.env["ROOMTRACE_ALLOW_DEMO_DEVICES"];
  });

  afterEach(() => {
    if (saved.vitest === undefined) delete process.env["VITEST"];
    else process.env["VITEST"] = saved.vitest;
    if (saved.allow === undefined) delete process.env["ROOMTRACE_ALLOW_DEMO_DEVICES"];
    else process.env["ROOMTRACE_ALLOW_DEMO_DEVICES"] = saved.allow;
  });

  it("is off by default outside the test runner", () => {
    expect(demoDevicesEnabled()).toBe(false);
  });

  it("rejects the built-in demo device key when demo mode is off", async () => {
    const result = await authenticateDevice(req(DEMO_ID, DEMO_KEY));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  it("does not reveal the revoked demo device either", async () => {
    const result = await authenticateDevice(req("esp32-revoked-01", DEMO_KEY));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  it("accepts the demo device only when explicitly enabled", async () => {
    process.env["ROOMTRACE_ALLOW_DEMO_DEVICES"] = "true";
    expect(demoDevicesEnabled()).toBe(true);
    const result = await authenticateDevice(req(DEMO_ID, DEMO_KEY));
    expect("device" in result).toBe(true);
  });

  it("rejects missing credentials with 401", async () => {
    const result = await authenticateDevice(
      new Request("http://localhost/api/public/device/telemetry", { method: "POST" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });
});

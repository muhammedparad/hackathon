// Test-only devices. They exist only inside the test runner (the registry is never read in production).
import { _clearTestDevices, _registerTestDevice } from "@/lib/device-auth.server";

export const TEST_DEVICE = {
  device_id: "esp32-lab-01",
  secret: "rt_test_device_key",
  doc_id: "d1a1b1c1-1111-2222-3333-444455556666",
  user_id: "usr_test_owner",
  room_id: "e4a7a8d0-4491-4e78-9584-c817215c0e01",
} as const;

export const REVOKED_TEST_DEVICE = { device_id: "esp32-revoked-01" } as const;

export async function registerFixtureDevices(): Promise<void> {
  _clearTestDevices();
  await _registerTestDevice(
    {
      id: TEST_DEVICE.doc_id,
      user_id: TEST_DEVICE.user_id,
      device_id: TEST_DEVICE.device_id,
      device_name: "Test Radar Hub",
      room_id: TEST_DEVICE.room_id,
      status: "connected",
      last_seen: null,
    },
    TEST_DEVICE.secret,
  );
  await _registerTestDevice(
    {
      id: "d2b2c2d2-aaaa-bbbb-cccc-ddddeeeeffff",
      user_id: TEST_DEVICE.user_id,
      device_id: REVOKED_TEST_DEVICE.device_id,
      device_name: "Revoked Test Hub",
      room_id: null,
      status: "disabled",
      last_seen: null,
    },
    TEST_DEVICE.secret,
    { revoked: true },
  );
}

/**
 * RoomTrace — Mock ESP32-S3 Hardware Simulation Script (Phase 5)
 *
 * Simulates a physical ESP32-S3 microcontroller equipped with an HLK-LD2450
 * radar streaming live telemetry and periodic heartbeats over HTTPS
 * to the RoomTrace edge ingestion API.
 *
 * Simulates the full pipeline:
 * Raw Sensor Bytes (30B) -> LD2450 Parser -> Normalized JSON -> Authenticated API -> Firestore
 *
 * Usage:
 *   bun scripts/mock-esp32.ts
 */

import { serializeLD2450Frame, parseLD2450Frame } from "../src/lib/radar/ld2450-parser";

const BASE_URL = process.env.ROOMTRACE_API_URL || "http://localhost:8080";
const DEVICE_ID = process.env.ROOMTRACE_DEVICE_ID || "esp32-lab-01";
const DEVICE_KEY = process.env.ROOMTRACE_DEVICE_KEY || "rt_demo_secret_key_12345";

console.log("=============================================================");
console.log("RoomTrace — ESP32-S3 Hardware & Sensor Emulation Pipeline");
console.log(`Target Host:  ${BASE_URL}`);
console.log(`Device ID:    ${DEVICE_ID}`);
console.log(`Radar Model:  Hi-Link HLK-LD2450 (24 GHz UART @ 256k baud)`);
console.log("=============================================================\n");

async function sendHeartbeat() {
  try {
    const res = await fetch(`${BASE_URL}/api/public/device/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": DEVICE_ID,
        "X-Device-Key": DEVICE_KEY,
      },
      body: JSON.stringify({
        firmware_version: "1.0.0-phase5",
        ip_address: "192.168.1.150",
      }),
    });
    const data = await res.json();
    console.log(`[HEARTBEAT] HTTP ${res.status} | Server Time:`, data.server_time ?? data);
  } catch (err) {
    console.error("[HEARTBEAT] Connection failed:", err instanceof Error ? err.message : err);
  }
}

async function sendParsedTelemetry(
  targets: Array<{ target_id: number; x_mm: number; y_mm: number; speed_cms: number }>,
) {
  // 1. Simulate physical UART generation of 30-byte binary frame
  const rawBinaryFrame = serializeLD2450Frame(targets);

  // 2. Simulate ESP32-S3 firmware parsing of binary stream
  const parsed = parseLD2450Frame(rawBinaryFrame);
  if (!parsed) {
    console.error("[EMULATOR] Framing error in local simulation");
    return;
  }

  // 3. Transmit authenticated HTTPS payload
  try {
    const res = await fetch(`${BASE_URL}/api/public/device/telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": DEVICE_ID,
        "X-Device-Key": DEVICE_KEY,
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        data: {
          sensor_type: "ld2450",
          targets: parsed.targets,
        },
      }),
    });
    const data = await res.json();
    const tStr = parsed.targets
      .map((t) => `#${t.target_id} (${t.x_mm}, ${t.y_mm})mm @ ${t.speed_cms}cm/s`)
      .join(" | ");

    console.log(
      `[TELEMETRY] ${rawBinaryFrame.length}B UART -> HTTP ${res.status} | Targets: ${tStr}`,
    );
    if (data.duplicate) {
      console.log("   └── [DEDUP] Duplicate frame skipped by server");
    }
  } catch (err) {
    console.error("[TELEMETRY] Ingest request error:", err instanceof Error ? err.message : err);
  }
}

async function runDemo() {
  console.log("1. Sending Initial Hardware Heartbeat...");
  await sendHeartbeat();

  console.log(
    "\n2. Streaming simulated physical radar trajectory (Single target entering room)...",
  );
  const trajectory1 = [
    [{ target_id: 1, x_mm: -600, y_mm: 1200, speed_cms: 20 }],
    [{ target_id: 1, x_mm: -400, y_mm: 1600, speed_cms: 25 }],
    [{ target_id: 1, x_mm: -200, y_mm: 2000, speed_cms: 20 }],
    [{ target_id: 1, x_mm: 0, y_mm: 2400, speed_cms: 15 }],
    [{ target_id: 1, x_mm: 200, y_mm: 2700, speed_cms: 10 }],
  ];

  for (const frame of trajectory1) {
    await sendParsedTelemetry(frame);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("\n3. Streaming multi-target kinematics (2 simultaneous targets)...");
  const multiTargets = [
    [
      { target_id: 1, x_mm: 250, y_mm: 2800, speed_cms: 0 },
      { target_id: 2, x_mm: -1200, y_mm: 1500, speed_cms: 30 },
    ],
    [
      { target_id: 1, x_mm: 250, y_mm: 2800, speed_cms: 0 },
      { target_id: 2, x_mm: -900, y_mm: 1900, speed_cms: 25 },
    ],
  ];

  for (const frame of multiTargets) {
    await sendParsedTelemetry(frame);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("\n=============================================================");
  console.log("Mock ESP32-S3 test completed successfully!");
  console.log("=============================================================");
}

void runDemo();

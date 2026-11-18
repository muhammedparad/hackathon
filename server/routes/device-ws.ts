// Device WebSocket endpoint (Nitro route, Node server only). Path: DEVICE_WS_PATH = "/device-ws".
// The ESP32 keeps one connection open, authenticates once with its device id and key, then streams
// telemetry and heartbeats. Frames reach the owner's browsers immediately; storage follows in a queue.
// The HTTPS POST endpoints stay available, and the firmware falls back to them if this socket is down.
import { defineWebSocketHandler } from "nitro";
import { authenticateCredentials } from "../../src/lib/device-auth.server";
import {
  processHeartbeat,
  processTelemetry,
  publishTelemetryOnReceipt,
} from "../../src/lib/device-ingest.server";
import { createDeviceSession, type DeviceSession } from "../../src/lib/live/device-session.server";

const sessions = new Map<string, DeviceSession>();

export default defineWebSocketHandler({
  open(peer) {
    sessions.set(
      peer.id,
      createDeviceSession(
        {
          id: peer.id,
          send: (data) => peer.send(data),
          close: (code, reason) => peer.close(code, reason),
        },
        {
          authenticate: (deviceId, key) => authenticateCredentials(deviceId, key),
          publishTelemetry: publishTelemetryOnReceipt,
          storeTelemetry: (device, payload, receivedAtMs) =>
            processTelemetry(device, payload, { publish: false, receivedAtMs }),
          analyzeTelemetry: (device, payload, receivedAtMs) =>
            processTelemetry(device, payload, { publish: false, receivedAtMs, storeRaw: false }),
          handleHeartbeat: (device, body) => processHeartbeat(device, body),
        },
      ),
    );
  },
  async message(peer, message) {
    await sessions.get(peer.id)?.onMessage(message.text());
  },
  close(peer) {
    sessions.get(peer.id)?.onClose();
    sessions.delete(peer.id);
  },
  error(peer, error) {
    console.warn("[Device WS] socket error:", peer.id, error);
  },
});

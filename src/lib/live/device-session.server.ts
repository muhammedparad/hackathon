// Per-connection logic of the DEVICE WebSocket (ESP32 -> server), independent of the WebSocket library.
//
// Protocol (JSON text frames):
//   device -> server  {type:"auth", device_id, key}          first message, within 10 s
//                     {type:"telemetry", ...telemetry body}   same body as POST /api/public/device/telemetry
//                     {type:"heartbeat", ...heartbeat body}   same body as POST /api/public/device/heartbeat
//                     {type:"ping"}
//   server -> device  {type:"ready", device_id}   {type:"pong"}   {type:"ack", kind:"heartbeat"}
//                     {type:"error", code, message}
//
// A frame is pushed to the owner's browsers the moment it arrives. Storing it (Firestore) happens in a
// per-device queue afterwards, so a slow database never delays the live view and frames are stored in order.
import { heartbeatBodySchema, telemetryBodySchema } from "@/lib/radar/types";
import type { HeartbeatBody, TelemetryBody } from "@/lib/radar/types";
import type { AuthenticatedDevice } from "@/lib/device-auth.server";

export const DEVICE_AUTH_TIMEOUT_MS = 10_000;
export const MAX_DEVICE_MESSAGE_BYTES = 32 * 1024;
/** Credentials are re-checked this often, so a rotated or deleted device is cut off. */
export const DEVICE_RECHECK_MS = 60_000;
/** Storage tasks allowed to wait per device; beyond that the oldest waiting ones are dropped (live push is unaffected). */
export const MAX_STORAGE_BACKLOG = 20;
/**
 * The live view gets every frame. History is stored at most this often per device (unless something changed:
 * target count or sensor status), so a fast device does not burn through Firestore write quota.
 */
export const STORE_MIN_INTERVAL_MS = 1000;

export type DeviceClientMessage =
  | { type: "auth"; device_id: string; key: string }
  | ({ type: "telemetry" } & Record<string, unknown>)
  | ({ type: "heartbeat" } & Record<string, unknown>)
  | { type: "ping" };

export type DeviceServerMessage =
  | { type: "ready"; device_id: string }
  | { type: "pong" }
  | { type: "ack"; kind: "heartbeat" }
  | {
      type: "error";
      code: "unauthorized" | "bad_message" | "auth_required" | "rate_limited" | "unavailable";
      message: string;
    };

export interface DeviceSocket {
  id: string;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export type DeviceAuthResult = { device: AuthenticatedDevice } | { error: Response };

export interface DeviceSessionDeps {
  authenticate(deviceId: string, key: string): Promise<DeviceAuthResult>;
  /** Live push the instant a frame arrives. */
  publishTelemetry(device: AuthenticatedDevice, payload: TelemetryBody, receivedAtMs: number): void;
  /** Storage, alerts, trajectories. Called one at a time per device, in arrival order. */
  storeTelemetry(
    device: AuthenticatedDevice,
    payload: TelemetryBody,
    receivedAtMs: number,
  ): Promise<unknown>;
  /** Frames that are NOT stored (throttled) still get analysed: alerts, tracks, occupancy. Optional. */
  analyzeTelemetry?(
    device: AuthenticatedDevice,
    payload: TelemetryBody,
    receivedAtMs: number,
  ): Promise<unknown>;
  /** Heartbeat processing, including the live "device seen" push. */
  handleHeartbeat(device: AuthenticatedDevice, body: HeartbeatBody): Promise<unknown>;
  authTimeoutMs?: number;
  recheckMs?: number;
  maxBacklog?: number;
  /** Minimum gap between stored frames (default STORE_MIN_INTERVAL_MS). 0 stores every frame. */
  storeIntervalMs?: number;
  now?: () => number;
}

export interface DeviceSession {
  onMessage(raw: string): Promise<void>;
  onClose(): void;
  readonly deviceId: string | null;
  /** Resolves when everything queued for storage has finished (tests, shutdown). */
  idle(): Promise<void>;
}

/** What counts as "something changed" for storage: sensor, its status and how many targets are in view. */
function frameShape(payload: TelemetryBody): string {
  const d = payload.data;
  if (d.sensor_type === "ld2450")
    return `ld2450|${d.sensor_status ?? "online"}|${d.targets.length}`;
  return `${d.sensor_type}|${d.sensor_status ?? "online"}`;
}

export function createDeviceSession(socket: DeviceSocket, deps: DeviceSessionDeps): DeviceSession {
  const now = deps.now ?? Date.now;
  const recheckMs = deps.recheckMs ?? DEVICE_RECHECK_MS;
  const maxBacklog = deps.maxBacklog ?? MAX_STORAGE_BACKLOG;
  const storeIntervalMs = deps.storeIntervalMs ?? STORE_MIN_INTERVAL_MS;
  let lastStoredAt = -Infinity;
  let lastStoredShape = "";

  let device: AuthenticatedDevice | null = null;
  let creds: { deviceId: string; key: string } | null = null;
  let checkedAt = 0;
  let authInFlight = false;
  let closed = false;

  const send = (m: DeviceServerMessage) => {
    if (closed) return;
    try {
      socket.send(JSON.stringify(m));
    } catch {
      /* socket already gone */
    }
  };

  const timer = setTimeout(() => {
    if (!device) {
      send({ type: "error", code: "auth_required", message: "Authenticate within 10 seconds" });
      socket.close(4401, "auth timeout");
    }
  }, deps.authTimeoutMs ?? DEVICE_AUTH_TIMEOUT_MS);

  // ---- storage queue: sequential per device, bounded
  const queue: Array<() => Promise<unknown>> = [];
  let running: Promise<void> | null = null;

  const pump = async () => {
    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        await task();
      } catch (err) {
        console.warn("[Device WS] storing a frame failed:", err);
      }
    }
    running = null;
  };

  const enqueue = (task: () => Promise<unknown>) => {
    while (queue.length >= maxBacklog) queue.shift(); // newest data matters most; live push already happened
    queue.push(task);
    running ??= pump();
  };

  const stop = (code: number, reason: string) => {
    closed = true;
    clearTimeout(timer);
    socket.close(code, reason);
  };

  /** Re-verify the stored credentials now and then. Returns false (and closes) if they no longer hold. */
  const stillValid = async (): Promise<boolean> => {
    if (!creds || now() - checkedAt < recheckMs) return true;
    checkedAt = now();
    const result = await deps.authenticate(creds.deviceId, creds.key);
    if ("error" in result) {
      // Rate limiting is not a credentials failure; keep the connection.
      if (result.error.status === 429) return true;
      send({ type: "error", code: "unauthorized", message: "Device credentials no longer valid" });
      stop(4403, "unauthorized");
      return false;
    }
    device = result.device;
    return true;
  };

  return {
    get deviceId() {
      return device?.id ?? null;
    },

    idle: async () => {
      while (running) await running;
    },

    async onMessage(raw: string) {
      if (closed) return;
      const receivedAtMs = now();
      if (raw.length > MAX_DEVICE_MESSAGE_BYTES) {
        send({ type: "error", code: "bad_message", message: "Message too large" });
        stop(1009, "message too large");
        return;
      }

      let msg: DeviceClientMessage;
      try {
        msg = JSON.parse(raw) as DeviceClientMessage;
      } catch {
        send({ type: "error", code: "bad_message", message: "Invalid JSON" });
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        send({ type: "error", code: "bad_message", message: "Missing message type" });
        return;
      }

      if (msg.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (msg.type === "auth") {
        if (device || authInFlight) return;
        if (typeof msg.device_id !== "string" || typeof msg.key !== "string") {
          send({ type: "error", code: "bad_message", message: "device_id and key are required" });
          return;
        }
        authInFlight = true;
        try {
          const result = await deps.authenticate(msg.device_id, msg.key);
          if ("error" in result) {
            send({
              type: "error",
              code: result.error.status === 429 ? "rate_limited" : "unauthorized",
              message: "Invalid device credentials",
            });
            stop(4403, "unauthorized");
            return;
          }
          device = result.device;
          creds = { deviceId: msg.device_id, key: msg.key };
          checkedAt = now();
          clearTimeout(timer);
          send({ type: "ready", device_id: device.device_id });
        } finally {
          authInFlight = false;
        }
        return;
      }

      if (!device) {
        send({ type: "error", code: "auth_required", message: "Send auth first" });
        return;
      }
      if (!(await stillValid())) return;
      const current = device;
      // Any authenticated message proves the device is connected; keeps later heartbeats from re-announcing a reconnect.
      device = { ...current, status: "connected", last_seen: new Date(receivedAtMs).toISOString() };

      if (msg.type === "telemetry") {
        const { type: _t, ...body } = msg;
        const parsed = telemetryBodySchema.safeParse(body);
        if (!parsed.success) {
          send({ type: "error", code: "bad_message", message: "Invalid telemetry payload" });
          return;
        }
        try {
          deps.publishTelemetry(current, parsed.data, receivedAtMs);
        } catch (err) {
          console.warn("[Device WS] live publish failed:", err);
        }
        // Store on change, otherwise at most once per storeIntervalMs.
        const shape = frameShape(parsed.data);
        if (shape !== lastStoredShape || receivedAtMs - lastStoredAt >= storeIntervalMs) {
          lastStoredShape = shape;
          lastStoredAt = receivedAtMs;
          enqueue(() => deps.storeTelemetry(current, parsed.data, receivedAtMs));
        } else if (deps.analyzeTelemetry) {
          const analyze = deps.analyzeTelemetry;
          enqueue(() => analyze(current, parsed.data, receivedAtMs));
        }
        return;
      }

      if (msg.type === "heartbeat") {
        const { type: _t, ...body } = msg;
        const parsed = heartbeatBodySchema.safeParse(body);
        if (!parsed.success) {
          send({ type: "error", code: "bad_message", message: "Invalid heartbeat" });
          return;
        }
        enqueue(() => deps.handleHeartbeat(current, parsed.data));
        send({ type: "ack", kind: "heartbeat" });
        return;
      }

      send({ type: "error", code: "bad_message", message: "Unknown message type" });
    },

    onClose() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

// Shared by the Node server (server/routes/live-ws.ts) and the browser client.
// Keep this file free of server-only imports.

/** Path of the live WebSocket endpoint (a Nitro route; only exists on the always-on Node server). */
export const LIVE_WS_PATH = "/live-ws";

/** One radar target exactly as the device reported it (LD2450). */
export interface LiveTarget {
  target_id: number;
  x_mm: number;
  y_mm: number;
  speed_cms: number;
}

/** Messages the browser sends. */
export type LiveClientMessage = { type: "auth"; token: string } | { type: "ping" };

/** Messages the server sends. */
export type LiveServerMessage =
  | { type: "ready"; uid: string }
  | { type: "pong" }
  | { type: "error"; code: "unauthorized" | "bad_message" | "auth_required"; message: string }
  | {
      type: "frame";
      device_id: string;
      room_id: string | null;
      sensor_type: "ld2450";
      /** Capture time when the device clock was synced, otherwise server arrival time (ISO). */
      timestamp: string;
      received_at: string;
      targets: LiveTarget[];
    }
  | {
      type: "device";
      device_id: string;
      room_id: string | null;
      /** Server time of the last authenticated device call (heartbeat or telemetry). */
      last_seen: string;
      sensor_status?: "online" | "disconnected" | "error";
    };

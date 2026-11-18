// Per-connection logic of the live WebSocket, independent of the WebSocket library so it can be tested.
import type { LiveClientMessage, LiveServerMessage } from "./protocol";
import type { LiveHub } from "./hub.server";
import type { LiveIdentity } from "./auth.server";

export const AUTH_TIMEOUT_MS = 10_000;
export const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024;

export interface LiveSocket {
  id: string;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface LiveSessionDeps {
  hub: LiveHub;
  verifyToken: (token: string) => Promise<LiveIdentity | null>;
  authTimeoutMs?: number;
}

export interface LiveSession {
  onMessage(raw: string): Promise<void>;
  onClose(): void;
  readonly uid: string | null;
}

export function createLiveSession(socket: LiveSocket, deps: LiveSessionDeps): LiveSession {
  let uid: string | null = null;
  let authInFlight = false;

  const send = (m: LiveServerMessage) => {
    try {
      socket.send(JSON.stringify(m));
    } catch {
      /* socket already gone */
    }
  };

  const timer = setTimeout(() => {
    if (!uid) {
      send({ type: "error", code: "auth_required", message: "Authenticate within 10 seconds" });
      socket.close(4401, "auth timeout");
    }
  }, deps.authTimeoutMs ?? AUTH_TIMEOUT_MS);

  return {
    get uid() {
      return uid;
    },

    async onMessage(raw: string) {
      if (raw.length > MAX_CLIENT_MESSAGE_BYTES) {
        send({ type: "error", code: "bad_message", message: "Message too large" });
        socket.close(1009, "message too large");
        return;
      }

      let msg: LiveClientMessage;
      try {
        msg = JSON.parse(raw) as LiveClientMessage;
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
        if (uid || authInFlight) return; // already authenticated (or in progress)
        if (typeof msg.token !== "string") {
          send({ type: "error", code: "bad_message", message: "token must be a string" });
          return;
        }
        authInFlight = true;
        try {
          const identity = await deps.verifyToken(msg.token);
          if (!identity) {
            send({ type: "error", code: "unauthorized", message: "Invalid or expired token" });
            socket.close(4403, "unauthorized");
            return;
          }
          uid = identity.uid;
          clearTimeout(timer);
          deps.hub.add(uid, { id: socket.id, send: (d) => socket.send(d) });
          send({ type: "ready", uid });
        } finally {
          authInFlight = false;
        }
        return;
      }

      send({ type: "error", code: "bad_message", message: `Unknown message type` });
    },

    onClose() {
      clearTimeout(timer);
      deps.hub.remove(socket.id);
    },
  };
}

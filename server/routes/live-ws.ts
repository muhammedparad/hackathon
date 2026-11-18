// Live WebSocket endpoint (Nitro route, Node server only). Path: LIVE_WS_PATH = "/live-ws".
// Browsers connect, send {type:"auth", token:<Firebase ID token>}, then receive frames pushed by the
// device ingest routes via the in-memory hub.
import { defineWebSocketHandler } from "nitro";
import { getLiveHub } from "../../src/lib/live/hub.server";
import { verifyLiveToken } from "../../src/lib/live/auth.server";
import { createLiveSession, type LiveSession } from "../../src/lib/live/session.server";

const sessions = new Map<string, LiveSession>();

export default defineWebSocketHandler({
  open(peer) {
    sessions.set(
      peer.id,
      createLiveSession(
        {
          id: peer.id,
          send: (data) => peer.send(data),
          close: (code, reason) => peer.close(code, reason),
        },
        { hub: getLiveHub(), verifyToken: verifyLiveToken },
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
    console.warn("[Live WS] socket error:", peer.id, error);
  },
});

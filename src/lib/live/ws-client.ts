// Browser client for the live WebSocket: authenticates with the Firebase ID token, reconnects with
// backoff, and hands server messages to the caller. No UI code in here.
import { LIVE_WS_PATH, type LiveClientMessage, type LiveServerMessage } from "./protocol";

export type LiveConnState = "connecting" | "live" | "reconnecting" | "unavailable";

export interface LiveClientOptions {
  /** Returns a fresh Firebase ID token, or null when nobody is signed in. */
  getToken: () => Promise<string | null>;
  onMessage: (message: LiveServerMessage) => void;
  onState?: (state: LiveConnState) => void;
  /** Override for tests. Default: same host as the page, path LIVE_WS_PATH. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

export const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;
/** After this many failed attempts in a row we report "unavailable" (e.g. the dev server has no WebSocket). */
const UNAVAILABLE_AFTER = 4;

export function defaultLiveUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${LIVE_WS_PATH}`;
}

/** Starts the connection. Returns a function that stops it for good. */
export function connectLive(opts: LiveClientOptions): () => void {
  const WS = opts.WebSocketImpl ?? WebSocket;
  let ws: WebSocket | null = null;
  let disposed = false;
  let failures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let state: LiveConnState | null = null;

  const setState = (s: LiveConnState) => {
    if (s !== state) {
      state = s;
      opts.onState?.(s);
    }
  };

  const clearPing = () => {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    failures++;
    setState(failures >= UNAVAILABLE_AFTER ? "unavailable" : "reconnecting");
    const delay =
      Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS) + Math.floor(Math.random() * 300);
    reconnectTimer = setTimeout(open, failures >= UNAVAILABLE_AFTER ? 30_000 : delay);
  };

  const sendMsg = (m: LiveClientMessage) => {
    if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(m));
  };

  function open() {
    if (disposed) return;
    setState(failures === 0 ? "connecting" : (state ?? "reconnecting"));
    let socket: WebSocket;
    try {
      socket = new WS(opts.url ?? defaultLiveUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    let authenticated = false;

    socket.onopen = async () => {
      try {
        const token = await opts.getToken();
        if (!token) {
          socket.close(4000, "no token");
          return;
        }
        if (!disposed && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "auth", token } satisfies LiveClientMessage));
        }
      } catch {
        socket.close(4000, "token error");
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      let msg: LiveServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as LiveServerMessage;
      } catch {
        return;
      }
      if (msg.type === "ready") {
        authenticated = true;
        failures = 0;
        setState("live");
        clearPing();
        pingTimer = setInterval(() => sendMsg({ type: "ping" }), PING_INTERVAL_MS);
      }
      opts.onMessage(msg);
    };

    socket.onclose = () => {
      clearPing();
      if (ws === socket) ws = null;
      if (disposed) return;
      if (!authenticated) {
        scheduleReconnect();
      } else {
        // We had a working session: reconnect quickly, counting from zero.
        failures = 0;
        setState("reconnecting");
        reconnectTimer = setTimeout(open, 1000 + Math.floor(Math.random() * 500));
      }
    };

    socket.onerror = () => {
      /* onclose follows and handles the retry */
    };
  }

  open();

  return () => {
    disposed = true;
    clearPing();
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    const s = ws;
    ws = null;
    try {
      s?.close(1000, "client closed");
    } catch {
      /* ignore */
    }
  };
}

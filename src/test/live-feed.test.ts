import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFixtureDevices } from "./device-fixtures";
import { LiveHub, getLiveHub } from "@/lib/live/hub.server";
import { createLiveSession } from "@/lib/live/session.server";
import { connectLive, type LiveConnState } from "@/lib/live/ws-client";
import type { LiveServerMessage } from "@/lib/live/protocol";
import {
  Route as TelemetryRoute,
  _resetTelemetryCache,
} from "@/routes/api/public/device/telemetry";
import { Route as HeartbeatRoute } from "@/routes/api/public/device/heartbeat";
import { _resetRateLimits } from "@/lib/device-auth.server";

function fakePeer(id: string) {
  const sent: string[] = [];
  return { id, sent, send: (d: string) => void sent.push(d) };
}

function parsed(peer: { sent: string[] }): LiveServerMessage[] {
  return peer.sent.map((s) => JSON.parse(s) as LiveServerMessage);
}

beforeEach(async () => {
  await registerFixtureDevices();
});

describe("LiveHub", () => {
  it("delivers only to peers of the same owner", () => {
    const hub = new LiveHub();
    const a = fakePeer("a");
    const b = fakePeer("b");
    hub.add("u1", a);
    hub.add("u2", b);
    const msg: LiveServerMessage = { type: "pong" };
    expect(hub.publish("u1", msg)).toBe(1);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it("stops delivering after remove and reports zero reached", () => {
    const hub = new LiveHub();
    const a = fakePeer("a");
    hub.add("u1", a);
    hub.remove("a");
    expect(hub.publish("u1", { type: "pong" })).toBe(0);
    expect(hub.size).toBe(0);
    expect(hub.hasSubscribers("u1")).toBe(false);
  });

  it("drops a peer whose send throws and keeps serving the others", () => {
    const hub = new LiveHub();
    const good = fakePeer("good");
    hub.add("u1", {
      id: "bad",
      send: () => {
        throw new Error("socket closed");
      },
    });
    hub.add("u1", good);
    expect(hub.publish("u1", { type: "pong" })).toBe(1);
    expect(hub.size).toBe(1);
    expect(good.sent).toHaveLength(1);
  });

  it("is a process-wide singleton", () => {
    expect(getLiveHub()).toBe(getLiveHub());
  });
});

describe("live session (auth + protocol)", () => {
  const verifyToken = async (t: string) => (t === "good" ? { uid: "u1" } : null);

  function setup(authTimeoutMs?: number) {
    const hub = new LiveHub();
    const sent: LiveServerMessage[] = [];
    const closed: Array<[number | undefined, string | undefined]> = [];
    const session = createLiveSession(
      {
        id: "p1",
        send: (d) => void sent.push(JSON.parse(d) as LiveServerMessage),
        close: (code, reason) => void closed.push([code, reason]),
      },
      { hub, verifyToken, ...(authTimeoutMs ? { authTimeoutMs } : {}) },
    );
    return { hub, sent, closed, session };
  }

  afterEach(() => vi.useRealTimers());

  it("answers ping before authentication", async () => {
    const { sent, session } = setup();
    await session.onMessage(JSON.stringify({ type: "ping" }));
    expect(sent).toEqual([{ type: "pong" }]);
    session.onClose();
  });

  it("does not deliver frames until the token is verified", async () => {
    const { hub, session } = setup();
    expect(hub.publish("u1", { type: "pong" })).toBe(0);
    session.onClose();
  });

  it("subscribes the peer after a valid token and delivers frames", async () => {
    const { hub, sent, session } = setup();
    await session.onMessage(JSON.stringify({ type: "auth", token: "good" }));
    expect(sent[0]).toEqual({ type: "ready", uid: "u1" });
    expect(session.uid).toBe("u1");
    hub.publish("u1", { type: "pong" });
    expect(sent[1]).toEqual({ type: "pong" });
    session.onClose();
    expect(hub.size).toBe(0);
  });

  it("rejects a bad token with unauthorized and closes with 4403", async () => {
    const { hub, sent, closed, session } = setup();
    await session.onMessage(JSON.stringify({ type: "auth", token: "nope" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "unauthorized" });
    expect(closed[0]?.[0]).toBe(4403);
    expect(hub.size).toBe(0);
    session.onClose();
  });

  it("reports invalid JSON without closing", async () => {
    const { sent, closed, session } = setup();
    await session.onMessage("{not json");
    expect(sent[0]).toMatchObject({ type: "error", code: "bad_message" });
    expect(closed).toHaveLength(0);
    session.onClose();
  });

  it("closes on an oversized message", async () => {
    const { closed, session } = setup();
    await session.onMessage("x".repeat(9000));
    expect(closed[0]?.[0]).toBe(1009);
    session.onClose();
  });

  it("closes a connection that never authenticates", async () => {
    vi.useFakeTimers();
    const { sent, closed, session } = setup(50);
    await vi.advanceTimersByTimeAsync(60);
    expect(closed[0]?.[0]).toBe(4401);
    expect(sent[0]).toMatchObject({ type: "error", code: "auth_required" });
    session.onClose();
  });
});

describe("browser live client", () => {
  class FakeWS {
    static instances: FakeWS[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    serverSays(m: LiveServerMessage) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
    serverDrops() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const start = (opts: { token?: string | null } = {}) => {
    const states: LiveConnState[] = [];
    const messages: LiveServerMessage[] = [];
    const stop = connectLive({
      url: "ws://test/live-ws",
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
      getToken: async () => (opts.token === undefined ? "tok" : opts.token),
      onState: (s) => states.push(s),
      onMessage: (m) => messages.push(m),
    });
    return { states, messages, stop };
  };

  it("sends the token, goes live on ready, and forwards frames", async () => {
    const { states, messages, stop } = start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "auth", token: "tok" });
    ws.serverSays({ type: "ready", uid: "u1" });
    ws.serverSays({
      type: "frame",
      device_id: "d1",
      room_id: "r1",
      sensor_type: "ld2450",
      timestamp: "2026-11-18T10:00:00.000Z",
      received_at: "2026-11-18T10:00:00.100Z",
      targets: [{ target_id: 1, x_mm: 10, y_mm: 2000, speed_cms: 0 }],
    });
    expect(states).toContain("live");
    expect(messages.map((m) => m.type)).toEqual(["ready", "frame"]);
    stop();
  });

  it("reconnects after a dropped session", async () => {
    const { states, stop } = start();
    const first = FakeWS.instances[0]!;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    first.serverSays({ type: "ready", uid: "u1" });
    first.serverDrops();
    expect(states.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.instances).toHaveLength(2);
    stop();
  });

  it("reports unavailable after repeated failures to connect", async () => {
    const { states, stop } = start();
    for (let i = 0; i < 5; i++) {
      FakeWS.instances.at(-1)!.serverDrops();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(states).toContain("unavailable");
    stop();
  });

  it("does not reconnect after stop()", async () => {
    const { stop } = start();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("closes without sending anything when nobody is signed in", async () => {
    const { stop } = start({ token: null });
    const ws = FakeWS.instances[0]!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent).toHaveLength(0);
    stop();
  });
});

describe("device ingest publishes to the owner's live socket", () => {
  const DEMO_USER = "usr_test_owner"; // owner of the built-in demo device (test runner only)
  const DEMO_DEVICE_DOC = "d1a1b1c1-1111-2222-3333-444455556666";
  const DEMO_ROOM = "e4a7a8d0-4491-4e78-9584-c817215c0e01";
  const peer = fakePeer("browser-1");

  const post = (route: typeof TelemetryRoute | typeof HeartbeatRoute, body: unknown) => {
    const handlers = route.options.server?.handlers as {
      POST: (a: { request: Request }) => Promise<Response>;
    };
    return handlers.POST({
      request: new Request("http://localhost/api/public/device/x", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "esp32-lab-01",
          "x-device-key": "rt_test_device_key",
        },
        body: JSON.stringify(body),
      }),
    });
  };

  beforeEach(() => {
    _resetTelemetryCache();
    _resetRateLimits();
    peer.sent.length = 0;
    getLiveHub().add(DEMO_USER, peer);
  });
  afterEach(() => getLiveHub().remove(peer.id));

  it("pushes a real LD2450 frame with the device's room and the reported targets", async () => {
    const targets = [
      { target_id: 1, x_mm: -120, y_mm: 1530, speed_cms: 0 },
      { target_id: 2, x_mm: 450, y_mm: 2210, speed_cms: -12 },
    ];
    const res = await post(TelemetryRoute, { data: { sensor_type: "ld2450", targets } });
    expect(res.status).toBe(200);
    const msgs = parsed(peer);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: "frame",
      device_id: DEMO_DEVICE_DOC,
      room_id: DEMO_ROOM,
      sensor_type: "ld2450",
      targets,
    });
  });

  it("does not push a frame when the device reports its sensor as disconnected", async () => {
    await post(TelemetryRoute, {
      data: { sensor_type: "ld2450", sensor_status: "disconnected", targets: [] },
    });
    const msgs = parsed(peer);
    expect(msgs.map((m) => m.type)).toEqual(["device"]);
    expect(msgs[0]).toMatchObject({ sensor_status: "disconnected" });
  });

  it("does not publish invalid payloads", async () => {
    const res = await post(TelemetryRoute, { data: { sensor_type: "ld2450", targets: "nope" } });
    expect(res.status).toBe(400);
    expect(peer.sent).toHaveLength(0);
  });

  it("does not publish RD-61 point clouds yet", async () => {
    await post(TelemetryRoute, {
      data: {
        sensor_type: "rd61",
        points: [{ x_mm: 100, y_mm: 200, z_mm: 300, doppler: 0.1, snr: 12 }],
      },
    });
    expect(peer.sent).toHaveLength(0);
  });

  it("pushes the device's last_seen on heartbeat", async () => {
    const res = await post(HeartbeatRoute, {
      firmware_version: "ld2450-1.0.0",
      sensor_status: "online",
    });
    expect(res.status).toBe(200);
    const msgs = parsed(peer);
    expect(msgs[0]).toMatchObject({
      type: "device",
      device_id: DEMO_DEVICE_DOC,
      sensor_status: "online",
    });
    expect(typeof (msgs[0] as { last_seen: string }).last_seen).toBe("string");
  });

  it("does not leak frames to another owner's socket", async () => {
    const other = fakePeer("other-user");
    getLiveHub().add("someone-else", other);
    await post(TelemetryRoute, {
      data: {
        sensor_type: "ld2450",
        targets: [{ target_id: 1, x_mm: 0, y_mm: 1000, speed_cms: 0 }],
      },
    });
    expect(other.sent).toHaveLength(0);
    getLiveHub().remove(other.id);
  });
});

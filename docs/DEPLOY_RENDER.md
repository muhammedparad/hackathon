# Deploying RoomTrace on Render

RoomTrace runs as a **Node web service** on Render. `render.yaml` uses the **free** plan for first tests.
The free tier sleeps after about 15 minutes without traffic: the first request afterwards is slow, the
ESP32 drops frames until the service is awake, and WebSockets reconnect. For always-on use, change
`plan` in `render.yaml` (or the instance type in Render) to a paid one. Check current Render pricing.

## 1. Firebase side

1. Firebase Console > Project settings > **Service accounts** > _Generate new private key_. Keep the JSON secret.
2. Make sure Firestore is created and `firestore.rules` / `firestore.indexes.json` are deployed.
3. Auth > Settings > Authorized domains: add your `*.onrender.com` domain.

## 2. Render service

Create a **Blueprint** from this repo (it reads `render.yaml`) or a Web Service by hand:

| Setting       | Value                                                 |
| ------------- | ----------------------------------------------------- |
| Runtime       | Node 22                                               |
| Build command | `npm install --no-audit --no-fund && npm run build`   |
| Start command | `node .output/server/index.mjs`                       |
| Instance      | free for tests (sleeps when idle); paid for always-on |

`RENDER=true` is set by Render automatically; `vite.config.ts` then builds the Nitro `node-server` preset
and keeps `firebase-admin` out of the bundle (it is loaded from `node_modules` at runtime).

### Environment variables

- `VITE_FIREBASE_*` (public client config): **set before the first build**, they are baked into the browser bundle.
- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT_KEY`: the whole service-account JSON as one value.
- There is no demo or built-in device: only devices registered on the Devices page can authenticate.

## 3. Register a device

1. Log in to the deployed site > **Devices** > add a device and assign it to a room.
2. Copy the one-time secret shown. It is stored only as a hash.
3. Put the device id, key and your Render host in `firmware/RoomTraceLD2450/credentials.h`.

## 4. Check it works

```powershell
curl -X POST https://YOUR-SERVICE.onrender.com/api/public/device/heartbeat `
  -H "X-Device-Id: YOUR_DEVICE_ID" -H "X-Device-Key: YOUR_DEVICE_KEY" `
  -H "Content-Type: application/json" -d "{}"
```

Expect `{"ok":true,...}`. A `401` means the device id or key is wrong.

## Live WebSocket feed

The website gets live radar frames pushed over a WebSocket at `/live-ws` (Nitro route
`server/routes/live-ws.ts`, enabled only for the Node build; Render supports it on the normal port).

- Device -> server, two paths, same processing (`src/lib/device-ingest.server.ts`):
  - **Device WebSocket** `/device-ws` (`server/routes/device-ws.ts`): the ESP32 keeps one connection open,
    authenticates once (`{type:"auth",device_id,key}`), then streams `telemetry` / `heartbeat` messages. No TLS
    handshake or HTTP request per frame, which removes most of the per-frame delay.
  - **HTTPS POST** `/api/public/device/telemetry` and `/heartbeat`: unchanged; the firmware uses them
    automatically whenever the socket is not ready.
    Either way the frame is published to the owner's browsers **before** Firestore is touched. On the socket,
    storing happens in a per-device queue afterwards (bounded: if Firestore is slow, the oldest waiting history
    writes are dropped, the live view is not), and history is stored at most about once per second per device,
    or immediately when the number of targets or the sensor status changes.
- The device socket re-checks the device credentials every 60 s, so a rotated or deleted device is cut off.
- Browser -> server: after connecting, the page sends `{type:"auth", token:<Firebase ID token>}`. The server
  verifies it with the Admin SDK; unauthenticated sockets get nothing and are closed after 10 s.
- Frames go only to sockets of the device's owner (`devices.user_id` == token uid).
- "Connected" for a device is still derived from the server's `last_seen` (heartbeat / telemetry), never
  from the page.
- Messages are defined in `src/lib/live/protocol.ts`.

### Trying it locally

`vite dev` does **not** serve the WebSocket (Nitro only runs in production builds). Use the built server, with
your `.env` and `FIREBASE_SERVICE_ACCOUNT_KEY` set:

```powershell
$env:RENDER = "true"; npm run build; Remove-Item Env:RENDER
$env:PORT = "8080"; node .output/server/index.mjs
```

There is no unsigned or dev mode: without Firebase Admin credentials the server cannot verify browser tokens
or device keys, so the socket stays closed and device calls return 503.

## Known limits (to fix next)

- WebSocket delivery is in memory and single-instance. A page that connects after a frame was sent sees it
  only through the Firestore listeners, until the next frame arrives.
- The HTTPS telemetry route writes **every** frame to Firestore, so the HTTPS fallback rate stays low
  (2 frames/s). The device WebSocket path stores about 1 frame/s per device (see above).
- In-memory state (dedup, zone engine, rate limits) is lost on restart/redeploy and works only with a
  **single** instance. Do not scale to several instances yet.
- Installing with `npm` ignores `bun.lock`, so dependency versions can differ slightly from local `bun install`.

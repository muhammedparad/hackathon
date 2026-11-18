# Deploying RoomTrace on Render

RoomTrace runs as an **always-on Node web service** on Render. Always-on matters: the ESP32 posts
telemetry continuously, and Render's free tier sleeps after about 15 minutes without traffic, which
would drop device data. Check current Render pricing before choosing a plan.

## 1. Firebase side
1. Firebase Console > Project settings > **Service accounts** > *Generate new private key*. Keep the JSON secret.
2. Make sure Firestore is created and `firestore.rules` / `firestore.indexes.json` are deployed.
3. Auth > Settings > Authorized domains: add your `*.onrender.com` domain.

## 2. Render service
Create a **Blueprint** from this repo (it reads `render.yaml`) or a Web Service by hand:

| Setting | Value |
|---|---|
| Runtime | Node 22 |
| Build command | `npm install --no-audit --no-fund && npm run build` |
| Start command | `node .output/server/index.mjs` |
| Instance | paid, always-on |

`RENDER=true` is set by Render automatically; `vite.config.ts` then builds the Nitro `node-server` preset
and keeps `firebase-admin` out of the bundle (it is loaded from `node_modules` at runtime).

### Environment variables
- `VITE_FIREBASE_*` (public client config): **set before the first build**, they are baked into the browser bundle.
- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT_KEY`: the whole service-account JSON as one value.
- Do **not** set `ROOMTRACE_ALLOW_DEMO_DEVICES`. With it unset, the built-in demo device key is rejected.

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

- Device -> server: ESP32 posts to `/api/public/device/telemetry` (unchanged). The route publishes the frame
  to the owner's browsers **before** writing to Firestore, so the live view does not wait on the database.
- Browser -> server: after connecting, the page sends `{type:"auth", token:<Firebase ID token>}`. The server
  verifies it with the Admin SDK; unauthenticated sockets get nothing and are closed after 10 s.
- Frames go only to sockets of the device's owner (`devices.user_id` == token uid).
- "Connected" for a device is still derived from the server's `last_seen` (heartbeat / telemetry), never
  from the page.
- Messages are defined in `src/lib/live/protocol.ts`.

### Trying it locally
`vite dev` does **not** serve the WebSocket (Nitro only runs in production builds). Use the built server:
```powershell
$env:RENDER = "true"; npm run build; Remove-Item Env:RENDER
$env:PORT = "8080"; node .output/server/index.mjs
```
Without Firebase Admin credentials the server cannot verify tokens, so the socket stays closed and the page
falls back to the Firestore listeners. For a pure local test only, `ROOMTRACE_ALLOW_DEMO_DEVICES=true` lets the
socket accept an unsigned token. Never set it on Render.

## Known limits (to fix next)
- WebSocket delivery is in memory and single-instance. A page that connects after a frame was sent sees it
  only through the Firestore listeners, until the next frame arrives.
- The telemetry route writes **every** frame to Firestore, so keep the firmware send rate low or you will
  pass the free-tier write quota. History will be downsampled into trajectory segments + events.
- In-memory state (dedup, zone engine, rate limits) is lost on restart/redeploy and works only with a
  **single** instance. Do not scale to several instances yet.
- Installing with `npm` ignores `bun.lock`, so dependency versions can differ slightly from local `bun install`.

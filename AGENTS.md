# RoomTrace Agent Rules

## Project rules

- Radar data reaches pages only through `src/lib/radar/live.tsx` (LiveProvider): live frames over the WebSocket (`src/lib/live/`), stored telemetry from Firestore as fallback. Why: one source of truth for all pages.
- LD2450 (targets) and RD-61 (point cloud) stay in separate types, components and payload schemas. Why: the sensors produce different data.
- The app contains NO simulation, demo or mock data: no simulator, scenario generator, demo accounts, built-in devices or seeded rooms. Synthetic fixtures exist only under `src/test/` and must not be imported from anywhere else. Why: everything shown must be real. The one exception is the "Heart rate" card (`src/lib/radar/vitals-demo.ts`, `demo-vitals-card.tsx`): a simulated heart rate (the LD2450 cannot measure it), always shown with a visible "simulated" tag, never stored in Firestore and never used for alerts. Real vitals must come from a device that reports them.
- Device "connected" is derived only from `devices.last_seen` set by authenticated device API calls (heartbeat/telemetry). Why: no fabricated connectivity.
- Device ingest (HTTPS routes in `src/routes/api/public/device/*` and the device WebSocket `server/routes/device-ws.ts`) shares one implementation, `src/lib/device-ingest.server.ts`, and is authenticated by X-Device-Id/X-Device-Key against hashed secrets in `device_credentials` (no client grants). Devices are owned by the verified Firebase uid of whoever registered them. Why: device secrets never reach browsers, and live frames are delivered per owner.
- Only the server writes events, telemetry and trajectories (Admin SDK). Browsers may only acknowledge events. Why: the record of what happened cannot be forged from a browser.
- The live WebSocket (`server/routes/live-ws.ts`) needs an always-on Node process (Render, `node-server` build). It authenticates with a verified Firebase ID token; there is no unsigned or dev mode. Why: edge/serverless hosts cannot hold WebSockets, and frames must reach only their owner.

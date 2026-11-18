# RoomTrace Agent Rules

## Project rules

- Radar data flows through `src/lib/radar/live.tsx` (LiveProvider); simulation and hardware both emit the same frame types from `src/lib/radar/types.ts`, so pages never branch on data source beyond labelling. Why: real ESP32 telemetry must replace simulation without frontend rewrites.
- LD2450 (targets) and RD-61 (point cloud) stay in separate types, components and payload schemas. Why: the sensors produce different data.
- Hardware mode never generates data; device "connected" is derived only from `devices.last_seen` set by authenticated device API calls. Why: no fabricated connectivity.
- Device ingest lives in `src/routes/api/public/device/*`, authenticated by X-Device-Id/X-Device-Key against hashed secrets in `device_credentials` (no client grants). Why: device secrets never reach browsers.
- Simulated events are stored with `events.simulated = true` and every simulated visual shows `<SimTag />`. Why: simulated and real data must stay distinguishable.
- Spec asked for Express/Socket.IO; this stack uses TanStack server routes + database realtime instead. Why: platform supports only TanStack Start on edge workers.

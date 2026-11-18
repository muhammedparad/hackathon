import { createFileRoute } from "@tanstack/react-router";
import { telemetryBodySchema, type Door, type RoomObject, type RoomZone } from "@/lib/radar/types";
import { authenticateDevice, json } from "@/lib/device-auth.server";
import { getAdminFirestore } from "@/lib/firebase/admin.server";
import { AlertEngine, type AlertEngineRoom } from "@/lib/radar/alert-engine";
import type { Firestore } from "firebase-admin/firestore";
import { publishDeviceSeen, publishLiveFrame } from "@/lib/live/publish.server";
import { TrajectoryRecorder } from "@/lib/radar/trajectory-recorder";
import { syncSensorStatus } from "@/lib/sensor-status.server";

/** Cache lifecycle thresholds and capacity bounds */
export const DEDUP_TTL_MS = 60_000; // 60s TTL window for retransmission deduplication
export const MAX_DEDUP_CACHE_SIZE = 1000;

export const ROOM_ENGINE_IDLE_TTL_MS = 30 * 60_000; // 30m idle TTL for room engines
export const MAX_ROOM_ENGINES_SIZE = 250;

export const OCCUPANCY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h idle TTL for occupancy states
export const MAX_OCCUPANCY_CACHE_SIZE = 500;

export interface DedupEntry {
  timestamp: string;
  hash: string;
  receivedAt: number;
}

export interface RoomEngineEntry {
  engine: AlertEngine;
  lastSynced: number;
  lastAccessed: number;
}

export interface OccupancyStateEntry {
  count: number;
  lastUpdated: number;
  sensorStatus: "online" | "disconnected" | "stale";
}

// In-memory occupancy cache for transition detection (roomId -> state)
const lastOccupancyState = new Map<string, OccupancyStateEntry>();

// Turns real LD2450 frames into stored trajectory segments (Playback + spatial analytics)
const trajectoryRecorder = new TrajectoryRecorder();

// Frame deduplication cache (deviceId -> entry)
const deviceLastFrame = new Map<string, DedupEntry>();

// In-memory stateful AlertEngine instances per room (roomId -> entry)
const roomAlertEngines = new Map<string, RoomEngineEntry>();

/** Testing / maintenance hook to clear in-memory caches */
export function _resetTelemetryCache() {
  lastOccupancyState.clear();
  deviceLastFrame.clear();
  roomAlertEngines.clear();
  trajectoryRecorder.reset();
}

/** Diagnostic stats for in-memory telemetry caches */
export function _getCacheStats() {
  return {
    dedupEntries: deviceLastFrame.size,
    roomEngines: roomAlertEngines.size,
    occupancyEntries: lastOccupancyState.size,
  };
}

/** Prunes frame deduplication cache entries exceeding TTL or capacity */
export function pruneDedupCache(now = Date.now()) {
  for (const [deviceId, entry] of deviceLastFrame.entries()) {
    if (now - entry.receivedAt > DEDUP_TTL_MS) {
      deviceLastFrame.delete(deviceId);
    }
  }

  if (deviceLastFrame.size > MAX_DEDUP_CACHE_SIZE) {
    const oldestKeys = Array.from(deviceLastFrame.entries())
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt)
      .slice(0, deviceLastFrame.size - MAX_DEDUP_CACHE_SIZE)
      .map(([k]) => k);

    for (const k of oldestKeys) {
      deviceLastFrame.delete(k);
    }
  }
}

/** Prunes room AlertEngine instances: strictly preserves active tracks; evicts only idle rooms */
export function pruneRoomEngines(now = Date.now()) {
  for (const [roomId, entry] of roomAlertEngines.entries()) {
    // Only evict when idle for > 30 minutes AND no active tracks exist
    if (now - entry.lastAccessed > ROOM_ENGINE_IDLE_TTL_MS && !entry.engine.hasActiveTracks()) {
      roomAlertEngines.delete(roomId);
    }
  }

  // If still above maximum capacity, evict oldest idle rooms without active tracks
  if (roomAlertEngines.size > MAX_ROOM_ENGINES_SIZE) {
    const candidates = Array.from(roomAlertEngines.entries())
      .filter(([_, entry]) => !entry.engine.hasActiveTracks())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    for (const [roomId] of candidates) {
      if (roomAlertEngines.size <= MAX_ROOM_ENGINES_SIZE) break;
      roomAlertEngines.delete(roomId);
    }
  }
}

/** Prunes occupancy state transitions exceeding TTL or capacity */
export function pruneOccupancyCache(now = Date.now()) {
  for (const [roomId, entry] of lastOccupancyState.entries()) {
    if (now - entry.lastUpdated > OCCUPANCY_CACHE_TTL_MS) {
      lastOccupancyState.delete(roomId);
    }
  }

  if (lastOccupancyState.size > MAX_OCCUPANCY_CACHE_SIZE) {
    const oldestKeys = Array.from(lastOccupancyState.entries())
      .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated)
      .slice(0, lastOccupancyState.size - MAX_OCCUPANCY_CACHE_SIZE)
      .map(([k]) => k);

    for (const k of oldestKeys) {
      lastOccupancyState.delete(k);
    }
  }
}

/** Get or create a stateful AlertEngine for a room, syncing geometry from Firestore Admin */
export async function getRoomAlertEngine(
  roomId: string,
  db: Firestore | null,
): Promise<AlertEngine> {
  const now = Date.now();
  pruneRoomEngines(now);

  let entry = roomAlertEngines.get(roomId);

  if (!entry) {
    const roomConfig: AlertEngineRoom = {
      id: roomId,
      name: "Monitored Room",
      width_mm: 5000,
      length_mm: 6000,
      doors: [],
      zones: [],
      objects: [],
    };
    const engine = new AlertEngine(roomConfig);
    entry = { engine, lastSynced: 0, lastAccessed: now };
    roomAlertEngines.set(roomId, entry);
  } else {
    entry.lastAccessed = now;
  }

  // Sync room geometry from Firestore Admin periodically (every 30s)
  if (db && now - entry.lastSynced > 30_000) {
    try {
      entry.lastSynced = now;
      const [roomSnap, zonesSnap, objectsSnap] = await Promise.all([
        db.collection("rooms").doc(roomId).get(),
        db.collection("room_zones").where("room_id", "==", roomId).get(),
        db.collection("room_objects").where("room_id", "==", roomId).get(),
      ]);

      if (roomSnap.exists) {
        const rData = roomSnap.data();
        const zones: RoomZone[] = zonesSnap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<RoomZone, "id">),
        }));
        const objects: RoomObject[] = objectsSnap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<RoomObject, "id">),
        }));

        entry.engine.updateRoom({
          id: roomId,
          name: (rData?.["name"] as string) || "Monitored Room",
          width_mm: (rData?.["width_mm"] as number) || 5000,
          length_mm: (rData?.["length_mm"] as number) || 6000,
          doors: (rData?.["doors"] as Door[]) || [],
          zones: zones.length > 0 ? zones : (rData?.["zones"] as RoomZone[]) || [],
          objects: objects.length > 0 ? objects : (rData?.["objects"] as RoomObject[]) || [],
        });
      }
    } catch (syncErr) {
      console.warn(`[Telemetry] Failed to refresh room geometry for ${roomId}:`, syncErr);
    }
  }

  return entry.engine;
}

// POST /api/public/device/telemetry — one LD2450 or RD-61 frame from an authenticated ESP32-S3.
export const Route = createFileRoute("/api/public/device/telemetry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if ("error" in auth) return auth.error;

        const parsed = telemetryBodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return json({ error: "Invalid telemetry payload", issues: parsed.error.issues }, 400);
        }

        const { device } = auth;
        const { data: payload } = parsed;
        const receivedAtIso = new Date().toISOString();
        const receivedAtMs = Date.now();

        const captureTimestampIso = payload.timestamp ?? null;
        let isDeviceTimeSynced = payload.device_time_synced ?? false;

        // Verify device timestamp sanity
        if (captureTimestampIso) {
          const parsedMs = new Date(captureTimestampIso).getTime();
          // Fall back if invalid or uncalibrated epoch (e.g. before 2024) or in far future (> 48h)
          if (
            isNaN(parsedMs) ||
            parsedMs < 1704067200000 ||
            parsedMs > receivedAtMs + 48 * 3600_000
          ) {
            isDeviceTimeSynced = false;
          } else if (payload.device_time_synced === undefined) {
            isDeviceTimeSynced = true;
          }
        }

        // Canonical timestamp resolution:
        // When device clock was synced at capture time, preserve original historical capture timestamp (even for buffered frames).
        // When device clock was not synced or missing, use authoritative server arrival timestamp.
        const effectiveTimestamp =
          isDeviceTimeSynced && captureTimestampIso ? captureTimestampIso : receivedAtIso;
        const ts = effectiveTimestamp;

        const payloadHash = JSON.stringify(payload.data);
        const now = Date.now();

        // Frame deduplication: prevent processing retransmissions of the exact same frame within TTL window
        pruneDedupCache(now);
        const lastFrame = deviceLastFrame.get(device.id);
        if (
          lastFrame &&
          now - lastFrame.receivedAt <= DEDUP_TTL_MS &&
          ((payload.timestamp && lastFrame.timestamp === payload.timestamp) ||
            (lastFrame.hash === payloadHash && lastFrame.timestamp === ts))
        ) {
          return json({ ok: true, duplicate: true, message: "Duplicate frame skipped" });
        }
        deviceLastFrame.set(device.id, { timestamp: ts, hash: payloadHash, receivedAt: now });

        // Push to the owner's browsers over the live WebSocket BEFORE any database work, so the live
        // view never waits on (or breaks with) Firestore. RD-61 is not published until its protocol is verified.
        if (payload.data.sensor_type === "ld2450") {
          if (payload.data.sensor_status === "disconnected") {
            publishDeviceSeen(device, receivedAtIso, "disconnected");
          } else {
            publishLiveFrame(device, {
              timestamp: ts,
              received_at: receivedAtIso,
              targets: payload.data.targets,
            });
          }
        }

        const telemetryId = `tel_${Math.random().toString(36).slice(2, 10)}`;
        const db = getAdminFirestore();

        try {
          if (db) {
            // Write to telemetry collection with explicit capture vs reception timestamps
            const telRef = await db.collection("telemetry").add({
              device_id: device.id,
              room_id: device.room_id,
              sensor_type: payload.data.sensor_type,
              timestamp: effectiveTimestamp,
              captured_at: captureTimestampIso,
              received_at: receivedAtIso,
              device_time_synced: isDeviceTimeSynced,
              captured_at_ms: payload.captured_at_ms ?? null,
              payload: payload.data,
            });

            // Write targets if LD2450
            if (payload.data.sensor_type === "ld2450" && payload.data.targets.length) {
              const batch = db.batch();
              for (const t of payload.data.targets) {
                const targetRef = db.collection("radar_targets").doc();
                batch.set(targetRef, {
                  device_id: device.id,
                  room_id: device.room_id,
                  telemetry_id: telRef.id,
                  target_id: t.target_id,
                  x_mm: t.x_mm,
                  y_mm: t.y_mm,
                  speed_cms: t.speed_cms,
                  timestamp: effectiveTimestamp,
                  captured_at: captureTimestampIso,
                  received_at: receivedAtIso,
                  device_time_synced: isDeviceTimeSynced,
                });
              }
              await batch.commit();
            }

            // Update device status & last seen
            await db.collection("devices").doc(device.id).set(
              {
                status: "connected",
                last_seen: ts,
                updated_at: ts,
              },
              { merge: true },
            );

            // Phase 3.1 & 3.2: Run stateful AlertEngine on authenticated hardware LD2450 telemetry with target device isolation
            // Note (RD-61 Limitation): RD-61 point cloud payloads are ingested above for visualization,
            // but point cloud clusters remain strictly disconnected from safety-critical alert pipelines
            // until physical hardware UART protocols are certified.
            if (payload.data.sensor_type === "ld2450" && device.room_id) {
              const epochMs = new Date(ts).getTime();
              const engine = await getRoomAlertEngine(device.room_id, db);
              const alerts = engine.processTargets(payload.data.targets, epochMs, false, device.id);

              if (alerts.length > 0) {
                const alertBatch = db.batch();
                for (const alert of alerts) {
                  const eventRef = db.collection("occupancy_events").doc();
                  alertBatch.set(eventRef, {
                    room_id: alert.room_id,
                    device_id: alert.device_id ?? device.id,
                    event_type: alert.event_type,
                    severity: alert.severity,
                    description: alert.description,
                    target_id: alert.target_id,
                    sensor_type: alert.sensor_type,
                    simulated: false,
                    timestamp: alert.timestamp,
                    x_mm: alert.x_mm,
                    y_mm: alert.y_mm,
                    z_mm: alert.z_mm ?? null,
                    zone_id: alert.zone_id ?? null,
                    zone_name: alert.zone_name ?? null,
                    evidence: alert.evidence,
                    confidence: alert.confidence,
                    evidence_quality:
                      alert.evidence_quality ??
                      alert.evidence.evidence_quality ??
                      "High Evidence Quality",
                    acknowledged: false,
                    acknowledged_at: null,
                    acknowledged_by: null,
                  });
                }
                await alertBatch.commit();
              }
            }

            // Real trajectories for Playback and spatial analytics. Only the server writes these.
            if (
              payload.data.sensor_type === "ld2450" &&
              device.room_id &&
              payload.data.sensor_status !== "disconnected"
            ) {
              const segments = trajectoryRecorder.ingest(
                { roomId: device.room_id, deviceId: device.id },
                payload.data.targets,
                new Date(ts).getTime(),
              );
              if (segments.length > 0) {
                const segBatch = db.batch();
                for (const { id, ...segment } of segments) {
                  segBatch.set(db.collection("trajectory_segments").doc(id), segment);
                }
                await segBatch.commit();
              }
            }

            // Sensor status exactly as the device reports it (never assumed).
            if (payload.data.sensor_type === "ld2450") {
              await syncSensorStatus(
                db,
                device,
                "ld2450",
                payload.data.sensor_status === "disconnected" ? "disconnected" : "connected",
              ).catch((err) => console.warn("[Telemetry] sensor status sync failed:", err));
            }

            // Detect room occupancy transitions and sensor state distinct from vacancy
            if (payload.data.sensor_type === "ld2450" && device.room_id) {
              pruneOccupancyCache(now);
              const prevState = lastOccupancyState.get(device.room_id);
              const prevCount = prevState?.count ?? 0;
              const prevStatus = prevState?.sensorStatus ?? "online";
              const sensorStatus = payload.data.sensor_status ?? "online";
              const nowCount = payload.data.targets.length;

              if (sensorStatus === "disconnected") {
                // Critical Safety: Disconnected sensor must NEVER be reported as vacant!
                lastOccupancyState.set(device.room_id, {
                  count: prevCount,
                  lastUpdated: now,
                  sensorStatus: "disconnected",
                });
                // Deduplicate: only emit on transition to avoid spamming
                if (prevStatus !== "disconnected") {
                  await db.collection("occupancy_events").add({
                    room_id: device.room_id,
                    device_id: device.id,
                    event_type: "sensor_disconnected",
                    severity: "info",
                    description: "Radar sensor disconnected or silent",
                    simulated: false,
                    timestamp: ts,
                    acknowledged: false,
                    acknowledged_at: null,
                    acknowledged_by: null,
                  });
                }
              } else {
                lastOccupancyState.set(device.room_id, {
                  count: nowCount,
                  lastUpdated: now,
                  sensorStatus: "online",
                });

                if (prevStatus === "disconnected") {
                  await db.collection("occupancy_events").add({
                    room_id: device.room_id,
                    device_id: device.id,
                    event_type: "sensor_reconnected",
                    severity: "info",
                    description: "Radar sensor reconnected and streaming telemetry",
                    simulated: false,
                    timestamp: ts,
                    acknowledged: false,
                    acknowledged_at: null,
                    acknowledged_by: null,
                  });
                }

                if (prevCount === 0 && nowCount > 0) {
                  await db.collection("occupancy_events").add({
                    room_id: device.room_id,
                    device_id: device.id,
                    event_type: "room_occupied",
                    severity: "info",
                    description: `${nowCount} target(s) detected`,
                    simulated: false,
                    timestamp: ts,
                    acknowledged: false,
                    acknowledged_at: null,
                    acknowledged_by: null,
                  });
                } else if (prevCount > 0 && nowCount === 0 && prevStatus === "online") {
                  // Only an online sensor reporting a valid frame with 0 targets constitutes vacancy
                  await db.collection("occupancy_events").add({
                    room_id: device.room_id,
                    device_id: device.id,
                    event_type: "room_vacant",
                    severity: "info",
                    description: "Valid scan: 0 targets detected",
                    simulated: false,
                    timestamp: ts,
                    acknowledged: false,
                    acknowledged_at: null,
                    acknowledged_by: null,
                  });
                }
              }
            }

            return json({ ok: true, telemetry_id: telRef.id });
          } else {
            // Local dev mode without Firestore Admin credentials
            if (payload.data.sensor_type === "ld2450" && device.room_id) {
              const epochMs = new Date(ts).getTime();
              const engine = await getRoomAlertEngine(device.room_id, null);
              const alerts = engine.processTargets(payload.data.targets, epochMs, false, device.id);

              pruneOccupancyCache(now);
              const prevState = lastOccupancyState.get(device.room_id);
              const prevCount = prevState?.count ?? 0;
              const prevStatus = prevState?.sensorStatus ?? "online";
              const sensorStatus = payload.data.sensor_status ?? "online";
              const nowCount = payload.data.targets.length;

              let transitionEvent: string | null = null;
              if (sensorStatus === "disconnected") {
                lastOccupancyState.set(device.room_id, {
                  count: prevCount,
                  lastUpdated: now,
                  sensorStatus: "disconnected",
                });
                if (prevStatus !== "disconnected") {
                  transitionEvent = "sensor_disconnected";
                }
              } else {
                lastOccupancyState.set(device.room_id, {
                  count: nowCount,
                  lastUpdated: now,
                  sensorStatus: "online",
                });
                if (prevStatus === "disconnected") {
                  transitionEvent = "sensor_reconnected";
                } else if (prevCount === 0 && nowCount > 0) {
                  transitionEvent = "room_occupied";
                } else if (prevCount > 0 && nowCount === 0 && prevStatus === "online") {
                  transitionEvent = "room_vacant";
                }
              }

              return json({
                ok: true,
                telemetry_id: telemetryId,
                timestamp: effectiveTimestamp,
                captured_at: captureTimestampIso,
                received_at: receivedAtIso,
                device_time_synced: isDeviceTimeSynced,
                local_alerts: alerts.length,
                transition_event: transitionEvent,
              });
            }
          }
        } catch (err) {
          console.warn("[Telemetry] Ingest error in Firestore Admin backend:", err);
          return json({ error: "Telemetry processing failed" }, 500);
        }

        return json({ ok: true, telemetry_id: telemetryId });
      },
    },
  },
});

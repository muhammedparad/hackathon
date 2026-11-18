import { z } from "zod";

/** Where a frame came from. Every visual must show this. */
export type DataOrigin = "hardware";

/** HLK-LD2450 (24 GHz): up to 3 tracked targets with coordinates + speed. */
export interface LD2450Target {
  target_id: number; // 1..3
  x_mm: number; // lateral, sensor at x=0 (negative = left)
  y_mm: number; // distance from sensor
  speed_cms: number; // signed radial speed
}
export interface LD2450Frame {
  sensor_type: "ld2450";
  origin: DataOrigin;
  room_id: string;
  timestamp: number; // epoch ms
  targets: LD2450Target[];
}

/**
 * Ai-Thinker RD-61 (60 GHz): unstructured point cloud.
 *
 * NOTE (RD-61 Hardware Limitations):
 * Hardware UART protocols for the RD-61 remain unverified across physical firmware revisions.
 * RD-61 point cloud clustering is performed for experimental visualization (see rd61-tracker.ts),
 * but RD-61 clusters are strictly DISCONNECTED from production safety-critical alert pipelines
 * until physical hardware UART frame validation is certified. Production explainable alerts
 * are driven exclusively by verified HLK-LD2450 telemetry.
 */
export interface RD61Point {
  x_mm: number;
  y_mm: number;
  z_mm: number;
  doppler: number; // m/s
  snr: number; // dB
}
export interface RD61Frame {
  sensor_type: "rd61";
  origin: DataOrigin;
  room_id: string;
  timestamp: number;
  points: RD61Point[];
}

export type RadarFrame = LD2450Frame | RD61Frame;

export type ConnectionState = "connected" | "disconnected" | "connecting" | "unknown";
export type RoomState = "occupied" | "vacant" | "unknown" | "sensor_offline";

export const EVENT_TYPES = [
  "target_detected",
  "target_moved",
  "target_lost",
  "room_occupied",
  "room_vacant",
  "sensor_disconnected",
  "sensor_reconnected",
  "point_cloud_update",
  // Phase 3: Explainable Alerts & Hazard Detection
  "restricted_zone_entry",
  "restricted_zone_exit",
  "hazard_zone_entry",
  "hazard_prolonged_presence",
  "unexpected_entry",
  "unusual_movement",
  "prolonged_presence",
  "routine_deviation",
  "candidate_fall",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<EventType, string> = {
  target_detected: "Target detected",
  target_moved: "Target movement",
  target_lost: "Target left",
  room_occupied: "Room occupied",
  room_vacant: "Room vacant",
  sensor_disconnected: "Sensor disconnected",
  sensor_reconnected: "Sensor reconnected",
  point_cloud_update: "Point cloud update",
  restricted_zone_entry: "Restricted zone entry",
  restricted_zone_exit: "Restricted zone exit",
  hazard_zone_entry: "Hazard zone entry",
  hazard_prolonged_presence: "Prolonged hazard presence",
  unexpected_entry: "Unexpected entrance movement",
  unusual_movement: "Unusual movement pattern",
  prolonged_presence: "Prolonged stay",
  routine_deviation: "Routine deviation",
  candidate_fall: "Candidate fall — experimental",
};

/** Severity scale for Phase 3 alerts */
export type AlertSeverity = "info" | "low" | "medium" | "high" | "critical";

/** Qualitative evidence quality rating replacing uncalibrated percentage scores */
export type EvidenceQuality =
  "High Evidence Quality" | "Moderate Evidence Quality" | "Screening Heuristic — Experimental";

/** Geometric and measurement evidence explaining why an alert triggered */
export interface EventEvidence {
  rule_id: string;
  summary: string;
  measured_value?: string | number | undefined;
  threshold_value?: string | number | undefined;
  coordinates?: { x_mm: number; y_mm: number; z_mm?: number | undefined } | undefined;
  zone_name?: string | undefined;
  zone_type?: ZoneType | undefined;
  zone_id?: string | undefined;
  door_name?: string | undefined;
  door_id?: string | undefined;
  confidence: "low" | "medium" | "high";
  evidence_quality?: EvidenceQuality | undefined;
  confidence_score?: number | undefined; // Deprecated: use evidence_quality
  limitations?: string | undefined;
  expected_behavior?: string | undefined;
  observed_behavior?: string | undefined;
}

/** Configured user routines for baseline comparison */
export interface ExpectedRoutine {
  id: string;
  room_id: string;
  name: string;
  zone_id?: string | undefined;
  zone_type?: ZoneType | undefined;
  start_time: string; // "HH:MM" 24h
  end_time: string; // "HH:MM" 24h
  expected_presence: boolean; // true = expected in zone; false = prohibited in room during window
  expected_behavior?: string | undefined;
}

/* ---------- Floor Plan: Doors, Zones, and Furniture Objects ---------- */

export interface Door {
  id: string;
  name: string;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  wall?: "top" | "bottom" | "left" | "right" | undefined;
  type: "entry" | "exit" | "both";
}

export type ZoneType = "hazard" | "restricted" | "bed" | "sofa" | "bathroom" | "custom";

export interface RoomZone {
  id: string;
  room_id: string;
  name: string;
  type: ZoneType;
  polygon: Array<{ x_mm: number; y_mm: number }>;
  color?: string | undefined;
  alert_on_entry: boolean;
  alert_schedule?: { enabled: boolean; start_time: string; end_time: string } | undefined;
  max_dwell_minutes?: number | undefined;
}

export type ObjectType =
  "bed" | "couch" | "sofa" | "table" | "desk" | "stove" | "door" | "window" | "stairs";

export interface RoomObject {
  id: string;
  room_id: string;
  name: string;
  type: ObjectType;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  length_mm: number;
  rotation_deg: number;
}

/* ---------- Trajectory Recording & Playback (Phase 2) ---------- */

/** Single coordinate point in a recorded trajectory segment. */
export interface TrajectoryPoint {
  t: number; // epoch ms
  x: number; // x_mm (lateral, sensor relative)
  y: number; // y_mm (distance from sensor)
  z?: number | undefined; // z_mm (height, e.g. RD-61)
  s?: number | undefined; // speed_cms
  snr?: number | undefined; // signal-to-noise ratio in dB
}

/**
 * Bounded segment of a target trajectory stored in Cloud Firestore / local cache.
 * Keeps documents strictly under Firestore 1MB limits (~50-100 points per segment).
 */
export interface TrajectorySegment {
  id: string;
  room_id: string;
  device_id?: string | null | undefined;
  sensor_type: "ld2450" | "rd61";
  target_id: number;
  simulated: boolean;
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601
  start_epoch: number;
  end_epoch: number;
  point_count: number;
  dwell_seconds?: number | undefined;
  coordinate_frame?: "sensor_relative" | "room_absolute" | undefined;
  points: TrajectoryPoint[];
}

/** Interpolated playback target state for rendering at a given timestamp. */
export interface PlaybackTargetState {
  target_id: number;
  sensor_type: "ld2450" | "rd61";
  x_mm: number;
  y_mm: number;
  z_mm?: number | undefined;
  speed_cms: number;
  timestamp: number;
  current_zone?: string | undefined;
  is_in_hazard?: boolean | undefined;
  dwell_ms: number;
  trail: Array<{ x: number; y: number; t: number }>;
}

/**
 * Standard Ray-casting point-in-polygon algorithm.
 * Tests if point (x, y) is inside the polygon vertices.
 */
export function isPointInPolygon(
  x: number,
  y: number,
  polygon: Array<{ x_mm: number; y_mm: number }>,
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p1 = polygon[i];
    const p2 = polygon[j];
    if (!p1 || !p2) continue;
    const xi = p1.x_mm;
    const yi = p1.y_mm;
    const xj = p2.x_mm;
    const yj = p2.y_mm;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ---------- Device ingest validation (shared by API routes + tests) ---------- */

const mm = z.number().int().min(-20000).max(20000);
export const ld2450PayloadSchema = z.object({
  sensor_type: z.literal("ld2450"),
  sensor_status: z.enum(["online", "disconnected", "stale", "error"]).optional(),
  targets: z
    .array(
      z.object({
        target_id: z.number().int().min(1).max(3),
        x_mm: mm,
        y_mm: z.number().int().min(0).max(20000),
        speed_cms: z.number().int().min(-1000).max(1000),
      }),
    )
    .max(3),
});
export const rd61PayloadSchema = z.object({
  sensor_type: z.literal("rd61"),
  sensor_status: z.enum(["online", "disconnected", "stale", "error"]).optional(),
  points: z
    .array(
      z.object({
        x_mm: mm,
        y_mm: mm,
        z_mm: mm,
        doppler: z.number().min(-20).max(20),
        snr: z.number().min(-50).max(100),
      }),
    )
    .max(512),
});
export const telemetryBodySchema = z.object({
  timestamp: z.string().datetime().optional(),
  device_time_synced: z.boolean().optional(),
  captured_at_ms: z.number().int().nonnegative().optional(),
  data: z.discriminatedUnion("sensor_type", [ld2450PayloadSchema, rd61PayloadSchema]),
});
export const heartbeatBodySchema = z.object({
  firmware_version: z.string().max(40).optional(),
  ip_address: z.string().max(64).optional(),
  rssi: z.number().optional(),
  free_heap: z.number().optional(),
  sensor_status: z.enum(["online", "disconnected", "error"]).optional(),
  ld2450_connected: z.boolean().optional(),
});
export type TelemetryBody = z.infer<typeof telemetryBodySchema>;

/** Frames older than this are considered stale. */
export const STALE_AFTER_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

export function deviceConnection(lastSeen: string | null, now = Date.now()): ConnectionState {
  if (!lastSeen) return "unknown";
  return now - new Date(lastSeen).getTime() <= HEARTBEAT_TIMEOUT_MS ? "connected" : "disconnected";
}

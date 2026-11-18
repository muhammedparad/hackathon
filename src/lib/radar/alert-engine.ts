import {
  isPointInPolygon,
  type AlertSeverity,
  type Door,
  type EventEvidence,
  type EventType,
  type EvidenceQuality,
  type ExpectedRoutine,
  type LD2450Target,
  type RoomObject,
  type RoomZone,
  type ZoneType,
} from "./types";
import type { OccupancyEvent } from "@/lib/firebase/db";

/** Default threshold settings for explainable rule evaluations */
export const DEFAULT_ALERT_CONFIG = {
  /** Hazard zone prolonged stay threshold in milliseconds (default 15s) */
  hazardProlongedDwellMs: 15_000,
  /** Prolonged presence in general zones (default 10 minutes) */
  generalProlongedDwellMs: 10 * 60_000,
  /** Door crossing proximity in millimeters (default 600mm) */
  doorProximityMm: 600,
  /** Door unexpected entry speed threshold in cm/s */
  doorEntrySpeedCms: 15,
  /** Door inward normal displacement threshold in mm */
  doorInwardThresholdMm: 30,
  /** Boundary hysteresis deadband in millimeters (prevents edge flutter) */
  boundaryDeadbandMm: 60,
  /** Candidate fall pre-impact velocity spike in cm/s */
  fallVelocitySpikeThresholdCms: 110,
  /** Candidate fall post-impact maximum speed for low-motion (cm/s) */
  fallLowMotionSpeedCms: 8,
  /** Candidate fall post-impact inactivity duration in milliseconds */
  fallLowMotionDurationMs: 3_000,
  /** Pacing: number of direction reversals within window */
  pacingReversalsThreshold: 3,
  /** Target stale timeout in milliseconds (disappearance) */
  targetStaleMs: 2_500,
};

export interface AlertEngineRoom {
  id: string;
  name: string;
  width_mm: number;
  length_mm: number;
  doors?: Door[] | undefined;
  zones?: RoomZone[] | undefined;
  objects?: RoomObject[] | undefined;
}

export interface DetectedAlert {
  room_id: string;
  event_type: EventType;
  severity: AlertSeverity;
  description: string;
  target_id: number;
  device_id?: string | undefined;
  sensor_type: "ld2450" | "rd61";
  simulated: boolean;
  timestamp: string; // ISO 8601
  x_mm: number;
  y_mm: number;
  z_mm?: number | undefined;
  zone_id?: string | undefined;
  zone_name?: string | undefined;
  evidence: EventEvidence;
  confidence: "low" | "medium" | "high";
  evidence_quality?: EvidenceQuality | undefined;
}

export interface TargetTrackingState {
  targetKey?: string | undefined;
  targetId: number;
  deviceId?: string | undefined;
  sensorType: "ld2450" | "rd61";
  x_mm: number;
  y_mm: number;
  z_mm?: number | undefined;
  speed_cms: number;
  snr?: number | undefined;
  lastSeen: number;
  firstSeen: number;

  // Active zone tracking: zoneId -> entry timestamp (ms)
  activeZones: Map<string, number>;
  // Flags to prevent repeated alerts during same session
  hazardProlongedAlerted: Set<string>;
  prolongedAlerted: Set<string>;

  // Door proximity tracking
  lastUnexpectedEntryTime: number;

  // Motion history for pacing & fall detection (last 6 seconds)
  history: Array<{ x: number; y: number; s: number; t: number; z?: number | undefined }>;

  // Fall candidate state
  spikeSpeed: number | null;
  spikeTime: number | null;
  spikeCoords: { x: number; y: number; z?: number | undefined } | null;
  fallAlertEmitted: boolean;

  // Pacing tracking
  lastPacingAlertTime: number;

  // Routine deviations alerted: routineId -> last alert timestamp
  routineAlerted: Map<string, number>;
}

/** Builds an isolated compound tracking key distinguishing targets across multiple sensors */
export function makeTargetKey(targetId: number, deviceId?: string | null): string {
  return deviceId ? `${deviceId}:${targetId}` : String(targetId);
}

/** Converts sensor-relative coordinates (sensor at top center) into room coordinates (0,0 at top-left) */
export function toRoomCoords(
  x_mm: number,
  y_mm: number,
  roomWidthMm: number,
): { rx: number; ry: number } {
  if (x_mm < 0 || (x_mm <= roomWidthMm / 2 && roomWidthMm > 0)) {
    return { rx: Math.round(x_mm + roomWidthMm / 2), ry: Math.round(y_mm) };
  }
  return { rx: Math.round(x_mm), ry: Math.round(y_mm) };
}

/** Determines if room coordinates lie on resting furniture (bed, couch, sofa) */
export function isTargetOnRestingFurniture(
  rx: number,
  ry: number,
  objects: RoomObject[] = [],
  zones: RoomZone[] = [],
): boolean {
  for (const z of zones) {
    if ((z.type === "bed" || z.type === "sofa") && isPointInPolygon(rx, ry, z.polygon)) {
      return true;
    }
  }
  for (const obj of objects) {
    if (obj.type === "bed" || obj.type === "couch") {
      const margin = 100;
      if (
        rx >= obj.x_mm - margin &&
        rx <= obj.x_mm + obj.width_mm + margin &&
        ry >= obj.y_mm - margin &&
        ry <= obj.y_mm + obj.length_mm + margin
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Checks whether a 24h clock "HH:MM" falls within a [start, end] window (supports overnight) */
export function isTimeInWindow(clockHhMm: string, startHhMm: string, endHhMm: string): boolean {
  if (startHhMm <= endHhMm) {
    return clockHhMm >= startHhMm && clockHhMm <= endHhMm;
  }
  // Overnight window e.g. 23:00 to 06:00
  return clockHhMm >= startHhMm || clockHhMm <= endHhMm;
}

/** Computes minimum perpendicular or endpoint distance from point (px, py) to polygon edges */
export function distanceToPolygonBoundary(
  px: number,
  py: number,
  polygon: Array<{ x_mm: number; y_mm: number }>,
): number {
  if (polygon.length < 2) return Infinity;
  let minDist = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p1 = polygon[j]!;
    const p2 = polygon[i]!;
    const x1 = p1.x_mm;
    const y1 = p1.y_mm;
    const x2 = p2.x_mm;
    const y2 = p2.y_mm;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let dist = 0;
    if (lenSq === 0) {
      dist = Math.hypot(px - x1, py - y1);
    } else {
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
      const projX = x1 + t * dx;
      const projY = y1 + t * dy;
      dist = Math.hypot(px - projX, py - projY);
    }
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

/** Resolves door orientation wall, either from explicit config or closest perimeter wall */
export function resolveDoorWall(
  door: Door,
  roomWidth: number,
  roomLength: number,
): "top" | "bottom" | "left" | "right" {
  if (door.wall) return door.wall;
  const dTop = Math.abs(door.y_mm);
  const dBottom = Math.abs(roomLength - door.y_mm);
  const dLeft = Math.abs(door.x_mm);
  const dRight = Math.abs(roomWidth - door.x_mm);
  const min = Math.min(dTop, dBottom, dLeft, dRight);
  if (min === dTop) return "top";
  if (min === dBottom) return "bottom";
  if (min === dLeft) return "left";
  return "right";
}

/** Returns the unit inward normal vector pointing into the room from the doorway wall */
export function getInwardNormal(wall: "top" | "bottom" | "left" | "right"): {
  nx: number;
  ny: number;
} {
  switch (wall) {
    case "top":
      return { nx: 0, ny: 1 }; // inward is increasing y (into room)
    case "bottom":
      return { nx: 0, ny: -1 }; // inward is decreasing y (away from bottom wall)
    case "left":
      return { nx: 1, ny: 0 }; // inward is increasing x (away from left wall)
    case "right":
      return { nx: -1, ny: 0 }; // inward is decreasing x (away from right wall)
  }
}

/**
 * Stateful, reusable alert detection engine for one room.
 * Analyzes live or simulated targets, suppresses duplicates, evaluates geometry,
 * and yields fully explainable events with evidence.
 */
export class AlertEngine {
  private targets = new Map<string, TargetTrackingState>();
  public routines: ExpectedRoutine[] = [];

  constructor(
    public room: AlertEngineRoom,
    public config = DEFAULT_ALERT_CONFIG,
  ) {}

  public setRoutines(routines: ExpectedRoutine[]) {
    this.routines = routines;
  }

  public updateRoom(room: AlertEngineRoom) {
    this.room = room;
  }

  /**
   * Process a single time step with observed targets.
   * Returns an array of newly triggered explainable alerts.
   */
  public processTargets(
    observedTargets: Array<
      LD2450Target & {
        z_mm?: number | undefined;
        snr?: number | undefined;
        sensor_type?: "ld2450" | "rd61" | undefined;
        device_id?: string | undefined;
      }
    >,
    timestamp: number,
    simulated: boolean,
    defaultDeviceId?: string,
  ): DetectedAlert[] {
    const alerts: DetectedAlert[] = [];
    const activeKeys = new Set<string>();
    const zones = this.room.zones ?? [];
    const doors = this.room.doors ?? [];
    const objects = this.room.objects ?? [];

    for (const obs of observedTargets) {
      const deviceId = obs.device_id ?? defaultDeviceId;
      const targetKey = makeTargetKey(obs.target_id, deviceId);
      activeKeys.add(targetKey);
      const sensorType = obs.sensor_type ?? "ld2450";
      let state = this.targets.get(targetKey);

      if (!state) {
        state = {
          targetKey,
          targetId: obs.target_id,
          deviceId,
          sensorType,
          x_mm: obs.x_mm,
          y_mm: obs.y_mm,
          z_mm: obs.z_mm,
          speed_cms: obs.speed_cms,
          snr: obs.snr,
          lastSeen: timestamp,
          firstSeen: timestamp,
          activeZones: new Map(),
          hazardProlongedAlerted: new Set(),
          prolongedAlerted: new Set(),
          lastUnexpectedEntryTime: 0,
          history: [],
          spikeSpeed: null,
          spikeTime: null,
          spikeCoords: null,
          fallAlertEmitted: false,
          lastPacingAlertTime: 0,
          routineAlerted: new Map(),
        };
        this.targets.set(targetKey, state);
      } else {
        state.x_mm = obs.x_mm;
        state.y_mm = obs.y_mm;
        state.z_mm = obs.z_mm;
        state.speed_cms = obs.speed_cms;
        state.snr = obs.snr;
        state.lastSeen = timestamp;
        if (deviceId && !state.deviceId) {
          state.deviceId = deviceId;
        }
      }

      const { rx, ry } = toRoomCoords(obs.x_mm, obs.y_mm, this.room.width_mm);

      // Append to recent motion history (keep 6000ms window)
      state.history.push({ x: rx, y: ry, s: Math.abs(obs.speed_cms), t: timestamp, z: obs.z_mm });
      const historyMin = timestamp - 6000;
      state.history = state.history.filter((h) => h.t >= historyMin);

      // 1. Evaluate Zone Collisions (Restricted & Hazard)
      this.evaluateZones(state, rx, ry, zones, timestamp, simulated, alerts);

      // 2. Evaluate Entrance / Door Crossings
      this.evaluateDoors(state, rx, ry, doors, timestamp, simulated, alerts);

      // 3. Evaluate Unusual Movement (Pacing / Prolonged non-hazard stay)
      this.evaluateUnusualMovement(state, rx, ry, zones, timestamp, simulated, alerts);

      // 4. Evaluate Routine Deviations
      this.evaluateRoutines(state, rx, ry, zones, timestamp, simulated, alerts);

      // 5. Evaluate Candidate Fall (Experimental)
      this.evaluateCandidateFall(state, rx, ry, objects, zones, timestamp, simulated, alerts);
    }

    // 6. Handle Missing / Stale Targets (scoped to reporting device to prevent cross-device eviction)
    this.handleStaleTargets(activeKeys, timestamp, zones, simulated, alerts, defaultDeviceId);

    return alerts;
  }

  /* ------------------- Rule 1 & 2: Restricted & Hazard Zones ------------------- */
  private evaluateZones(
    state: TargetTrackingState,
    rx: number,
    ry: number,
    zones: RoomZone[],
    timestamp: number,
    simulated: boolean,
    alerts: DetectedAlert[],
  ) {
    const currentlyInZoneIds = new Set<string>();

    for (const zone of zones) {
      if (!zone.polygon || zone.polygon.length < 3) continue;

      // Test point in polygon (supports room coordinates and direct coordinates)
      const strictlyInside =
        isPointInPolygon(rx, ry, zone.polygon) ||
        isPointInPolygon(state.x_mm, state.y_mm, zone.polygon);

      let inside = strictlyInside;
      // Boundary hysteresis deadband: if already tracking in this zone, prevent flutter at boundary
      if (!inside && state.activeZones.has(zone.id)) {
        const edgeDist = Math.min(
          distanceToPolygonBoundary(rx, ry, zone.polygon),
          distanceToPolygonBoundary(state.x_mm, state.y_mm, zone.polygon),
        );
        if (edgeDist <= this.config.boundaryDeadbandMm) {
          inside = true; // Retain active presence within deadband buffer
        }
      }

      if (inside) {
        currentlyInZoneIds.add(zone.id);

        if (!state.activeZones.has(zone.id)) {
          // New Zone Entry transition
          state.activeZones.set(zone.id, timestamp);

          if (zone.type === "restricted" || (zone.alert_on_entry && zone.type !== "hazard")) {
            alerts.push({
              room_id: this.room.id,
              event_type: "restricted_zone_entry",
              severity: zone.type === "restricted" ? "critical" : "high",
              description: `Target #${state.targetId} entered restricted zone '${zone.name}'`,
              target_id: state.targetId,
              device_id: state.deviceId,
              sensor_type: state.sensorType,
              simulated,
              timestamp: new Date(timestamp).toISOString(),
              x_mm: state.x_mm,
              y_mm: state.y_mm,
              z_mm: state.z_mm,
              zone_id: zone.id,
              zone_name: zone.name,
              confidence: "high",
              evidence_quality: "High Evidence Quality",
              evidence: {
                rule_id: "restricted_zone_entry",
                summary: `Target entered perimeter of configured restricted area '${zone.name}' at (${state.x_mm}, ${state.y_mm}) mm.`,
                coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
                zone_id: zone.id,
                zone_name: zone.name,
                zone_type: zone.type,
                confidence: "high",
                evidence_quality: "High Evidence Quality",
                confidence_score: 0.95,
              },
            });
          } else if (zone.type === "hazard") {
            alerts.push({
              room_id: this.room.id,
              event_type: "hazard_zone_entry",
              severity: "high",
              description: `Hazard alert: Target #${state.targetId} entered hazard zone '${zone.name}'`,
              target_id: state.targetId,
              device_id: state.deviceId,
              sensor_type: state.sensorType,
              simulated,
              timestamp: new Date(timestamp).toISOString(),
              x_mm: state.x_mm,
              y_mm: state.y_mm,
              z_mm: state.z_mm,
              zone_id: zone.id,
              zone_name: zone.name,
              confidence: "high",
              evidence_quality: "High Evidence Quality",
              evidence: {
                rule_id: "hazard_zone_entry",
                summary: `Target crossed designated hazard perimeter '${zone.name}' at (${state.x_mm}, ${state.y_mm}) mm.`,
                coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
                zone_id: zone.id,
                zone_name: zone.name,
                zone_type: "hazard",
                confidence: "high",
                evidence_quality: "High Evidence Quality",
                confidence_score: 0.95,
              },
            });
          }
        } else {
          // Continued presence: check prolonged dwell in hazard zone
          const entryTime = state.activeZones.get(zone.id) ?? timestamp;
          const dwellMs = timestamp - entryTime;
          const hazardThresholdMs =
            zone.max_dwell_minutes !== undefined && zone.max_dwell_minutes > 0
              ? Math.min(zone.max_dwell_minutes * 60_000, this.config.hazardProlongedDwellMs)
              : this.config.hazardProlongedDwellMs;

          if (
            zone.type === "hazard" &&
            dwellMs >= hazardThresholdMs &&
            !state.hazardProlongedAlerted.has(zone.id)
          ) {
            state.hazardProlongedAlerted.add(zone.id);
            const dwellSec = Math.round(dwellMs / 1000);
            alerts.push({
              room_id: this.room.id,
              event_type: "hazard_prolonged_presence",
              severity: "critical",
              description: `CRITICAL: Target #${state.targetId} prolonged presence in hazard zone '${zone.name}' (${dwellSec}s)`,
              target_id: state.targetId,
              device_id: state.deviceId,
              sensor_type: state.sensorType,
              simulated,
              timestamp: new Date(timestamp).toISOString(),
              x_mm: state.x_mm,
              y_mm: state.y_mm,
              z_mm: state.z_mm,
              zone_id: zone.id,
              zone_name: zone.name,
              confidence: "high",
              evidence_quality: "High Evidence Quality",
              evidence: {
                rule_id: "hazard_prolonged_presence",
                summary: `Target remained continuously inside hazard zone '${zone.name}' for ${dwellSec} seconds (exceeding safety threshold of ${Math.round(hazardThresholdMs / 1000)}s).`,
                measured_value: `${dwellSec}s`,
                threshold_value: `${Math.round(hazardThresholdMs / 1000)}s`,
                coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
                zone_id: zone.id,
                zone_name: zone.name,
                zone_type: "hazard",
                confidence: "high",
                evidence_quality: "High Evidence Quality",
                confidence_score: 0.92,
              },
            });
          }
        }
      }
    }

    // Check Zone Exits for zones the target left
    for (const [zoneId, entryTime] of state.activeZones.entries()) {
      if (!currentlyInZoneIds.has(zoneId)) {
        state.activeZones.delete(zoneId);
        state.hazardProlongedAlerted.delete(zoneId);
        state.prolongedAlerted.delete(zoneId);

        const zone = zones.find((z) => z.id === zoneId);
        if (zone && (zone.type === "restricted" || zone.alert_on_entry)) {
          const dwellSec = Math.round((timestamp - entryTime) / 1000);
          alerts.push({
            room_id: this.room.id,
            event_type: "restricted_zone_exit",
            severity: "info",
            description: `Target #${state.targetId} exited restricted zone '${zone.name}' after ${dwellSec}s`,
            target_id: state.targetId,
            device_id: state.deviceId,
            sensor_type: state.sensorType,
            simulated,
            timestamp: new Date(timestamp).toISOString(),
            x_mm: state.x_mm,
            y_mm: state.y_mm,
            z_mm: state.z_mm,
            zone_id: zone.id,
            zone_name: zone.name,
            confidence: "high",
            evidence_quality: "High Evidence Quality",
            evidence: {
              rule_id: "restricted_zone_exit",
              summary: `Target exited restricted zone '${zone.name}' after dwelling for ${dwellSec} seconds.`,
              measured_value: `${dwellSec}s`,
              coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
              zone_id: zone.id,
              zone_name: zone.name,
              zone_type: zone.type,
              confidence: "high",
              evidence_quality: "High Evidence Quality",
              confidence_score: 0.95,
            },
          });
        }
      }
    }
  }

  /* ------------------- Rule 3: Unexpected Entry Detection ------------------- */
  private evaluateDoors(
    state: TargetTrackingState,
    rx: number,
    ry: number,
    doors: Door[],
    timestamp: number,
    simulated: boolean,
    alerts: DetectedAlert[],
  ) {
    if (doors.length === 0) return;
    if (timestamp - state.lastUnexpectedEntryTime < 15_000) return; // 15s suppression window

    for (const door of doors) {
      if (door.type !== "entry" && door.type !== "both") continue;

      const dist = Math.hypot(rx - door.x_mm, ry - door.y_mm);
      const isNearDoor = dist <= this.config.doorProximityMm;
      if (!isNearDoor) continue;

      // Determine doorway wall & inward normal vector
      const wall = resolveDoorWall(door, this.room.width_mm, this.room.length_mm);
      const normal = getInwardNormal(wall);

      // Compute motion vector from tracking history
      let inwardDisplacement = 0;
      let isOutward = false;

      if (state.history.length >= 2) {
        // Compare current position to historical position 400-2000ms ago
        const pastPoint =
          state.history.find((h) => timestamp - h.t >= 400 && timestamp - h.t <= 2000) ??
          state.history[0]!;
        const dx = rx - pastPoint.x;
        const dy = ry - pastPoint.y;
        inwardDisplacement = dx * normal.nx + dy * normal.ny;

        // If target is moving strongly outward towards the exit/doorway, suppress unexpected entry
        if (inwardDisplacement < -30) {
          isOutward = true;
        }
      }

      if (isOutward) {
        // Target is exiting the room through the doorway, not entering
        continue;
      }

      // First detection near door or moving inward from doorway
      const isEntering =
        (timestamp - state.firstSeen <= 1_500 && inwardDisplacement >= -15) ||
        inwardDisplacement >= this.config.doorInwardThresholdMm ||
        (Math.abs(state.speed_cms) >= this.config.doorEntrySpeedCms && inwardDisplacement >= 0);

      if (isEntering) {
        state.lastUnexpectedEntryTime = timestamp;
        alerts.push({
          room_id: this.room.id,
          event_type: "unexpected_entry",
          severity: "medium",
          description: `Unrecognized movement entering through ${door.name}`,
          target_id: state.targetId,
          device_id: state.deviceId,
          sensor_type: state.sensorType,
          simulated,
          timestamp: new Date(timestamp).toISOString(),
          x_mm: state.x_mm,
          y_mm: state.y_mm,
          z_mm: state.z_mm,
          confidence: "medium",
          evidence_quality: "Moderate Evidence Quality",
          evidence: {
            rule_id: "unexpected_entry",
            summary: `Unrecognized movement observed entering inward through monitored entrance '${door.name}' at (${state.x_mm}, ${state.y_mm}) mm.`,
            measured_value: `Distance to door: ${Math.round(dist)}mm, Inward displacement: ${Math.round(inwardDisplacement)}mm, Speed: ${Math.round(state.speed_cms)} cm/s`,
            threshold_value: `Proximity <= ${this.config.doorProximityMm}mm, Direction: Inward (${wall} wall)`,
            coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
            door_id: door.id,
            door_name: door.name,
            confidence: "medium",
            evidence_quality: "Moderate Evidence Quality",
            confidence_score: 0.82,
            limitations:
              "Anonymous radar detection. Identity is unverified; reflects physical motion only.",
          },
        });
        break;
      }
    }
  }

  /* ------------------- Rule 4: Unusual Movement Detection ------------------- */
  private evaluateUnusualMovement(
    state: TargetTrackingState,
    _rx: number,
    _ry: number,
    zones: RoomZone[],
    timestamp: number,
    simulated: boolean,
    alerts: DetectedAlert[],
  ) {
    // A. Pacing / Repetitive localized reversals
    if (timestamp - state.lastPacingAlertTime >= 60_000 && state.history.length >= 8) {
      let reversals = 0;
      let prevSign = 0;

      for (let i = 1; i < state.history.length; i++) {
        const p1 = state.history[i - 1]!;
        const p2 = state.history[i]!;
        const dx = p2.x - p1.x;
        const sign = dx > 15 ? 1 : dx < -15 ? -1 : 0;
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
          reversals++;
        }
        if (sign !== 0) prevSign = sign;
      }

      // Confinement check: max displacement in history
      const minX = Math.min(...state.history.map((h) => h.x));
      const maxX = Math.max(...state.history.map((h) => h.x));
      const spanX = maxX - minX;

      if (reversals >= this.config.pacingReversalsThreshold && spanX <= 2_500) {
        state.lastPacingAlertTime = timestamp;
        alerts.push({
          room_id: this.room.id,
          event_type: "unusual_movement",
          severity: "low",
          description: `Unusual movement: Target #${state.targetId} repeated direction reversals / pacing`,
          target_id: state.targetId,
          device_id: state.deviceId,
          sensor_type: state.sensorType,
          simulated,
          timestamp: new Date(timestamp).toISOString(),
          x_mm: state.x_mm,
          y_mm: state.y_mm,
          z_mm: state.z_mm,
          confidence: "medium",
          evidence_quality: "Moderate Evidence Quality",
          evidence: {
            rule_id: "unusual_movement",
            summary: `Target exhibited repeated direction reversals (${reversals} reversals within 6s) confined to a ${Math.round(spanX)}mm span.`,
            measured_value: `${reversals} reversals`,
            threshold_value: `>= ${this.config.pacingReversalsThreshold} reversals`,
            coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
            confidence: "medium",
            evidence_quality: "Moderate Evidence Quality",
            confidence_score: 0.75,
          },
        });
      }
    }

    // B. Prolonged Presence in General Non-Hazard Zones
    for (const [zoneId, entryTime] of state.activeZones.entries()) {
      const zone = zones.find((z) => z.id === zoneId);
      if (!zone || zone.type === "hazard" || zone.type === "bed") continue;

      const dwellMs = timestamp - entryTime;
      const thresholdMs =
        zone.max_dwell_minutes !== undefined && zone.max_dwell_minutes > 0
          ? zone.max_dwell_minutes * 60_000
          : this.config.generalProlongedDwellMs;

      if (dwellMs >= thresholdMs && !state.prolongedAlerted.has(zone.id)) {
        state.prolongedAlerted.add(zone.id);
        const dwellMin = (dwellMs / 60_000).toFixed(1);
        alerts.push({
          room_id: this.room.id,
          event_type: "prolonged_presence",
          severity: "medium",
          description: `Prolonged stay: Target #${state.targetId} in '${zone.name}' for ${dwellMin} min`,
          target_id: state.targetId,
          device_id: state.deviceId,
          sensor_type: state.sensorType,
          simulated,
          timestamp: new Date(timestamp).toISOString(),
          x_mm: state.x_mm,
          y_mm: state.y_mm,
          z_mm: state.z_mm,
          zone_id: zone.id,
          zone_name: zone.name,
          confidence: "high",
          evidence_quality: "High Evidence Quality",
          evidence: {
            rule_id: "prolonged_presence",
            summary: `Target has remained continuously inside zone '${zone.name}' for ${dwellMin} minutes, exceeding dwell threshold of ${Math.round(thresholdMs / 60_000)} minutes.`,
            measured_value: `${dwellMin} min`,
            threshold_value: `${Math.round(thresholdMs / 60_000)} min`,
            coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
            zone_id: zone.id,
            zone_name: zone.name,
            zone_type: zone.type,
            confidence: "high",
            evidence_quality: "High Evidence Quality",
            confidence_score: 0.9,
          },
        });
      }
    }

    // C. General Room Prolonged Presence (on open floor)
    const totalRoomDwellMs = timestamp - state.firstSeen;
    if (
      totalRoomDwellMs >= this.config.generalProlongedDwellMs &&
      !state.prolongedAlerted.has("__room__")
    ) {
      state.prolongedAlerted.add("__room__");
      const dwellSec = Math.round(totalRoomDwellMs / 1000);
      alerts.push({
        room_id: this.room.id,
        event_type: "prolonged_presence",
        severity: "low",
        description: `Prolonged presence: Target #${state.targetId} in room for ${dwellSec}s without departure`,
        target_id: state.targetId,
        device_id: state.deviceId,
        sensor_type: state.sensorType,
        simulated,
        timestamp: new Date(timestamp).toISOString(),
        x_mm: state.x_mm,
        y_mm: state.y_mm,
        z_mm: state.z_mm,
        confidence: "medium",
        evidence_quality: "Moderate Evidence Quality",
        evidence: {
          rule_id: "prolonged_presence",
          summary: `Target #${state.targetId} has remained continuously in room for ${dwellSec} seconds exceeding threshold of ${Math.round(this.config.generalProlongedDwellMs / 1000)} seconds.`,
          measured_value: `${dwellSec}s`,
          threshold_value: `${Math.round(this.config.generalProlongedDwellMs / 1000)}s`,
          coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
          confidence: "medium",
          evidence_quality: "Moderate Evidence Quality",
          confidence_score: 0.85,
        },
      });
    }
  }

  /* ------------------- Rule 5: Routine Deviation Detection ------------------- */
  private evaluateRoutines(
    state: TargetTrackingState,
    _rx: number,
    _ry: number,
    zones: RoomZone[],
    timestamp: number,
    simulated: boolean,
    alerts: DetectedAlert[],
  ) {
    if (!this.routines || this.routines.length === 0) {
      // Do not invent routines from insufficient data
      return;
    }

    const d = new Date(timestamp);
    const clockHhMm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    for (const r of this.routines) {
      if (r.room_id !== this.room.id) continue;
      if (!isTimeInWindow(clockHhMm, r.start_time, r.end_time)) continue;

      const lastAlert = state.routineAlerted.get(r.id) ?? 0;
      if (timestamp - lastAlert < 30 * 60_000) continue; // 30m suppression

      if (!r.expected_presence) {
        // Presence is PROHIBITED during this window (e.g. night restriction)
        state.routineAlerted.set(r.id, timestamp);
        alerts.push({
          room_id: this.room.id,
          event_type: "routine_deviation",
          severity: "medium",
          description: `Routine deviation: Unexpected movement during '${r.name}' window`,
          target_id: state.targetId,
          device_id: state.deviceId,
          sensor_type: state.sensorType,
          simulated,
          timestamp: new Date(timestamp).toISOString(),
          x_mm: state.x_mm,
          y_mm: state.y_mm,
          z_mm: state.z_mm,
          confidence: "medium",
          evidence_quality: "Moderate Evidence Quality",
          evidence: {
            rule_id: "routine_deviation",
            summary: `Movement observed during '${r.name}' designated quiet/prohibited hours (${r.start_time} - ${r.end_time}).`,
            expected_behavior:
              r.expected_behavior ??
              `No occupancy expected between ${r.start_time} and ${r.end_time} (${r.name}).`,
            observed_behavior: `Target #${state.targetId} active in room at ${clockHhMm}.`,
            coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
            confidence: "medium",
            evidence_quality: "Moderate Evidence Quality",
            confidence_score: 0.85,
          },
        });
      } else if (r.zone_type || r.zone_id) {
        // Presence is EXPECTED in a specific zone (e.g. bed at night)
        // If target is active outside the expected zone for > 5s
        const inExpectedZone = Array.from(state.activeZones.keys()).some((zid) => {
          const z = zones.find((item) => item.id === zid);
          if (!z) return false;
          if (r.zone_id && z.id === r.zone_id) return true;
          if (r.zone_type && z.type === r.zone_type) return true;
          return false;
        });

        if (!inExpectedZone && timestamp - state.firstSeen > 5_000) {
          state.routineAlerted.set(r.id, timestamp);
          alerts.push({
            room_id: this.room.id,
            event_type: "routine_deviation",
            severity: "medium",
            description: `Routine deviation: Target active outside expected '${r.name}' area`,
            target_id: state.targetId,
            device_id: state.deviceId,
            sensor_type: state.sensorType,
            simulated,
            timestamp: new Date(timestamp).toISOString(),
            x_mm: state.x_mm,
            y_mm: state.y_mm,
            z_mm: state.z_mm,
            confidence: "medium",
            evidence_quality: "Moderate Evidence Quality",
            evidence: {
              rule_id: "routine_deviation",
              summary: `Target is active outside expected ${r.zone_type ?? "baseline"} area during scheduled '${r.name}' period.`,
              expected_behavior:
                r.expected_behavior ??
                `Presence expected in ${r.zone_type ?? "designated"} zone during ${r.start_time} - ${r.end_time} (${r.name}).`,
              observed_behavior: `Target #${state.targetId} detected outside zone at (${state.x_mm}, ${state.y_mm}) mm at ${clockHhMm}.`,
              coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
              confidence: "medium",
              evidence_quality: "Moderate Evidence Quality",
              confidence_score: 0.85,
            },
          });
        }
      }
    }
  }

  /* ------------------- Rule 6: Candidate Fall Detection (Experimental) ------------------- */
  private evaluateCandidateFall(
    state: TargetTrackingState,
    rx: number,
    ry: number,
    objects: RoomObject[],
    zones: RoomZone[],
    timestamp: number,
    simulated: boolean,
    alerts: DetectedAlert[],
  ) {
    const curSpeed = Math.abs(state.speed_cms);

    // 1. Quality Check: suppress if sensor quality is insufficient
    if (state.snr !== undefined && state.snr < 10) {
      state.spikeSpeed = null;
      state.spikeTime = null;
      return;
    }

    // 2. Velocity spike detection
    if (curSpeed >= this.config.fallVelocitySpikeThresholdCms && !state.fallAlertEmitted) {
      state.spikeSpeed = curSpeed;
      state.spikeTime = timestamp;
      state.spikeCoords = { x: state.x_mm, y: state.y_mm, z: state.z_mm };
      return;
    }

    // 3. Post-spike inactivity check
    if (state.spikeTime && state.spikeSpeed && !state.fallAlertEmitted) {
      const elapsedSinceSpike = timestamp - state.spikeTime;

      // If target moves normally again (>20 cm/s), it was recovery/walking, not a sustained fall
      if (curSpeed > 20 && elapsedSinceSpike < this.config.fallLowMotionDurationMs) {
        state.spikeSpeed = null;
        state.spikeTime = null;
        return;
      }

      // Check if low motion has persisted for required duration
      if (
        curSpeed <= this.config.fallLowMotionSpeedCms &&
        elapsedSinceSpike >= this.config.fallLowMotionDurationMs
      ) {
        // 4. Floor surface check: suppress if resting on bed or sofa
        const onFurniture = isTargetOnRestingFurniture(rx, ry, objects, zones);
        if (onFurniture) {
          state.spikeSpeed = null;
          state.spikeTime = null;
          return;
        }

        // Trigger Candidate Fall alert
        state.fallAlertEmitted = true;
        const spikeVal = state.spikeSpeed;
        const durationSec = (elapsedSinceSpike / 1000).toFixed(1);

        alerts.push({
          room_id: this.room.id,
          event_type: "candidate_fall",
          severity: "critical",
          description: `Candidate fall — experimental: Target #${state.targetId} abrupt motion followed by inactivity`,
          target_id: state.targetId,
          device_id: state.deviceId,
          sensor_type: state.sensorType,
          simulated,
          timestamp: new Date(timestamp).toISOString(),
          x_mm: state.x_mm,
          y_mm: state.y_mm,
          z_mm: state.z_mm,
          confidence: "low",
          evidence_quality: "Screening Heuristic — Experimental",
          evidence: {
            rule_id: "candidate_fall",
            summary: `Candidate fall — experimental: Detected rapid velocity spike (${spikeVal} cm/s) followed by sustained inactivity (<${this.config.fallLowMotionSpeedCms} cm/s for ${durationSec}s) on the open floor.`,
            measured_value: `Pre-impact spike: ${spikeVal} cm/s, Inactivity: ${durationSec}s`,
            threshold_value: `Spike >= ${this.config.fallVelocitySpikeThresholdCms} cm/s, Inactivity >= ${Math.round(this.config.fallLowMotionDurationMs / 1000)}s`,
            coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
            confidence: "low",
            evidence_quality: "Screening Heuristic — Experimental",
            confidence_score: 0.65,
            limitations:
              "Candidate fall indicator is strictly experimental and rule-based. It is not a certified medical alarm, emergency response, or certified life-safety monitoring service. Micro-radar does not verify posture or consciousness.",
          },
        });
      }
    }

    // Reset fall alert if target recovers and resumes walking
    if (state.fallAlertEmitted && curSpeed > 35) {
      state.fallAlertEmitted = false;
      state.spikeSpeed = null;
      state.spikeTime = null;
    }
  }

  /* ------------------- Rule 7: Handle Stale / Lost Targets ------------------- */
  private handleStaleTargets(
    activeKeys: Set<string>,
    timestamp: number,
    zones: RoomZone[],
    simulated: boolean,
    alerts: DetectedAlert[],
    reportingDeviceId?: string,
  ) {
    for (const [targetKey, state] of this.targets.entries()) {
      // If a reportingDeviceId is specified, only evaluate staleness for targets
      // belonging to this reporting sensor. Other sensors in the same room are preserved!
      if (reportingDeviceId && state.deviceId && state.deviceId !== reportingDeviceId) {
        continue;
      }

      if (!activeKeys.has(targetKey)) {
        if (timestamp - state.lastSeen > this.config.targetStaleMs) {
          // Target has gone missing / disappeared
          for (const [zoneId, entryTime] of state.activeZones.entries()) {
            const zone = zones.find((z) => z.id === zoneId);
            if (zone && (zone.type === "restricted" || zone.alert_on_entry)) {
              const dwellSec = Math.round((timestamp - entryTime) / 1000);
              alerts.push({
                room_id: this.room.id,
                event_type: "restricted_zone_exit",
                severity: "info",
                description: `Target #${state.targetId} tracking ended while in zone '${zone.name}' (${dwellSec}s)`,
                target_id: state.targetId,
                device_id: state.deviceId,
                sensor_type: state.sensorType,
                simulated,
                timestamp: new Date(timestamp).toISOString(),
                x_mm: state.x_mm,
                y_mm: state.y_mm,
                z_mm: state.z_mm,
                zone_id: zone.id,
                zone_name: zone.name,
                confidence: "medium",
                evidence_quality: "Moderate Evidence Quality",
                evidence: {
                  rule_id: "RULE_RESTRICTED_ZONE_LOST",
                  summary: `Tracking signal for target #${state.targetId} ended while located within zone '${zone.name}'.`,
                  measured_value: `Dwell: ${dwellSec}s before signal loss`,
                  coordinates: { x_mm: state.x_mm, y_mm: state.y_mm, z_mm: state.z_mm },
                  zone_id: zone.id,
                  zone_name: zone.name,
                  confidence: "medium",
                  evidence_quality: "Moderate Evidence Quality",
                  confidence_score: 0.85,
                },
              });
            }
          }
          // Remove target from active state
          this.targets.delete(targetKey);
        }
      }
    }
  }

  /** Returns whether the engine currently maintains any active target tracks */
  public hasActiveTracks(): boolean {
    return this.targets.size > 0;
  }

  /** Returns the count of currently tracked targets */
  public getActiveTargetCount(): number {
    return this.targets.size;
  }

  /** Returns all active tracking states */
  public getTrackedTargets(): TargetTrackingState[] {
    return Array.from(this.targets.values());
  }

  /** Returns tracking state for a specific target and optional device */
  public getTrackedTarget(
    targetId: number,
    deviceId?: string | null,
  ): TargetTrackingState | undefined {
    return this.targets.get(makeTargetKey(targetId, deviceId));
  }

  /** Prunes stale targets across all devices older than 2x stale timeout */
  public pruneStaleTargets(timestamp: number) {
    for (const [targetKey, state] of this.targets.entries()) {
      if (timestamp - state.lastSeen > this.config.targetStaleMs * 2) {
        this.targets.delete(targetKey);
      }
    }
  }

  /** Clears all target tracking states */
  public reset() {
    this.targets.clear();
  }
}

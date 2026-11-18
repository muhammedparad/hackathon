import {
  isPointInPolygon,
  type Door,
  type RoomZone,
  type TrajectoryPoint,
  type TrajectorySegment,
} from "@/lib/radar/types";
import type { OccupancyEvent } from "@/lib/firebase/db";
import { MAX_INTERPOLATION_GAP_MS } from "@/lib/radar/playback-engine";
import type {
  CoordinateFrame,
  DoorwayActivity,
  HeatmapCell,
  HeatmapData,
  SensorMountTransform,
  TrajectorySummary,
  TraversedArea,
  ZoneActivity,
} from "./types";

export const DEFAULT_MAX_INTERPOLATION_GAP_MS = 2500;
export const DEFAULT_PROVISIONAL_JITTER_DEADBAND_MM = 35;

/**
 * Transforms sensor-relative coordinates (lateral x_sensor relative to beam origin,
 * forward y_sensor along beam heading) to room-absolute coordinates [0..roomWidthMm, 0..roomLengthMm].
 *
 * Accounts for sensor mounting position (mountX, mountY) and orientation angle:
 * - orientationDeg = 0: Sensor on top wall at (mountX, mountY), facing +Y into room.
 * - orientationDeg = 90: Sensor on left wall at (mountX, mountY), facing +X into room.
 * - orientationDeg = 180: Sensor on bottom wall at (mountX, mountY), facing -Y into room.
 * - orientationDeg = 270: Sensor on right wall at (mountX, mountY), facing -X into room.
 */
export function transformSensorToRoomCoordinates(
  x_sensor: number,
  y_sensor: number,
  transform: SensorMountTransform | undefined | null,
  roomWidthMm?: number,
  roomLengthMm?: number,
): { rx: number; ry: number } | null {
  if (!transform) return null;

  const thetaDeg = transform.orientationDeg ?? 0;
  const thetaRad = (thetaDeg * Math.PI) / 180;
  const cosT = Math.cos(thetaRad);
  const sinT = Math.sin(thetaRad);

  // Rotate sensor lateral (x) and forward (y) coordinates by mounting heading
  const rx = transform.mountX_mm + x_sensor * cosT + y_sensor * sinT;
  const ry = transform.mountY_mm - x_sensor * sinT + y_sensor * cosT;

  const clampedX = roomWidthMm !== undefined ? Math.max(0, Math.min(roomWidthMm, rx)) : rx;
  const clampedY = roomLengthMm !== undefined ? Math.max(0, Math.min(roomLengthMm, ry)) : ry;

  return { rx: Math.round(clampedX), ry: Math.round(clampedY) };
}

/**
 * Normalizes coordinates into room-absolute space [0, roomWidthMm].
 *
 * If frame is "room_absolute", returns the coordinates directly without guessing or shifting.
 * If frame is "sensor_relative", applies explicit mountTransform. If mountTransform is missing,
 * returns null (never guesses or infers frame from x < roomWidth/2).
 */
export function normalizeToRoomCoordinates(
  x: number,
  y: number,
  frame: CoordinateFrame = "room_absolute",
  mountTransform?: SensorMountTransform | null,
  roomWidthMm?: number,
  roomLengthMm?: number,
): { rx: number; ry: number } | null {
  if (frame === "room_absolute") {
    const rx = roomWidthMm !== undefined ? Math.max(0, Math.min(roomWidthMm, x)) : x;
    const ry = roomLengthMm !== undefined ? Math.max(0, Math.min(roomLengthMm, y)) : y;
    return { rx: Math.round(rx), ry: Math.round(ry) };
  }

  // Sensor-relative: requires explicit transform
  if (!mountTransform) {
    return null;
  }

  return transformSensorToRoomCoordinates(x, y, mountTransform, roomWidthMm, roomLengthMm);
}

/**
 * Check if coordinate (x, y) falls within a RoomZone's polygon.
 * Both the point (x, y) and the zone polygon must be in the same coordinate frame (room-absolute).
 * Does not perform heuristic dual-coordinate shifting.
 */
export function isPointInZone(x: number, y: number, zone: RoomZone): boolean {
  if (!zone.polygon || zone.polygon.length < 3) return false;
  return isPointInPolygon(x, y, zone.polygon);
}

/**
 * Discretize room floor into a 2D spatial grid and bin all trajectory points to compute a density heatmap.
 * Points with missing transforms are safely excluded.
 */
export function calculateMovementHeatmap(
  segments: TrajectorySegment[],
  roomWidthMm: number,
  roomLengthMm: number,
  gridCols = 20,
  mountTransform?: SensorMountTransform | null,
): HeatmapData {
  const safeW = Math.max(500, roomWidthMm);
  const safeL = Math.max(500, roomLengthMm);

  // Maintain roughly square grid cells
  const aspectRatio = safeL / safeW;
  const gridRows = Math.max(5, Math.min(40, Math.round(gridCols * aspectRatio)));

  const cellWidthMm = safeW / gridCols;
  const cellHeightMm = safeL / gridRows;

  // Initialize 2D grid matrix
  const matrix: number[][] = Array.from({ length: gridRows }, () =>
    Array.from({ length: gridCols }, () => 0),
  );

  let totalPoints = 0;
  let unmappedPointsCount = 0;

  for (const seg of segments) {
    if (!seg.points || seg.points.length === 0) continue;
    const frame: CoordinateFrame = seg.coordinate_frame ?? "room_absolute";

    for (const pt of seg.points) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      const coords = normalizeToRoomCoordinates(pt.x, pt.y, frame, mountTransform, safeW, safeL);
      if (!coords) {
        unmappedPointsCount++;
        continue;
      }

      const { rx, ry } = coords;
      const col = Math.min(gridCols - 1, Math.max(0, Math.floor(rx / cellWidthMm)));
      const row = Math.min(gridRows - 1, Math.max(0, Math.floor(ry / cellHeightMm)));

      const cur = matrix[row]?.[col] ?? 0;
      if (matrix[row]) {
        matrix[row][col] = cur + 1;
        totalPoints++;
      }
    }
  }

  let maxDensityCount = 0;
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const count = matrix[r]?.[c] ?? 0;
      if (count > maxDensityCount) maxDensityCount = count;
    }
  }

  const cells: HeatmapCell[] = [];
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const count = matrix[r]?.[c] ?? 0;
      const density = maxDensityCount > 0 ? count / maxDensityCount : 0;
      cells.push({
        col: c,
        row: r,
        x_mm: Math.round(c * cellWidthMm + cellWidthMm / 2),
        y_mm: Math.round(r * cellHeightMm + cellHeightMm / 2),
        count,
        density,
      });
    }
  }

  // Identify top frequently traversed areas (top clusters)
  const sortedCells = [...cells].filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
  const frequentlyTraversedAreas: TraversedArea[] = [];
  const visited = new Set<string>();

  for (const cell of sortedCells) {
    const key = `${cell.col}_${cell.row}`;
    if (visited.has(key) || frequentlyTraversedAreas.length >= 3) continue;

    // Cluster adjacent high-density cells
    const cluster = [cell];
    visited.add(key);

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = cell.col + dc;
        const nr = cell.row + dr;
        const nKey = `${nc}_${nr}`;
        if (nc >= 0 && nc < gridCols && nr >= 0 && nr < gridRows && !visited.has(nKey)) {
          const neighbor = cells.find((c) => c.col === nc && c.row === nr);
          if (neighbor && neighbor.count >= cell.count * 0.4) {
            cluster.push(neighbor);
            visited.add(nKey);
          }
        }
      }
    }

    const clusterPoints = cluster.reduce((sum, c) => sum + c.count, 0);
    const minX = Math.min(...cluster.map((c) => c.col * cellWidthMm));
    const maxX = Math.max(...cluster.map((c) => (c.col + 1) * cellWidthMm));
    const minY = Math.min(...cluster.map((c) => c.row * cellHeightMm));
    const maxY = Math.max(...cluster.map((c) => (c.row + 1) * cellHeightMm));

    const cxM = ((minX + maxX) / 2000).toFixed(1);
    const cyM = ((minY + maxY) / 2000).toFixed(1);
    const label = `High-Traffic Area (x: ${cxM}m, y: ${cyM}m)`;

    frequentlyTraversedAreas.push({
      label,
      bounds: {
        minX_mm: Math.round(minX),
        maxX_mm: Math.round(maxX),
        minY_mm: Math.round(minY),
        maxY_mm: Math.round(maxY),
      },
      pointCount: clusterPoints,
      relativeDensityPct: totalPoints > 0 ? Math.round((clusterPoints / totalPoints) * 100) : 0,
    });
  }

  return {
    gridCols,
    gridRows,
    cellWidthMm: Math.round(cellWidthMm),
    cellHeightMm: Math.round(cellHeightMm),
    maxDensityCount,
    totalPoints,
    cells,
    frequentlyTraversedAreas,
    unmappedPointsCount,
  };
}

/**
 * Calculate zone-level activity, dwell time, and visit distribution across configured room zones.
 */
export function calculateZoneDwellAndActivity(
  segments: TrajectorySegment[],
  zones: RoomZone[],
  mountTransform?: SensorMountTransform | number | null,
  roomWidthMm?: number,
  roomLengthMm?: number,
): ZoneActivity[] {
  if (!zones || zones.length === 0) return [];

  const actualTransform: SensorMountTransform | null =
    typeof mountTransform === "object"
      ? mountTransform
      : typeof mountTransform === "number"
        ? { mountX_mm: mountTransform / 2, mountY_mm: 0, orientationDeg: 0 }
        : null;

  // Group segments by track to calculate dwell time from sequential points
  const trackMap = new Map<string, { points: TrajectoryPoint[]; frame: CoordinateFrame }>();
  for (const seg of segments) {
    const deviceKey =
      seg.device_id && seg.device_id.trim().length > 0 ? seg.device_id.trim() : "default_device";
    const key = `${deviceKey}::${seg.sensor_type}::${seg.target_id}`;
    let track = trackMap.get(key);
    if (!track) {
      track = {
        points: [],
        frame: seg.coordinate_frame ?? "room_absolute",
      };
      trackMap.set(key, track);
    }
    track.points.push(...seg.points);
  }

  const zoneStats = new Map<
    string,
    { zone: RoomZone; pointCount: number; dwellMs: number; visitCount: number }
  >();

  for (const zone of zones) {
    zoneStats.set(zone.id, { zone, pointCount: 0, dwellMs: 0, visitCount: 0 });
  }

  for (const [, track] of trackMap.entries()) {
    const valid = track.points.filter(
      (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t),
    );
    const sorted = valid.sort((a, b) => a.t - b.t);
    const currentlyInZones = new Set<string>();

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      if (!p) continue;
      const nextP = sorted[i + 1];

      // Convert to room-absolute coordinates
      const coords = normalizeToRoomCoordinates(
        p.x,
        p.y,
        track.frame,
        actualTransform,
        roomWidthMm,
        roomLengthMm,
      );
      if (!coords) continue; // Exclude points with missing transform

      for (const zone of zones) {
        const stats = zoneStats.get(zone.id);
        if (!stats) continue;

        const inZone = isPointInZone(coords.rx, coords.ry, zone);

        if (inZone) {
          stats.pointCount++;
          // Detect entry / visit transition
          if (!currentlyInZones.has(zone.id)) {
            stats.visitCount++;
            currentlyInZones.add(zone.id);
          }

          // Dwell calculation between consecutive points in track
          if (nextP) {
            const dt = nextP.t - p.t;
            if (dt > 0 && dt <= MAX_INTERPOLATION_GAP_MS) {
              stats.dwellMs += dt;
            } else {
              // Isolated point: count nominal sensor frame interval (e.g. 200ms)
              stats.dwellMs += 200;
            }
          } else {
            stats.dwellMs += 200;
          }
        } else {
          // Exited zone
          currentlyInZones.delete(zone.id);
        }
      }
    }
  }

  const totalDwellMs = Array.from(zoneStats.values()).reduce((sum, s) => sum + s.dwellMs, 0);

  return zones.map((zone) => {
    const stat = zoneStats.get(zone.id) ?? { zone, pointCount: 0, dwellMs: 0, visitCount: 0 };
    const dwellMin = Math.round((stat.dwellMs / 60000) * 10) / 10;
    const dwellPct = totalDwellMs > 0 ? Math.round((stat.dwellMs / totalDwellMs) * 1000) / 10 : 0;

    return {
      zoneId: zone.id,
      zoneName: zone.name,
      zoneType: zone.type,
      pointCount: stat.pointCount,
      dwellMs: stat.dwellMs,
      dwellMinutes: dwellMin,
      dwellPercentage: dwellPct,
      visitCount: stat.visitCount,
    };
  });
}

/**
 * Calculate entry and exit transit statistics for each configured doorway.
 *
 * Supports only doorways on explicitly specified wall geometry ("top", "bottom", "left", "right").
 * For doorways with missing wall attribute or non-cardinal/interior positions, marks
 * directionality as "unsupported" without guessing inward/outward classification.
 */
export function calculateDoorwayPassages(
  doors: Door[],
  segments: TrajectorySegment[],
  events: OccupancyEvent[] = [],
  roomWidthMm = 5000,
  roomLengthMm = 4000,
  doorwayRadiusMm = 750,
  mountTransform?: SensorMountTransform | null,
): DoorwayActivity[] {
  if (!doors || doors.length === 0) return [];

  return doors.map((door) => {
    const isWallSupported =
      door.wall === "top" ||
      door.wall === "bottom" ||
      door.wall === "left" ||
      door.wall === "right";

    let entries = 0;
    let exits = 0;
    let totalCrossings = 0;
    const hourCounts = Array.from({ length: 24 }, () => 0);

    // 1. Analyze trajectory paths near the doorway
    for (const seg of segments) {
      if (!seg.points || seg.points.length < 2) continue;
      const frame: CoordinateFrame = seg.coordinate_frame ?? "room_absolute";
      const valid = seg.points.filter(
        (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t),
      );
      const sorted = [...valid].sort((a, b) => a.t - b.t);

      for (let i = 0; i < sorted.length - 1; i++) {
        const p1 = sorted[i]!;
        const p2 = sorted[i + 1]!;
        const c1 = normalizeToRoomCoordinates(
          p1.x,
          p1.y,
          frame,
          mountTransform,
          roomWidthMm,
          roomLengthMm,
        );
        const c2 = normalizeToRoomCoordinates(
          p2.x,
          p2.y,
          frame,
          mountTransform,
          roomWidthMm,
          roomLengthMm,
        );
        if (!c1 || !c2) continue;

        const d1 = Math.hypot(c1.rx - door.x_mm, c1.ry - door.y_mm);
        const d2 = Math.hypot(c2.rx - door.x_mm, c2.ry - door.y_mm);

        if (d1 <= doorwayRadiusMm || d2 <= doorwayRadiusMm) {
          const hour = new Date(p1.t).getHours();
          hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;

          if (!isWallSupported) {
            // Doorway geometry unsupported: count proximity crossing without guessing direction
            totalCrossings++;
            continue;
          }

          const wall = door.wall!;
          let isEntry = false;
          let isExit = false;

          if (wall === "bottom") {
            // Moving upwards (-Y) is entering; downwards (+Y) is exiting
            if (c2.ry < c1.ry - 20) isEntry = true;
            else if (c2.ry > c1.ry + 20) isExit = true;
          } else if (wall === "top") {
            // Moving downwards (+Y) is entering; upwards (-Y) is exiting
            if (c2.ry > c1.ry + 20) isEntry = true;
            else if (c2.ry < c1.ry - 20) isExit = true;
          } else if (wall === "left") {
            // Moving right (+X) is entering; left (-X) is exiting
            if (c2.rx > c1.rx + 20) isEntry = true;
            else if (c2.rx < c1.rx - 20) isExit = true;
          } else if (wall === "right") {
            // Moving left (-X) is entering; right (+X) is exiting
            if (c2.rx < c1.rx - 20) isEntry = true;
            else if (c2.rx > c1.rx + 20) isExit = true;
          }

          if (door.type === "entry") {
            if (isEntry) {
              entries++;
              totalCrossings++;
            }
          } else if (door.type === "exit") {
            if (isExit) {
              exits++;
              totalCrossings++;
            }
          } else {
            // door.type === "both"
            if (isEntry) {
              entries++;
              totalCrossings++;
            } else if (isExit) {
              exits++;
              totalCrossings++;
            }
          }
        }
      }
    }

    // 2. Count doorway alert events (e.g. unexpected_entry)
    for (const e of events) {
      if (
        (e.evidence?.door_id === door.id || e.evidence?.door_name === door.name) &&
        e.event_type === "unexpected_entry"
      ) {
        if (isWallSupported) {
          entries++;
        }
        totalCrossings++;
        const hr = new Date(e.timestamp).getHours();
        hourCounts[hr] = (hourCounts[hr] ?? 0) + 1;
      }
    }

    // Determine peak transit hour
    let peakHour: number | null = null;
    let maxTransits = 0;
    for (let h = 0; h < 24; h++) {
      const c = hourCounts[h] ?? 0;
      if (c > maxTransits) {
        maxTransits = c;
        peakHour = h;
      }
    }

    return {
      doorId: door.id,
      doorName: door.name,
      doorType: door.type,
      entries: isWallSupported ? entries : 0,
      exits: isWallSupported ? exits : 0,
      totalCrossings,
      peakHour: maxTransits > 0 ? peakHour : null,
      directionality: isWallSupported ? "supported" : "unsupported",
    };
  });
}

/**
 * Summarize overall trajectory properties:
 * - 2D displacement movement speed (cm/s) calculated from valid consecutive coordinates.
 * - Absolute radial Doppler speed (cm/s) from sensor radial velocity (|p.s|).
 * - Total distance (meters) with configurable tracking-loss gap threshold and provisional jitter deadband.
 */
export function summarizeTrajectories(
  segments: TrajectorySegment[],
  roomWidthMm = 5000,
  roomLengthMm = 4000,
  options?: {
    maxGapMs?: number;
    deadbandMm?: number;
    mountTransform?: SensorMountTransform | null;
  },
): TrajectorySummary {
  const maxGapMs = options?.maxGapMs ?? DEFAULT_MAX_INTERPOLATION_GAP_MS;
  const deadbandMm = options?.deadbandMm ?? DEFAULT_PROVISIONAL_JITTER_DEADBAND_MM;

  let totalDistMm = 0;
  let totalSpeed2DCms = 0;
  let speed2DCount = 0;
  let totalRadialSpeedCms = 0;
  let radialCount = 0;
  let totalPoints = 0;
  const targetIds = new Set<number>();

  // Group points strictly by track identity: (device_id, sensor_type, target_id)
  const tracks = new Map<string, { points: TrajectoryPoint[]; frame: CoordinateFrame }>();

  for (const seg of segments) {
    if (typeof seg.target_id === "number") targetIds.add(seg.target_id);
    if (!seg.points || seg.points.length === 0) continue;

    const deviceKey =
      seg.device_id && seg.device_id.trim().length > 0 ? seg.device_id.trim() : "default_device";
    const sensorKey = seg.sensor_type ?? "ld2450";
    const trackKey = `${deviceKey}::${sensorKey}::${seg.target_id}`;
    let track = tracks.get(trackKey);
    if (!track) {
      track = {
        points: [],
        frame: seg.coordinate_frame ?? "room_absolute",
      };
      tracks.set(trackKey, track);
    }
    track.points.push(...seg.points);
  }

  for (const [, track] of tracks.entries()) {
    // 1. Filter out invalid/NaN coordinates or timestamps
    const valid = track.points.filter(
      (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t),
    );
    totalPoints += valid.length;

    // 2. Sort chronologically
    valid.sort((a, b) => a.t - b.t);

    // 3. Filter out duplicate timestamps
    const deduped: TrajectoryPoint[] = [];
    for (const p of valid) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.t === p.t) {
        // Duplicate timestamp: preserve latest or skip
        continue;
      }
      deduped.push(p);

      // Accumulate signed Doppler radial velocity magnitude without discarding negative speeds
      if (typeof p.s === "number" && Number.isFinite(p.s)) {
        totalRadialSpeedCms += Math.abs(p.s);
        radialCount++;
      }
    }

    // 4. Accumulate 2D displacement speed and distance across valid consecutive samples
    for (let i = 1; i < deduped.length; i++) {
      const prev = deduped[i - 1]!;
      const curr = deduped[i]!;

      const dt = curr.t - prev.t;
      // Do not connect points across tracking-loss gaps or non-positive time differences
      if (dt <= 0 || dt > maxGapMs) {
        continue;
      }

      const stepDistMm = Math.hypot(curr.x - prev.x, curr.y - prev.y);

      // Calculate 2D displacement speed: (distance_mm / elapsed_ms) * 100 = cm/s
      const speed2DCms = (stepDistMm / dt) * 100;
      totalSpeed2DCms += speed2DCms;
      speed2DCount++;

      // Apply provisional stationary jitter deadband for distance accumulation
      if (stepDistMm >= deadbandMm) {
        totalDistMm += stepDistMm;
      }
    }
  }

  const roomAreaM2 = (Math.max(1, roomWidthMm) * Math.max(1, roomLengthMm)) / 1_000_000;
  const movementDensity = Math.round((totalPoints / roomAreaM2) * 10) / 10;
  const avg2DSpeed = speed2DCount > 0 ? Math.round((totalSpeed2DCms / speed2DCount) * 10) / 10 : 0;
  const avgRadialSpeed =
    radialCount > 0 ? Math.round((totalRadialSpeedCms / radialCount) * 10) / 10 : 0;
  const totalDistMeters = Math.round((totalDistMm / 1000) * 10) / 10;

  return {
    totalDistanceMeters: totalDistMeters,
    averageSpeedCms: avg2DSpeed,
    averageRadialSpeedCms: avgRadialSpeed,
    totalPoints,
    segmentCount: segments.length,
    activeTargetIds: Array.from(targetIds).sort((a, b) => a - b),
    movementDensityPointsPerM2: movementDensity,
    provisionalJitterDeadbandMm: deadbandMm,
  };
}

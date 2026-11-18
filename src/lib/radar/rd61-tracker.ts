import type { EventType, RD61Frame, RD61Point } from "./types";

export interface RD61Cluster {
  id: number;
  x_mm: number;
  y_mm: number;
  z_mm: number;
  pointCount: number;
  avgDoppler: number;
  avgSnr: number;
}

export interface RD61TrackerOptions {
  snrThreshold?: number; // dB, default 7.5
  clusterDistance?: number; // mm in xy plane, default 550
  minPointsPerCluster?: number; // default 3
  trackMatchDistance?: number; // mm max association jump, default 750
  confirmationFrames?: number; // frames before declared confirmed, default 2
  lostTimeoutMs?: number; // ms before lost, default 1200
  moveCooldownMs?: number; // ms cooldown for movement event per track, default 30000
  minMoveDoppler?: number; // m/s Doppler threshold for movement, default 0.25
  pointCloudUpdateIntervalMs?: number; // ms interval for summary update, default 60000
  vacancyDebounceMs?: number; // ms debounce for room vacancy, default 800
}

interface ActiveTrack {
  id: number;
  x_mm: number;
  y_mm: number;
  z_mm: number;
  avgDoppler: number;
  avgSnr: number;
  pointCount: number;
  firstSeen: number;
  lastSeen: number;
  framesSeen: number;
  confirmed: boolean;
  lastMoveReported: number;
  lastReportedPos: { x: number; y: number };
}

export type RD61EventEmitter<R = { id: string; name: string }> = (
  room: R,
  type: EventType,
  description: string,
  target_id?: number | undefined,
  sensorType?: "ld2450" | "rd61" | null | undefined,
) => void;

/**
 * Point-cloud tracking engine for Ai-Thinker RD-61 (60 GHz) mmWave radar.
 * Clusters reflections, tracks centroids across frames, derives confirmed targets,
 * detects movements and occupancy state, and emits rate-limited, deduplicated events.
 */
export class RD61Tracker {
  private activeTracks = new Map<number, ActiveTrack>();
  private wasOccupied = false;
  private vacantBufferStart: number | null = null;
  private lastSummaryUpdate = 0;
  private wasConnected: boolean | null = null;

  private readonly snrThreshold: number;
  private readonly clusterDistance: number;
  private readonly minPointsPerCluster: number;
  private readonly trackMatchDistance: number;
  private readonly confirmationFrames: number;
  private readonly lostTimeoutMs: number;
  private readonly moveCooldownMs: number;
  private readonly minMoveDoppler: number;
  private readonly pointCloudUpdateIntervalMs: number;
  private readonly vacancyDebounceMs: number;

  constructor(options?: RD61TrackerOptions) {
    this.snrThreshold = options?.snrThreshold ?? 7.5;
    this.clusterDistance = options?.clusterDistance ?? 550;
    this.minPointsPerCluster = options?.minPointsPerCluster ?? 3;
    this.trackMatchDistance = options?.trackMatchDistance ?? 750;
    this.confirmationFrames = options?.confirmationFrames ?? 2;
    this.lostTimeoutMs = options?.lostTimeoutMs ?? 1200;
    this.moveCooldownMs = options?.moveCooldownMs ?? 30000;
    this.minMoveDoppler = options?.minMoveDoppler ?? 0.25;
    this.pointCloudUpdateIntervalMs = options?.pointCloudUpdateIntervalMs ?? 60000;
    this.vacancyDebounceMs = options?.vacancyDebounceMs ?? 800;
  }

  /**
   * Filter radar noise/clutter and cluster points in horizontal (x, y) space.
   */
  clusterPoints(points: RD61Point[]): RD61Cluster[] {
    // 1. Filter out low SNR clutter
    const valid = points.filter((p) => p.snr >= this.snrThreshold && p.y_mm >= 0);
    if (valid.length < this.minPointsPerCluster) return [];

    // 2. Spatial clustering (horizontal Euclidean distance)
    const visited = new Set<number>();
    const rawClusters: RD61Point[][] = [];

    for (let i = 0; i < valid.length; i++) {
      if (visited.has(i)) continue;
      const startPoint = valid[i];
      if (!startPoint) continue;
      visited.add(i);
      const cluster: RD61Point[] = [startPoint];
      const queue: RD61Point[] = [startPoint];
      let head = 0;

      while (head < queue.length) {
        const curr = queue[head++]!;
        for (let j = 0; j < valid.length; j++) {
          if (!visited.has(j)) {
            const candidate = valid[j];
            if (!candidate) continue;
            const dist = Math.hypot(curr.x_mm - candidate.x_mm, curr.y_mm - candidate.y_mm);
            if (dist <= this.clusterDistance) {
              visited.add(j);
              cluster.push(candidate);
              queue.push(candidate);
            }
          }
        }
      }

      if (cluster.length >= this.minPointsPerCluster) {
        rawClusters.push(cluster);
      }
    }

    // 3. Compute cluster centroids and radar metrics
    return rawClusters.map((cluster, idx) => {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let sumDoppler = 0;
      let sumSnr = 0;

      for (const pt of cluster) {
        sumX += pt.x_mm;
        sumY += pt.y_mm;
        sumZ += pt.z_mm;
        sumDoppler += pt.doppler;
        sumSnr += pt.snr;
      }

      const count = cluster.length;
      return {
        id: idx + 1,
        x_mm: Math.round(sumX / count),
        y_mm: Math.round(sumY / count),
        z_mm: Math.round(sumZ / count),
        pointCount: count,
        avgDoppler: +(sumDoppler / count).toFixed(2),
        avgSnr: +(sumSnr / count).toFixed(1),
      };
    });
  }

  /**
   * Process a single RD-61 frame, maintain temporal tracking, and emit derived events.
   */
  processFrame<R extends { id: string; name: string }>(
    frame: RD61Frame | null | undefined,
    room: R,
    emit: RD61EventEmitter<R>,
  ): RD61Cluster[] {
    const isConn = Boolean(frame && frame.points !== undefined);
    const now = frame?.timestamp ?? Date.now();

    // Check sensor connection transitions
    if (this.wasConnected !== null && this.wasConnected !== isConn) {
      emit(
        room,
        isConn ? "sensor_reconnected" : "sensor_disconnected",
        isConn ? "Simulated RD-61 radar reconnected" : "Simulated RD-61 point cloud stopped",
        undefined,
        "rd61",
      );
    }
    this.wasConnected = isConn;

    if (!frame || !frame.points) {
      // If sensor stopped, purge tracks after timeout
      this.purgeExpiredTracks(now, room, emit);
      this.evaluateOccupancy(now, room, emit);
      return [];
    }

    // 1. Cluster current frame points
    const detectedClusters = this.clusterPoints(frame.points);

    // 2. Associate detected clusters with existing tracks (Global Nearest Neighbor / Distance-Sorted Greedy)
    interface CandidateMatch {
      clusterIndex: number;
      trackId: number;
      distance: number;
    }

    const candidateMatches: CandidateMatch[] = [];
    for (let cIdx = 0; cIdx < detectedClusters.length; cIdx++) {
      const cluster = detectedClusters[cIdx]!;
      for (const track of this.activeTracks.values()) {
        const d = Math.hypot(track.x_mm - cluster.x_mm, track.y_mm - cluster.y_mm);
        if (d <= this.trackMatchDistance) {
          candidateMatches.push({ clusterIndex: cIdx, trackId: track.id, distance: d });
        }
      }
    }

    // Sort by ascending Euclidean distance to prioritize the closest matches globally
    candidateMatches.sort((a, b) => a.distance - b.distance);

    const matchedClusterIndices = new Set<number>();
    const matchedTrackIds = new Set<number>();

    for (const match of candidateMatches) {
      if (matchedClusterIndices.has(match.clusterIndex) || matchedTrackIds.has(match.trackId)) {
        continue;
      }

      const cluster = detectedClusters[match.clusterIndex]!;
      const bestTrack = this.activeTracks.get(match.trackId);
      if (!bestTrack) continue;

      matchedClusterIndices.add(match.clusterIndex);
      matchedTrackIds.add(match.trackId);

      // Exponential smoothing for centroid positions
      bestTrack.x_mm = Math.round(0.7 * cluster.x_mm + 0.3 * bestTrack.x_mm);
      bestTrack.y_mm = Math.round(0.7 * cluster.y_mm + 0.3 * bestTrack.y_mm);
      bestTrack.z_mm = Math.round(0.7 * cluster.z_mm + 0.3 * bestTrack.z_mm);
      bestTrack.avgDoppler = cluster.avgDoppler;
      bestTrack.avgSnr = cluster.avgSnr;
      bestTrack.pointCount = cluster.pointCount;
      bestTrack.lastSeen = now;
      bestTrack.framesSeen += 1;

      // Check confirmation transition
      if (!bestTrack.confirmed && bestTrack.framesSeen >= this.confirmationFrames) {
        bestTrack.confirmed = true;
        emit(
          room,
          "target_detected",
          `RD-61 detected cluster #${bestTrack.id} (${bestTrack.pointCount} points at ${(bestTrack.y_mm / 1000).toFixed(1)}m, SNR ${bestTrack.avgSnr} dB)`,
          bestTrack.id,
          "rd61",
        );
      }

      // Check movement transition (rate limited)
      if (bestTrack.confirmed) {
        const displacement = Math.hypot(
          bestTrack.x_mm - bestTrack.lastReportedPos.x,
          bestTrack.y_mm - bestTrack.lastReportedPos.y,
        );
        const hasVelocity = Math.abs(bestTrack.avgDoppler) >= this.minMoveDoppler;
        const movedSignificantly = displacement >= 350;

        if (
          (hasVelocity || movedSignificantly) &&
          now - bestTrack.lastMoveReported >= this.moveCooldownMs
        ) {
          bestTrack.lastMoveReported = now;
          bestTrack.lastReportedPos = { x: bestTrack.x_mm, y: bestTrack.y_mm };
          const speedCms = Math.round(Math.abs(bestTrack.avgDoppler) * 100);
          emit(
            room,
            "target_moved",
            `RD-61 cluster #${bestTrack.id} moving at ${speedCms > 0 ? `${speedCms} cm/s` : "micro-motion"}`,
            bestTrack.id,
            "rd61",
          );
        }
      }
    }

    const unmatchedClusters = detectedClusters.filter((_, idx) => !matchedClusterIndices.has(idx));

    // 3. Spawn new tentative tracks for unmatched clusters
    for (const cluster of unmatchedClusters) {
      const assignedId = this.allocateTrackId();
      const isConfirmed = this.confirmationFrames <= 1;

      const newTrack: ActiveTrack = {
        id: assignedId,
        x_mm: cluster.x_mm,
        y_mm: cluster.y_mm,
        z_mm: cluster.z_mm,
        avgDoppler: cluster.avgDoppler,
        avgSnr: cluster.avgSnr,
        pointCount: cluster.pointCount,
        firstSeen: now,
        lastSeen: now,
        framesSeen: 1,
        confirmed: isConfirmed,
        lastMoveReported: -this.moveCooldownMs,
        lastReportedPos: { x: cluster.x_mm, y: cluster.y_mm },
      };

      this.activeTracks.set(assignedId, newTrack);

      if (isConfirmed) {
        emit(
          room,
          "target_detected",
          `RD-61 detected cluster #${assignedId} (${cluster.pointCount} points at ${(cluster.y_mm / 1000).toFixed(1)}m, SNR ${cluster.avgSnr} dB)`,
          assignedId,
          "rd61",
        );
      }
    }

    // 4. Purge expired tracks
    this.purgeExpiredTracks(now, room, emit);

    // 5. Evaluate overall room occupancy
    this.evaluateOccupancy(now, room, emit);

    // 6. Periodic point-cloud update (rate-limited)
    if (
      frame.points.length > 0 &&
      now - this.lastSummaryUpdate >= this.pointCloudUpdateIntervalMs
    ) {
      this.lastSummaryUpdate = now;
      const confirmedCount = Array.from(this.activeTracks.values()).filter(
        (t) => t.confirmed,
      ).length;
      emit(
        room,
        "point_cloud_update",
        `RD-61 point cloud active: ${frame.points.length} points (${confirmedCount} tracked cluster${confirmedCount === 1 ? "" : "s"})`,
        undefined,
        "rd61",
      );
    }

    return detectedClusters;
  }

  /**
   * Removes tracks that have not been observed within `lostTimeoutMs`.
   */
  private purgeExpiredTracks<R extends { id: string; name: string }>(
    now: number,
    room: R,
    emit: RD61EventEmitter<R>,
  ) {
    for (const [id, track] of Array.from(this.activeTracks.entries())) {
      if (now - track.lastSeen > this.lostTimeoutMs) {
        if (track.confirmed) {
          emit(
            room,
            "target_lost",
            `RD-61 cluster #${track.id} left detection field`,
            track.id,
            "rd61",
          );
        }
        this.activeTracks.delete(id);
      }
    }
  }

  /**
   * Derive reliable room occupancy from confirmed cluster count with debouncing.
   */
  private evaluateOccupancy<R extends { id: string; name: string }>(
    now: number,
    room: R,
    emit: RD61EventEmitter<R>,
  ) {
    const confirmedCount = Array.from(this.activeTracks.values()).filter((t) => t.confirmed).length;

    if (!this.wasOccupied && confirmedCount > 0) {
      this.wasOccupied = true;
      this.vacantBufferStart = null;
      emit(
        room,
        "room_occupied",
        `${room.name} occupied (RD-61 point-cloud detection)`,
        undefined,
        "rd61",
      );
    } else if (this.wasOccupied && confirmedCount === 0) {
      if (this.vacantBufferStart === null) {
        this.vacantBufferStart = now;
      } else if (now - this.vacantBufferStart >= this.vacancyDebounceMs) {
        this.wasOccupied = false;
        this.vacantBufferStart = null;
        emit(
          room,
          "room_vacant",
          `${room.name} vacant (RD-61 point cloud clear)`,
          undefined,
          "rd61",
        );
      }
    } else if (confirmedCount > 0) {
      this.vacantBufferStart = null;
    }
  }

  private allocateTrackId(): number {
    let id = 1;
    while (this.activeTracks.has(id)) {
      id++;
    }
    return id;
  }

  /**
   * Returns current confirmed tracks.
   */
  getConfirmedTracks(): {
    id: number;
    x_mm: number;
    y_mm: number;
    z_mm: number;
    pointCount: number;
    avgDoppler: number;
    avgSnr: number;
  }[] {
    return Array.from(this.activeTracks.values())
      .filter((t) => t.confirmed)
      .map((t) => ({
        id: t.id,
        x_mm: t.x_mm,
        y_mm: t.y_mm,
        z_mm: t.z_mm,
        pointCount: t.pointCount,
        avgDoppler: t.avgDoppler,
        avgSnr: t.avgSnr,
      }));
  }

  /**
   * Reset all internal tracker state.
   */
  reset() {
    this.activeTracks.clear();
    this.wasOccupied = false;
    this.vacantBufferStart = null;
    this.lastSummaryUpdate = 0;
    this.wasConnected = null;
  }
}

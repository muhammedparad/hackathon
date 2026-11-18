// Builds stored trajectory segments (for Playback and spatial analytics) from real LD2450 frames.
// Server-side only: the browser never writes trajectories. State is in memory (single instance);
// a segment that is still open when the server restarts is lost.
import type { TrajectoryPoint, TrajectorySegment } from "./types";
import { createTrajectorySegmentId } from "./playback-engine";

export interface RecorderOptions {
  /** A target absent from frames for longer than this closes its segment. */
  gapMs?: number;
  /** Close a segment (and start a new one) at this many points, to keep documents small. */
  maxPoints?: number;
  /** Close a segment (and start a new one) when it spans this long. */
  maxDurationMs?: number;
  /** Segments with fewer points than this are dropped (one point cannot be played back). */
  minPoints?: number;
}

interface OpenTrack {
  roomId: string;
  deviceId: string;
  targetId: number;
  points: TrajectoryPoint[];
  lastSeen: number;
}

export interface RecorderTarget {
  target_id: number;
  x_mm: number;
  y_mm: number;
  speed_cms: number;
}

export class TrajectoryRecorder {
  private tracks = new Map<string, OpenTrack>();
  private readonly gapMs: number;
  private readonly maxPoints: number;
  private readonly maxDurationMs: number;
  private readonly minPoints: number;

  constructor(opts: RecorderOptions = {}) {
    this.gapMs = opts.gapMs ?? 12_000;
    this.maxPoints = opts.maxPoints ?? 100;
    this.maxDurationMs = opts.maxDurationMs ?? 120_000;
    this.minPoints = opts.minPoints ?? 2;
  }

  /**
   * Feed one real frame. Returns the segments that are finished and ready to be stored.
   * `timestampMs` is the frame's capture time (epoch ms).
   */
  ingest(
    ctx: { roomId: string; deviceId: string },
    targets: RecorderTarget[],
    timestampMs: number,
  ): TrajectorySegment[] {
    const done: TrajectorySegment[] = [];
    const seen = new Set<string>();

    for (const t of targets) {
      const key = this.key(ctx.deviceId, t.target_id);
      seen.add(key);
      let track = this.tracks.get(key);

      // A long silence for this target means the old segment is over.
      if (track && timestampMs - track.lastSeen > this.gapMs) {
        this.close(key, done);
        track = undefined;
      }
      if (!track) {
        track = {
          roomId: ctx.roomId,
          deviceId: ctx.deviceId,
          targetId: t.target_id,
          points: [],
          lastSeen: timestampMs,
        };
        this.tracks.set(key, track);
      }

      track.points.push({ t: timestampMs, x: t.x_mm, y: t.y_mm, s: t.speed_cms });
      track.lastSeen = timestampMs;

      const first = track.points[0];
      if (
        track.points.length >= this.maxPoints ||
        (first && timestampMs - first.t >= this.maxDurationMs)
      ) {
        this.close(key, done);
      }
    }

    // Close tracks of this device that this frame no longer reports and that have been silent too long,
    // and tracks of any device that went quiet entirely.
    for (const [key, track] of [...this.tracks.entries()]) {
      if (seen.has(key)) continue;
      if (timestampMs - track.lastSeen > this.gapMs) this.close(key, done);
    }
    return done;
  }

  /** Number of segments still open (for diagnostics and tests). */
  get openCount(): number {
    return this.tracks.size;
  }

  reset(): void {
    this.tracks.clear();
  }

  private key(deviceId: string, targetId: number): string {
    return `${deviceId}#${targetId}`;
  }

  private close(key: string, out: TrajectorySegment[]): void {
    const track = this.tracks.get(key);
    this.tracks.delete(key);
    if (!track || track.points.length < this.minPoints) return;
    const first = track.points[0]!;
    const last = track.points[track.points.length - 1]!;
    out.push({
      id: createTrajectorySegmentId({
        simulated: false,
        sensorType: "ld2450",
        roomId: track.roomId,
        targetId: track.targetId,
        startEpoch: first.t,
      }),
      room_id: track.roomId,
      device_id: track.deviceId,
      sensor_type: "ld2450",
      target_id: track.targetId,
      simulated: false,
      start_time: new Date(first.t).toISOString(),
      end_time: new Date(last.t).toISOString(),
      start_epoch: first.t,
      end_epoch: last.t,
      point_count: track.points.length,
      dwell_seconds: Math.round((last.t - first.t) / 1000),
      coordinate_frame: "sensor_relative",
      points: track.points,
    });
  }
}

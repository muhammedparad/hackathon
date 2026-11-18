// TEST FIXTURE ONLY: synthetic trajectories for unit-testing playback. Not part of the app.
import { createTrajectorySegmentId } from "@/lib/radar/playback-engine";
import type { TrajectoryPoint, TrajectorySegment } from "@/lib/radar/types";

/**
 * Generates synthetic simulated trajectory data for testing playback without physical hardware.
 * Clearly marks all records with `simulated: true`.
 */
export function generateSimulatedPlaybackData(
  roomId: string,
  scenario: "morning_routine" | "balcony_hazard" | "dual_crossing" = "morning_routine",
  baseTimestamp: number = Date.now() - 3600_000, // 1 hour ago
): TrajectorySegment[] {
  const segments: TrajectorySegment[] = [];

  if (scenario === "morning_routine") {
    // Target 1: Starts at bed, walks to sofa, dwells for 30s, walks to doorway
    const points: TrajectoryPoint[] = [];
    const durationSec = 180; // 3 minutes
    let curX = 1500;
    let curY = 1200;

    for (let sec = 0; sec <= durationSec; sec += 0.5) {
      const t = baseTimestamp + sec * 1000;
      let s = 0;
      if (sec < 30) {
        // Resting near bed
        curX = 1500 + Math.sin(sec) * 30;
        curY = 1200 + Math.cos(sec) * 30;
        s = 5;
      } else if (sec < 60) {
        // Walking towards couch (2500, 2500)
        const progress = (sec - 30) / 30;
        curX = Math.round(1500 + (2500 - 1500) * progress);
        curY = Math.round(1200 + (2500 - 1200) * progress);
        s = 60;
      } else if (sec < 130) {
        // Sitting on couch (dwell)
        curX = 2500 + Math.sin(sec * 0.5) * 40;
        curY = 2500 + Math.cos(sec * 0.5) * 40;
        s = 8;
      } else {
        // Walking to doorway (4500, 3800)
        const progress = (sec - 130) / 50;
        curX = Math.round(2500 + (4500 - 2500) * progress);
        curY = Math.round(2500 + (3800 - 2500) * progress);
        s = 75;
      }

      points.push({
        t,
        x: Math.round(curX),
        y: Math.round(curY),
        s,
      });
    }

    // Split into 60-point segments
    const chunkSize = 60;
    for (let i = 0; i < points.length; i += chunkSize) {
      const slice = points.slice(i, i + chunkSize);
      const startP = slice[0]!;
      const endP = slice[slice.length - 1]!;
      const segId = createTrajectorySegmentId({
        simulated: true,
        sensorType: "ld2450",
        roomId,
        targetId: 1,
        startEpoch: startP.t,
      });
      segments.push({
        id: segId,
        room_id: roomId,
        device_id: "simulated_hub",
        sensor_type: "ld2450",
        target_id: 1,
        simulated: true,
        start_time: new Date(startP.t).toISOString(),
        end_time: new Date(endP.t).toISOString(),
        start_epoch: startP.t,
        end_epoch: endP.t,
        point_count: slice.length,
        points: slice,
      });
    }
  } else if (scenario === "balcony_hazard") {
    // Target 1 enters room, approaches balcony hazard zone (4200, 1000), lingers, then steps back
    const points: TrajectoryPoint[] = [];
    const durationSec = 120; // 2 minutes

    for (let sec = 0; sec <= durationSec; sec += 0.5) {
      const t = baseTimestamp + sec * 1000;
      let curX = 2000;
      let curY = 3000;
      let s = 40;

      if (sec < 40) {
        // Moving towards hazard
        const prog = sec / 40;
        curX = 2000 + (4300 - 2000) * prog;
        curY = 3000 + (900 - 3000) * prog;
        s = 65;
      } else if (sec < 80) {
        // Lingering inside hazard zone
        curX = 4300 + Math.sin(sec * 0.8) * 80;
        curY = 900 + Math.cos(sec * 0.8) * 80;
        s = 15;
      } else {
        // Retreating back into safe room center
        const prog = (sec - 80) / 40;
        curX = 4300 + (2200 - 4300) * prog;
        curY = 900 + (2200 - 900) * prog;
        s = 55;
      }

      points.push({
        t,
        x: Math.round(curX),
        y: Math.round(curY),
        s,
      });
    }

    const chunkSize = 60;
    for (let i = 0; i < points.length; i += chunkSize) {
      const slice = points.slice(i, i + chunkSize);
      const startP = slice[0]!;
      const endP = slice[slice.length - 1]!;
      const segId = createTrajectorySegmentId({
        simulated: true,
        sensorType: "ld2450",
        roomId,
        targetId: 1,
        startEpoch: startP.t,
      });
      segments.push({
        id: segId,
        room_id: roomId,
        device_id: "simulated_hub",
        sensor_type: "ld2450",
        target_id: 1,
        simulated: true,
        start_time: new Date(startP.t).toISOString(),
        end_time: new Date(endP.t).toISOString(),
        start_epoch: startP.t,
        end_epoch: endP.t,
        point_count: slice.length,
        points: slice,
      });
    }
  } else {
    // Dual crossing: Target 1 and Target 2 walking in opposite directions
    const pointsT1: TrajectoryPoint[] = [];
    const pointsT2: TrajectoryPoint[] = [];
    const durationSec = 90;

    for (let sec = 0; sec <= durationSec; sec += 0.5) {
      const t = baseTimestamp + sec * 1000;
      const prog = sec / durationSec;

      // Target 1: Left to right
      pointsT1.push({
        t,
        x: Math.round(1000 + (4000 - 1000) * prog),
        y: Math.round(1800 + Math.sin(prog * Math.PI * 2) * 400),
        s: 50,
      });

      // Target 2: Right to left
      pointsT2.push({
        t,
        x: Math.round(4000 - (4000 - 1000) * prog),
        y: Math.round(2800 - Math.sin(prog * Math.PI * 2) * 400),
        s: 50,
      });
    }

    for (const [tid, pts] of [
      [1, pointsT1],
      [2, pointsT2],
    ] as const) {
      const chunkSize = 60;
      for (let i = 0; i < pts.length; i += chunkSize) {
        const slice = pts.slice(i, i + chunkSize);
        const startP = slice[0]!;
        const endP = slice[slice.length - 1]!;
        const segId = createTrajectorySegmentId({
          simulated: true,
          sensorType: "ld2450",
          roomId,
          targetId: tid,
          startEpoch: startP.t,
        });
        segments.push({
          id: segId,
          room_id: roomId,
          device_id: "simulated_hub",
          sensor_type: "ld2450",
          target_id: tid,
          simulated: true,
          start_time: new Date(startP.t).toISOString(),
          end_time: new Date(endP.t).toISOString(),
          start_epoch: startP.t,
          end_epoch: endP.t,
          point_count: slice.length,
          points: slice,
        });
      }
    }
  }

  return segments;
}

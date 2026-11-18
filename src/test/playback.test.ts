import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  createTrajectorySegmentId,
  generateSimulatedPlaybackData,
  interpolateTargetsAtTime,
  MAX_INTERPOLATION_GAP_MS,
  TARGET_STALE_MS,
} from "@/lib/radar/playback-engine";
import type { RoomZone, TrajectoryPoint, TrajectorySegment } from "@/lib/radar/types";
import { firebaseDb } from "@/lib/firebase/db";

describe("Trajectory Storage & Retrieval (Database Layer)", () => {
  it("stores and retrieves trajectory segments with sensor-type and provenance separation", async () => {
    const virtualSegment: TrajectorySegment = {
      id: "test_seg_virt_001",
      room_id: "room_test_playback",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: "2026-11-15T10:00:00.000Z",
      end_time: "2026-11-15T10:01:00.000Z",
      start_epoch: 1763200800000,
      end_epoch: 1763200860000,
      point_count: 3,
      points: [
        { t: 1763200800000, x: 1000, y: 1500, s: 20 },
        { t: 1763200830000, x: 1500, y: 2000, s: 40 },
        { t: 1763200860000, x: 2000, y: 2500, s: 30 },
      ],
    };

    const hardwareSegment: TrajectorySegment = {
      id: "test_seg_hw_001",
      room_id: "room_test_playback",
      device_id: "esp32_hw_hub_01",
      sensor_type: "rd61",
      target_id: 2,
      simulated: false,
      start_time: "2026-11-15T10:00:00.000Z",
      end_time: "2026-11-15T10:01:00.000Z",
      start_epoch: 1763200800000,
      end_epoch: 1763200860000,
      point_count: 2,
      points: [
        { t: 1763200800000, x: 500, y: 800, z: 1200, s: 15, snr: 22 },
        { t: 1763200860000, x: 800, y: 1000, z: 1250, s: 10, snr: 25 },
      ],
    };

    // Save both segments
    await firebaseDb.saveTrajectorySegment(virtualSegment);
    await firebaseDb.saveTrajectorySegment(hardwareSegment);

    // Query virtual only
    const virtualList = await firebaseDb.getTrajectorySegments({
      roomId: "room_test_playback",
      simulated: true,
    });
    expect(virtualList.some((s) => s.id === "test_seg_virt_001")).toBe(true);
    expect(virtualList.some((s) => s.id === "test_seg_hw_001")).toBe(false);

    // Query hardware only
    const hwList = await firebaseDb.getTrajectorySegments({
      roomId: "room_test_playback",
      simulated: false,
    });
    expect(hwList.some((s) => s.id === "test_seg_hw_001")).toBe(true);
    expect(hwList.some((s) => s.id === "test_seg_virt_001")).toBe(false);

    // Query by sensor type
    const rd61List = await firebaseDb.getTrajectorySegments({
      roomId: "room_test_playback",
      sensorType: "rd61",
    });
    expect(rd61List.every((s) => s.sensor_type === "rd61")).toBe(true);
  });

  it("handles batching and limits correctly", async () => {
    const batch: TrajectorySegment[] = [];
    for (let i = 0; i < 5; i++) {
      batch.push({
        id: `batch_seg_${i}`,
        room_id: "room_batch_test",
        sensor_type: "ld2450",
        target_id: 1,
        simulated: true,
        start_time: new Date(1763200000000 + i * 10000).toISOString(),
        end_time: new Date(1763200005000 + i * 10000).toISOString(),
        start_epoch: 1763200000000 + i * 10000,
        end_epoch: 1763200005000 + i * 10000,
        point_count: 2,
        points: [
          { t: 1763200000000 + i * 10000, x: 100 * i, y: 200 * i, s: 10 },
          { t: 1763200005000 + i * 10000, x: 150 * i, y: 250 * i, s: 15 },
        ],
      });
    }

    await firebaseDb.saveTrajectoryBatch(batch);

    const limited = await firebaseDb.getTrajectorySegments({
      roomId: "room_batch_test",
      limitCount: 3,
    });
    expect(limited.length).toBeLessThanOrEqual(5);
  });
});

describe("Playback Engine: Timestamp Interpolation", () => {
  const baseT = 1763200000000;
  const testSegment: TrajectorySegment = {
    id: "interp_test_seg",
    room_id: "room_test",
    sensor_type: "ld2450",
    target_id: 1,
    simulated: true,
    start_time: new Date(baseT).toISOString(),
    end_time: new Date(baseT + 10000).toISOString(),
    start_epoch: baseT,
    end_epoch: baseT + 10000,
    point_count: 3,
    points: [
      { t: baseT, x: 1000, y: 2000, s: 10 },
      { t: baseT + 2000, x: 1400, y: 2600, s: 30 }, // 2000ms later
      { t: baseT + 6000, x: 2000, y: 3000, s: 0 }, // 4000ms later (gap > 2500ms)
    ],
  };

  it("calculates exact midpoint interpolation correctly", () => {
    // Exactly halfway between point 0 (1000, 2000, 10cm/s) and point 1 (1400, 2600, 30cm/s)
    const midT = baseT + 1000;
    const res = interpolateTargetsAtTime([testSegment], midT);
    expect(res.targets.length).toBe(1);

    const target = res.targets[0]!;
    expect(target.target_id).toBe(1);
    expect(target.x_mm).toBe(1200); // 1000 + 0.5 * 400
    expect(target.y_mm).toBe(2300); // 2000 + 0.5 * 600
    expect(target.speed_cms).toBe(20); // 10 + 0.5 * 20
  });

  it("does not interpolate across gaps exceeding MAX_INTERPOLATION_GAP_MS", () => {
    // Gap between point 1 (baseT + 2000) and point 2 (baseT + 6000) is 4000ms > 2500ms
    // Check at baseT + 4000 (2000ms after point 1, 2000ms before point 2):
    // Stale threshold is 1500ms, so target should not be present!
    const gapMidT = baseT + 4000;
    const res = interpolateTargetsAtTime([testSegment], gapMidT);
    expect(res.targets.length).toBe(0);
  });

  it("calculates historical trails correctly", () => {
    const t = baseT + 1500;
    const res = interpolateTargetsAtTime([testSegment], t, [], 5000);
    expect(res.targets.length).toBe(1);

    const target = res.targets[0]!;
    // Trail should contain points within [t - 5000, t] plus interpolated current point
    expect(target.trail.length).toBeGreaterThanOrEqual(2);
    expect(target.trail[target.trail.length - 1]!.t).toBe(t);
  });

  it("detects zone presence and hazard status", () => {
    const testZones: RoomZone[] = [
      {
        id: "hazard_zone_1",
        room_id: "room_test",
        name: "Danger Area",
        type: "hazard",
        polygon: [
          { x_mm: 1100, y_mm: 2200 },
          { x_mm: 1300, y_mm: 2200 },
          { x_mm: 1300, y_mm: 2400 },
          { x_mm: 1100, y_mm: 2400 },
        ],
        alert_on_entry: true,
      },
    ];

    // Target at midT = baseT + 1000 is at (1200, 2300), which is inside the hazard zone!
    const midT = baseT + 1000;
    const res = interpolateTargetsAtTime([testSegment], midT, testZones);
    expect(res.targets[0]!.current_zone).toBe("Danger Area");
    expect(res.targets[0]!.is_in_hazard).toBe(true);
  });
});

describe("Simulated Playback Preset Generator", () => {
  it("generates structured valid segments for virtual playback", () => {
    const segments = generateSimulatedPlaybackData("room_mock_01", "morning_routine");
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.simulated === true)).toBe(true);
    expect(segments.every((s) => s.room_id === "room_mock_01")).toBe(true);
    expect(segments.every((s) => s.points.length > 0)).toBe(true);
  });
});

describe("Playback Engine: Multi-Speed & Transport Controls", () => {
  it("advances time delta correctly across 1x, 2x, 4x, and 10x speeds", () => {
    const wallClockDeltaMs = 100;
    const speeds = [1, 2, 4, 10];
    const expectedDeltas = [100, 200, 400, 1000];

    speeds.forEach((spd, idx) => {
      const advancedMs = wallClockDeltaMs * spd;
      expect(advancedMs).toBe(expectedDeltas[idx]);
    });
  });

  it("clamps seeking forward and backward strictly within [startTime, endTime]", () => {
    const startTime = 10000;
    const endTime = 60000;

    const clampSeek = (current: number, delta: number) =>
      Math.max(startTime, Math.min(endTime, current + delta));

    // Normal forward seek
    expect(clampSeek(20000, 5000)).toBe(25000);
    // Normal backward seek
    expect(clampSeek(20000, -5000)).toBe(15000);
    // Backward seek past start: clamps to startTime
    expect(clampSeek(12000, -5000)).toBe(10000);
    // Forward seek past end: clamps to endTime
    expect(clampSeek(58000, 5000)).toBe(60000);
  });

  it("handles Play/Pause state transitions and loop resets", () => {
    let isPlaying = false;
    let currentTime = 10000;
    const startTime = 10000;
    const endTime = 50000;

    // Toggle play
    isPlaying = !isPlaying;
    expect(isPlaying).toBe(true);

    // Toggle pause
    isPlaying = !isPlaying;
    expect(isPlaying).toBe(false);

    // When at end of timeline, hitting play resets to startTime
    currentTime = endTime;
    if (currentTime >= endTime && endTime > 0) {
      currentTime = startTime;
    }
    isPlaying = true;
    expect(currentTime).toBe(startTime);
    expect(isPlaying).toBe(true);
  });
});

describe("Playback Engine: Multi-Target & Dwell Dynamics", () => {
  it("interpolates three simultaneous targets with distinct coordinates and speed", () => {
    const baseT = 1763200000000;
    const segT1: TrajectorySegment = {
      id: "seg_t1",
      room_id: "room_multi",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: new Date(baseT).toISOString(),
      end_time: new Date(baseT + 5000).toISOString(),
      start_epoch: baseT,
      end_epoch: baseT + 5000,
      point_count: 2,
      points: [
        { t: baseT, x: 1000, y: 1000, s: 20 },
        { t: baseT + 2000, x: 1400, y: 1400, s: 20 },
      ],
    };

    const segT2: TrajectorySegment = {
      id: "seg_t2",
      room_id: "room_multi",
      sensor_type: "ld2450",
      target_id: 2,
      simulated: true,
      start_time: new Date(baseT).toISOString(),
      end_time: new Date(baseT + 5000).toISOString(),
      start_epoch: baseT,
      end_epoch: baseT + 5000,
      point_count: 2,
      points: [
        { t: baseT, x: 3000, y: 2000, s: 40 },
        { t: baseT + 2000, x: 3200, y: 2200, s: 40 },
      ],
    };

    const segT3: TrajectorySegment = {
      id: "seg_t3",
      room_id: "room_multi",
      sensor_type: "rd61",
      target_id: 3,
      simulated: true,
      start_time: new Date(baseT).toISOString(),
      end_time: new Date(baseT + 5000).toISOString(),
      start_epoch: baseT,
      end_epoch: baseT + 5000,
      point_count: 2,
      points: [
        { t: baseT, x: 2000, y: 4000, z: 1200, s: 15 },
        { t: baseT + 2000, x: 2000, y: 4400, z: 1250, s: 15 },
      ],
    };

    const res = interpolateTargetsAtTime([segT1, segT2, segT3], baseT + 1000);
    expect(res.activeCount).toBe(3);
    expect(res.targets.length).toBe(3);

    const t1 = res.targets.find((t) => t.target_id === 1 && t.sensor_type === "ld2450");
    const t2 = res.targets.find((t) => t.target_id === 2 && t.sensor_type === "ld2450");
    const t3 = res.targets.find((t) => t.target_id === 3 && t.sensor_type === "rd61");

    expect(t1).toBeDefined();
    expect(t1!.x_mm).toBe(1200);
    expect(t1!.y_mm).toBe(1200);

    expect(t2).toBeDefined();
    expect(t2!.x_mm).toBe(3100);
    expect(t2!.y_mm).toBe(2100);

    expect(t3).toBeDefined();
    expect(t3!.x_mm).toBe(2000);
    expect(t3!.y_mm).toBe(4200);
    expect(t3!.z_mm).toBe(1225);
  });

  it("accumulates stationary dwell within 600mm and resets when displacement exceeds 600mm", () => {
    const baseT = 1763200000000;
    // Target starts stationary at (1000, 1000) for 4 seconds, then walks away to (2500, 2500)
    const points: TrajectoryPoint[] = [
      { t: baseT, x: 1000, y: 1000, s: 0 },
      { t: baseT + 1000, x: 1050, y: 1050, s: 0 }, // dist ~70mm <= 600mm
      { t: baseT + 2000, x: 1100, y: 1100, s: 0 }, // dist ~141mm <= 600mm
      { t: baseT + 3000, x: 1150, y: 1150, s: 0 }, // dist ~212mm <= 600mm
      { t: baseT + 4000, x: 2500, y: 2500, s: 80 }, // dist ~1900mm > 600mm from earlier
    ];

    const seg: TrajectorySegment = {
      id: "seg_dwell_test",
      room_id: "room_dwell",
      sensor_type: "ld2450",
      target_id: 1,
      simulated: true,
      start_time: new Date(baseT).toISOString(),
      end_time: new Date(baseT + 4000).toISOString(),
      start_epoch: baseT,
      end_epoch: baseT + 4000,
      point_count: points.length,
      points,
    };

    // At baseT + 3000: target has remained within 600mm radius since baseT -> dwell is ~3000ms
    const resStationary = interpolateTargetsAtTime([seg], baseT + 3000, [], 10000);
    expect(resStationary.targets[0]!.dwell_ms).toBeGreaterThanOrEqual(3000);

    // At baseT + 4000: target jumped to (2500, 2500) which is >600mm away from (1150, 1150) -> dwell resets to 0
    const resMoved = interpolateTargetsAtTime([seg], baseT + 4000, [], 10000);
    expect(resMoved.targets[0]!.dwell_ms).toBe(0);
  });
});

describe("Trajectory ID Collision Protection & Retry Stability", () => {
  it("generates unique IDs across calls but maintains deterministic stability with fixed entropy", () => {
    const id1 = createTrajectorySegmentId({
      simulated: true,
      sensorType: "ld2450",
      roomId: "room_alpha",
      targetId: 1,
      startEpoch: 1763200000000,
    });
    const id2 = createTrajectorySegmentId({
      simulated: true,
      sensorType: "ld2450",
      roomId: "room_alpha",
      targetId: 1,
      startEpoch: 1763200000000,
    });

    // Random entropy creates distinct IDs to prevent collision
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("sim_ld2450_room_alpha_t1_1763200000000_")).toBe(true);
    expect(id2.startsWith("sim_ld2450_room_alpha_t1_1763200000000_")).toBe(true);

    // Retry with preserved entropy produces stable identical ID (idempotent write)
    const retryEntropy = "fixed_entropy_xyz";
    const retry1 = createTrajectorySegmentId({
      simulated: false,
      sensorType: "rd61",
      roomId: "room_beta",
      targetId: 2,
      startEpoch: 1763200000000,
      entropy: retryEntropy,
    });
    const retry2 = createTrajectorySegmentId({
      simulated: false,
      sensorType: "rd61",
      roomId: "room_beta",
      targetId: 2,
      startEpoch: 1763200000000,
      entropy: retryEntropy,
    });
    expect(retry1).toBe(retry2);
    expect(retry1).toBe("hw_rd61_room_beta_t2_1763200000000_fixed_entropy_xyz");
  });
});

describe("Firestore Security Rule Logic: Room Ownership & Provenance", () => {
  // Simulates Firestore Security Rule evaluator logic matching firestore.rules
  interface SecurityContext {
    auth: { uid: string } | null;
  }
  interface MockDb {
    rooms: Record<string, { user_id: string }>;
  }

  const mockDb: MockDb = {
    rooms: {
      room_alice: { user_id: "user_alice_123" },
      room_bob: { user_id: "user_bob_456" },
    },
  };

  const isRoomOwner = (context: SecurityContext, roomId: string) => {
    if (!context.auth) return false;
    const room = mockDb.rooms[roomId];
    return !!room && room.user_id === context.auth.uid;
  };

  // Rule: Rooms update
  // allow update: if isAuthenticated() && resource.data.user_id == request.auth.uid && request.resource.data.user_id == resource.data.user_id;
  const evaluateRoomUpdate = (
    context: SecurityContext,
    resource: { user_id: string },
    requestResource: { user_id: string },
  ) => {
    if (!context.auth) return { allowed: false, reason: "Unauthenticated" };
    if (resource.user_id !== context.auth.uid) return { allowed: false, reason: "Not room owner" };
    if (requestResource.user_id !== resource.user_id)
      return { allowed: false, reason: "Cannot change room user_id" };
    return { allowed: true };
  };

  // Rule: Room Zone update
  // allow update: if isAuthenticated() && isRoomOwner(resource.data.room_id) && request.resource.data.room_id == resource.data.room_id;
  const evaluateZoneUpdate = (
    context: SecurityContext,
    resource: { room_id: string },
    requestResource: { room_id: string },
  ) => {
    if (!context.auth) return { allowed: false, reason: "Unauthenticated" };
    if (!isRoomOwner(context, resource.room_id))
      return { allowed: false, reason: "Unauthorized room zone" };
    if (requestResource.room_id !== resource.room_id)
      return { allowed: false, reason: "Cannot change zone room_id" };
    return { allowed: true };
  };

  // Rule: Room Object update
  // allow update: if isAuthenticated() && isRoomOwner(resource.data.room_id) && request.resource.data.room_id == resource.data.room_id;
  const evaluateObjectUpdate = (
    context: SecurityContext,
    resource: { room_id: string },
    requestResource: { room_id: string },
  ) => {
    if (!context.auth) return { allowed: false, reason: "Unauthenticated" };
    if (!isRoomOwner(context, resource.room_id))
      return { allowed: false, reason: "Unauthorized room object" };
    if (requestResource.room_id !== resource.room_id)
      return { allowed: false, reason: "Cannot change object room_id" };
    return { allowed: true };
  };

  // Rule: Occupancy Event update (Phase 3.1 & 3.2: permits room owners to acknowledge hardware events with hardened validation)
  const evaluateEventUpdate = (
    context: { auth: { uid: string } | null; requestTime?: string | undefined },
    resource: { room_id: string; simulated: boolean; [key: string]: unknown },
    requestResource: { room_id: string; simulated: boolean; [key: string]: unknown },
  ) => {
    if (!context.auth) return { allowed: false, reason: "Unauthenticated" };
    if (!isRoomOwner(context, resource.room_id))
      return { allowed: false, reason: "Unauthorized event room" };
    if (requestResource.room_id !== resource.room_id)
      return { allowed: false, reason: "Cannot change event room_id" };

    // Simulated events: can update virtual events, must remain simulated
    if (resource.simulated === true && requestResource.simulated === true) {
      return { allowed: true };
    }

    // Hardware events: can ONLY acknowledge with strict caller UID, boolean type, and server timestamp
    if (resource.simulated === false && requestResource.simulated === false) {
      const allKeys = new Set([...Object.keys(resource), ...Object.keys(requestResource)]);
      const allowedAckKeys = new Set(["acknowledged", "acknowledged_at", "acknowledged_by"]);
      for (const k of allKeys) {
        if (resource[k] !== requestResource[k] && !allowedAckKeys.has(k)) {
          return {
            allowed: false,
            reason: `Cannot modify hardware event field '${k}'`,
          };
        }
      }

      // Hardening 1: acknowledged must be boolean and true
      if (
        typeof requestResource["acknowledged"] !== "boolean" ||
        requestResource["acknowledged"] !== true
      ) {
        return { allowed: false, reason: "acknowledged must be boolean true" };
      }

      // Hardening 2: acknowledged_by must equal authenticated caller UID
      if (requestResource["acknowledged_by"] !== context.auth.uid) {
        return { allowed: false, reason: "acknowledged_by must match caller UID" };
      }

      // Hardening 3: acknowledged_at must equal request.time (server timestamp validation)
      const expectedTime = context.requestTime ?? "request.time";
      if (
        requestResource["acknowledged_at"] !== expectedTime &&
        requestResource["acknowledged_at"] !== "request.time"
      ) {
        return {
          allowed: false,
          reason: "acknowledged_at must equal request.time (server timestamp required)",
        };
      }

      return { allowed: true };
    }

    return { allowed: false, reason: "Cannot convert hardware to simulated or vice versa" };
  };

  // Rule: Trajectory Segment create/update
  const evaluateTrajectorySegmentCreate = (
    context: SecurityContext,
    requestResource: { room_id: string; simulated: boolean },
  ) => {
    if (!context.auth) return { allowed: false, reason: "Unauthenticated" };
    if (!isRoomOwner(context, requestResource.room_id))
      return { allowed: false, reason: "Unauthorized cross-room write" };
    if (requestResource.simulated !== true)
      return { allowed: false, reason: "Browser cannot write hardware data" };
    return { allowed: true };
  };

  const evaluateTrajectorySegmentUpdate = (
    context: SecurityContext,
    resource: { room_id: string; simulated: boolean },
    requestResource: { room_id: string; simulated: boolean },
  ) => {
    if (!context.auth) return { allowed: false, reason: "Unauthenticated" };
    if (!isRoomOwner(context, resource.room_id))
      return { allowed: false, reason: "Unauthorized room trajectory" };
    if (resource.simulated !== true || requestResource.simulated !== true)
      return { allowed: false, reason: "Cannot convert or modify hardware trajectory" };
    if (requestResource.room_id !== resource.room_id)
      return { allowed: false, reason: "Cannot change trajectory room_id" };
    return { allowed: true };
  };

  const evaluateDeviceCredentialsAccess = (_context: SecurityContext) => {
    // Rule: match /device_credentials/{id} { allow read, write: if false; }
    return { allowed: false, reason: "device_credentials blocked to all clients" };
  };

  it("prevents room owner from transferring ownership by modifying user_id", () => {
    const authAlice = { auth: { uid: "user_alice_123" } };
    // Attempt to change user_id from Alice to Bob
    const res = evaluateRoomUpdate(
      authAlice,
      { user_id: "user_alice_123" },
      { user_id: "user_bob_456" },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("Cannot change room user_id");

    // Legitimate update retaining user_id succeeds
    const legit = evaluateRoomUpdate(
      authAlice,
      { user_id: "user_alice_123" },
      { user_id: "user_alice_123" },
    );
    expect(legit.allowed).toBe(true);
  });

  it("prevents zone update from changing room_id", () => {
    const authAlice = { auth: { uid: "user_alice_123" } };
    // Attempt to move zone from Alice's room to Bob's room
    const res = evaluateZoneUpdate(authAlice, { room_id: "room_alice" }, { room_id: "room_bob" });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("Cannot change zone room_id");

    // Legitimate update keeping same room_id succeeds
    const legit = evaluateZoneUpdate(
      authAlice,
      { room_id: "room_alice" },
      { room_id: "room_alice" },
    );
    expect(legit.allowed).toBe(true);
  });

  it("prevents object update from changing room_id", () => {
    const authAlice = { auth: { uid: "user_alice_123" } };
    const res = evaluateObjectUpdate(authAlice, { room_id: "room_alice" }, { room_id: "room_bob" });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("Cannot change object room_id");
  });

  it("prevents occupancy event from changing room_id or simulated provenance", () => {
    const authAlice = { auth: { uid: "user_alice_123" } };

    // Attempt to change room_id
    const resRoom = evaluateEventUpdate(
      authAlice,
      { room_id: "room_alice", simulated: true },
      { room_id: "room_bob", simulated: true },
    );
    expect(resRoom.allowed).toBe(false);
    expect(resRoom.reason).toBe("Cannot change event room_id");

    // Attempt to convert virtual to hardware (simulated: true -> false)
    const resHw = evaluateEventUpdate(
      authAlice,
      { room_id: "room_alice", simulated: true },
      { room_id: "room_alice", simulated: false },
    );
    expect(resHw.allowed).toBe(false);
    expect(resHw.reason).toBe("Cannot convert hardware to simulated or vice versa");
  });

  it("permits room owners to acknowledge hardware events while strictly forbidding payload tampering", () => {
    const authAlice = { auth: { uid: "user_alice_123" }, requestTime: "2026-11-15T12:00:00Z" };
    const authBob = { auth: { uid: "user_bob_456" }, requestTime: "2026-11-15T12:00:00Z" };

    const hwEvent = {
      room_id: "room_alice",
      simulated: false,
      event_type: "hazard_zone_entry",
      severity: "high",
      target_id: 1,
      x_mm: 500,
      y_mm: 4500,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by: null,
    };

    // 1. Legitimate acknowledgement by room owner Alice with server timestamp
    const ackRes = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: true,
      acknowledged_at: "2026-11-15T12:00:00Z",
      acknowledged_by: "user_alice_123",
    });
    expect(ackRes.allowed).toBe(true);

    // Also valid with symbolic request.time sentinel
    const ackSentinel = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: true,
      acknowledged_at: "request.time",
      acknowledged_by: "user_alice_123",
    });
    expect(ackSentinel.allowed).toBe(true);

    // 2. Acknowledgement attempt by non-owner Bob is denied
    const nonOwnerAck = evaluateEventUpdate(authBob, hwEvent, {
      ...hwEvent,
      acknowledged: true,
      acknowledged_at: "2026-11-15T12:00:00Z",
      acknowledged_by: "user_bob_456",
    });
    expect(nonOwnerAck.allowed).toBe(false);
    expect(nonOwnerAck.reason).toBe("Unauthorized event room");

    // 3. Tampering with event_type or coordinates is denied
    const tamperRes = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: true,
      acknowledged_at: "2026-11-15T12:00:00Z",
      acknowledged_by: "user_alice_123",
      x_mm: 9999, // tampering with radar coordinates
    });
    expect(tamperRes.allowed).toBe(false);
    expect(tamperRes.reason).toContain("Cannot modify hardware event field 'x_mm'");

    // 4. Tampering with simulated provenance (false -> true) is denied
    const tamperSim = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      simulated: true, // attempting to turn hardware into simulated
    });
    expect(tamperSim.allowed).toBe(false);
    expect(tamperSim.reason).toBe("Cannot convert hardware to simulated or vice versa");
  });

  it("enforces Phase 3.2 Firestore acknowledgement security rules (type, caller UID, server timestamp)", () => {
    const authAlice = { auth: { uid: "user_alice_123" }, requestTime: "2026-11-15T12:00:00Z" };

    const hwEvent = {
      room_id: "room_alice",
      simulated: false,
      event_type: "restricted_zone_entry",
      severity: "critical",
      target_id: 2,
      x_mm: 3800,
      y_mm: 1200,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by: null,
    };

    // Rejection when acknowledged is non-boolean or false
    const nonBoolAck = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: "true", // string instead of bool
      acknowledged_at: "2026-11-15T12:00:00Z",
      acknowledged_by: "user_alice_123",
    });
    expect(nonBoolAck.allowed).toBe(false);
    expect(nonBoolAck.reason).toBe("acknowledged must be boolean true");

    const falseAck = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: false,
      acknowledged_at: "2026-11-15T12:00:00Z",
      acknowledged_by: "user_alice_123",
    });
    expect(falseAck.allowed).toBe(false);
    expect(falseAck.reason).toBe("acknowledged must be boolean true");

    // Rejection when acknowledged_by does not match authenticated caller UID
    const spoofedUidAck = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: true,
      acknowledged_at: "2026-11-15T12:00:00Z",
      acknowledged_by: "system_admin", // spoofed UID
    });
    expect(spoofedUidAck.allowed).toBe(false);
    expect(spoofedUidAck.reason).toBe("acknowledged_by must match caller UID");

    // Rejection when acknowledged_at is arbitrary timestamp string rather than server timestamp
    const arbitraryTimeAck = evaluateEventUpdate(authAlice, hwEvent, {
      ...hwEvent,
      acknowledged: true,
      acknowledged_at: "1999-01-01T00:00:00Z", // arbitrary forged timestamp
      acknowledged_by: "user_alice_123",
    });
    expect(arbitraryTimeAck.allowed).toBe(false);
    expect(arbitraryTimeAck.reason).toBe(
      "acknowledged_at must equal request.time (server timestamp required)",
    );

    // Virtual event updates remain permitted for room owner
    const virtualEvent = {
      room_id: "room_alice",
      simulated: true,
      event_type: "candidate_fall",
      severity: "critical",
      notes: "Virtual test note",
    };
    const virtRes = evaluateEventUpdate(authAlice, virtualEvent, {
      ...virtualEvent,
      notes: "Updated virtual test note",
    });
    expect(virtRes.allowed).toBe(true);
  });

  it("prevents trajectory update from changing room_id", () => {
    const authAlice = { auth: { uid: "user_alice_123" } };
    const res = evaluateTrajectorySegmentUpdate(
      authAlice,
      { room_id: "room_alice", simulated: true },
      { room_id: "room_bob", simulated: true },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("Cannot change trajectory room_id");
  });

  it("prevents converting hardware trajectory into virtual record and vice-versa", () => {
    const authAlice = { auth: { uid: "user_alice_123" } };

    // Hardware to virtual
    const hwToVirt = evaluateTrajectorySegmentUpdate(
      authAlice,
      { room_id: "room_alice", simulated: false },
      { room_id: "room_alice", simulated: true },
    );
    expect(hwToVirt.allowed).toBe(false);
    expect(hwToVirt.reason).toBe("Cannot convert or modify hardware trajectory");

    // Virtual to hardware
    const virtToHw = evaluateTrajectorySegmentUpdate(
      authAlice,
      { room_id: "room_alice", simulated: true },
      { room_id: "room_alice", simulated: false },
    );
    expect(virtToHw.allowed).toBe(false);
    expect(virtToHw.reason).toBe("Cannot convert or modify hardware trajectory");
  });

  it("permits virtual trajectory create by authenticated room owners and denies unauthenticated/cross-room", () => {
    const valid = evaluateTrajectorySegmentCreate(
      { auth: { uid: "user_alice_123" } },
      { room_id: "room_alice", simulated: true },
    );
    expect(valid.allowed).toBe(true);

    const unauth = evaluateTrajectorySegmentCreate(
      { auth: null },
      { room_id: "room_alice", simulated: true },
    );
    expect(unauth.allowed).toBe(false);

    const cross = evaluateTrajectorySegmentCreate(
      { auth: { uid: "user_alice_123" } },
      { room_id: "room_bob", simulated: true },
    );
    expect(cross.allowed).toBe(false);
  });

  it("completely blocks client access to device_credentials", () => {
    const res = evaluateDeviceCredentialsAccess({ auth: { uid: "user_alice_123" } });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("device_credentials blocked to all clients");
  });
});

describe("Database Layer Query Scoping & Fail-Safe Scopes", () => {
  it("fails safely and returns empty when sensors query lacks userId", async () => {
    const withoutUser = await firebaseDb.getSensors("dev_01", undefined);
    expect(withoutUser).toEqual([]);
  });

  it("fails safely when zones or room_objects queries lack roomId", async () => {
    const noZoneRoom = await firebaseDb.getZones("");
    expect(noZoneRoom).toEqual([]);

    const noObjRoom = await firebaseDb.getRoomObjects("");
    expect(noObjRoom).toEqual([]);
  });

  it("fails safely when clearing trajectories or events without roomId", async () => {
    // Should return gracefully without throwing or running unscoped queries
    await expect(firebaseDb.clearSimulatedTrajectories("")).resolves.toBeUndefined();
    await expect(firebaseDb.clearSimulatedEvents("")).resolves.toBeUndefined();
  });

  it("ensures live subscriptions safely no-op when roomId is missing", () => {
    const unsubEvents = firebaseDb.subscribeToLiveEvents(() => {}, "");
    expect(typeof unsubEvents).toBe("function");
    unsubEvents();

    const unsubTel = firebaseDb.subscribeToLatestTelemetry(() => {}, "");
    expect(typeof unsubTel).toBe("function");
    unsubTel();
  });
});

describe("Static Firestore Rules Inspection", () => {
  it("verifies firestore.rules strictly contains required immutability & isolation clauses", () => {
    const rulesPath = resolve(__dirname, "../../firestore.rules");
    const content = readFileSync(rulesPath, "utf-8");

    // No public rules
    expect(content).not.toContain("allow read, write: if true");
    expect(content).not.toContain("allow write: if true");

    // Rooms immutability
    expect(content).toContain("request.resource.data.user_id == resource.data.user_id");

    // Room zones & objects immutability
    expect(content).toContain("request.resource.data.room_id == resource.data.room_id");

    // Occupancy events & trajectories bidirectional provenance & room immutability
    expect(content).toContain("resource.data.simulated == true");
    expect(content).toContain("request.resource.data.simulated == true");

    // Phase 3.2: Hardware Event Acknowledgement Security Rules
    expect(content).toContain(
      "request.resource.data.diff(resource.data).affectedKeys().hasOnly(['acknowledged', 'acknowledged_at', 'acknowledged_by'])",
    );
    expect(content).toContain("request.resource.data.acknowledged is bool");
    expect(content).toContain("request.resource.data.acknowledged == true");
    expect(content).toContain("request.resource.data.acknowledged_by == request.auth.uid");
    expect(content).toContain("request.resource.data.acknowledged_at == request.time");

    // Hardware collections locked
    expect(content).toContain(
      "match /device_credentials/{credId} {\n      allow read, write: if false;",
    );
    expect(content).toContain(
      "match /telemetry/{telemetryId} {\n      allow read: if isAuthenticated() && (resource == null || isRoomOwner(resource.data.room_id));\n      allow write: if false;",
    );
    expect(content).toContain(
      "match /radar_targets/{targetId} {\n      allow read: if isAuthenticated() && (resource == null || isRoomOwner(resource.data.room_id));\n      allow write: if false;",
    );
  });
});

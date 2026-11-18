import { describe, expect, it } from "vitest";
import { RD61Tracker } from "@/lib/radar/rd61-tracker";
import { firebaseDb } from "@/lib/firebase/db";
import type { EventType, RD61Frame, RD61Point } from "@/lib/radar/types";

describe("RD-61 Point-Cloud Tracker", () => {
  const room = { id: "room-test-1", name: "Radar Lab 01" };

  const createPoint = (
    x_mm: number,
    y_mm: number,
    snr = 15.0,
    doppler = 0,
    z_mm = 1000,
  ): RD61Point => ({
    x_mm,
    y_mm,
    z_mm,
    doppler,
    snr,
  });

  const createCluster = (
    cx: number,
    cy: number,
    count = 10,
    snr = 16.0,
    doppler = 0,
  ): RD61Point[] => {
    const pts: RD61Point[] = [];
    for (let i = 0; i < count; i++) {
      pts.push(createPoint(cx + (i % 3) * 50, cy + Math.floor(i / 3) * 50, snr, doppler));
    }
    return pts;
  };

  it("filters out low-SNR clutter points (< 7.5 dB)", () => {
    const tracker = new RD61Tracker({ snrThreshold: 7.5, minPointsPerCluster: 3 });
    // 5 clutter points with SNR 3-5 dB
    const clutter: RD61Point[] = [
      createPoint(100, 1000, 3.5),
      createPoint(120, 1020, 4.0),
      createPoint(140, 1010, 5.2),
      createPoint(150, 1050, 2.1),
    ];
    const clusters = tracker.clusterPoints(clutter);
    expect(clusters.length).toBe(0);
  });

  it("clusters points into distinct human target centroids", () => {
    const tracker = new RD61Tracker();
    // 2 clusters: Person A at (200, 1500), Person B at (-1000, 3000)
    const points: RD61Point[] = [
      ...createCluster(200, 1500, 8, 14.5),
      ...createCluster(-1000, 3000, 8, 18.0),
    ];
    const clusters = tracker.clusterPoints(points);
    expect(clusters.length).toBe(2);
    // Find person near 200, 1500
    const a = clusters.find((c) => Math.abs(c.x_mm - 250) < 150);
    const b = clusters.find((c) => Math.abs(c.x_mm - -950) < 150);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.pointCount).toBe(8);
  });

  it("verifies BFS visited handling: starting point is not duplicated and points are processed exactly once", () => {
    const tracker = new RD61Tracker({ clusterDistance: 200, minPointsPerCluster: 3 });
    // 4 points in a tight line: p0 at 0, p1 at 50, p2 at 100, p3 at 150
    const points: RD61Point[] = [
      createPoint(0, 1000, 15.0),
      createPoint(50, 1000, 15.0),
      createPoint(100, 1000, 15.0),
      createPoint(150, 1000, 15.0),
    ];
    const clusters = tracker.clusterPoints(points);
    expect(clusters.length).toBe(1);
    // Exact count must be 4: starting point must not be re-added, neighbours must not be re-added
    expect(clusters[0]!.pointCount).toBe(4);
  });

  it("calculates exact mathematical centroid and averages for X, Y, Z, Doppler, and SNR", () => {
    const tracker = new RD61Tracker({ clusterDistance: 500, minPointsPerCluster: 3 });
    const points: RD61Point[] = [
      { x_mm: 100, y_mm: 1000, z_mm: 800, doppler: 0.3, snr: 12.0 },
      { x_mm: 200, y_mm: 1100, z_mm: 900, doppler: 0.45, snr: 15.5 },
      { x_mm: 300, y_mm: 1200, z_mm: 1000, doppler: 0.6, snr: 18.2 },
    ];
    const clusters = tracker.clusterPoints(points);
    expect(clusters.length).toBe(1);
    const c = clusters[0]!;

    // (100 + 200 + 300) / 3 = 200
    expect(c.x_mm).toBe(200);
    // (1000 + 1100 + 1200) / 3 = 1100
    expect(c.y_mm).toBe(1100);
    // (800 + 900 + 1000) / 3 = 900
    expect(c.z_mm).toBe(900);
    // (0.30 + 0.45 + 0.60) / 3 = 0.45
    expect(c.avgDoppler).toBe(0.45);
    // (12.0 + 15.5 + 18.2) / 3 = 45.7 / 3 = 15.2333... -> 15.2
    expect(c.avgSnr).toBe(15.2);
    expect(c.pointCount).toBe(3);
  });

  it("handles isolated points below threshold without creating phantom clusters", () => {
    const tracker = new RD61Tracker({ clusterDistance: 300, minPointsPerCluster: 3 });
    // 2 isolated points (too far from each other and < 3) + 1 valid cluster of 3 points
    const points: RD61Point[] = [
      createPoint(-3000, 1000, 15.0), // Isolated 1
      createPoint(3000, 1000, 15.0), // Isolated 2
      createPoint(0, 2000, 15.0), // Cluster pt 1
      createPoint(50, 2050, 15.0), // Cluster pt 2
      createPoint(-50, 2050, 15.0), // Cluster pt 3
    ];
    const clusters = tracker.clusterPoints(points);
    // Only the valid 3-point cluster should be returned
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.pointCount).toBe(3);
    expect(clusters[0]!.y_mm).toBe(2033); // (2000 + 2050 + 2050) / 3 = 2033.33 -> 2033
  });

  it("generates target_detected and room_occupied events with sensor_type: rd61", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 2 });
    const events: {
      type: EventType;
      desc: string;
      target_id?: number | undefined;
      sensorType?: string | null | undefined;
    }[] = [];

    const emit = (
      _r: { id: string; name: string },
      type: EventType,
      desc: string,
      target_id?: number | undefined,
      sensorType?: "ld2450" | "rd61" | null | undefined,
    ) => {
      events.push({ type, desc, target_id, sensorType });
    };

    const frame1: RD61Frame = {
      sensor_type: "rd61",
      origin: "simulated",
      room_id: room.id,
      timestamp: 1000,
      points: createCluster(0, 2000, 12, 16.0),
    };

    // Frame 1: Tentative track
    tracker.processFrame(frame1, room, emit);
    expect(events.length).toBe(0); // Needs confirmation frame

    // Frame 2: Confirmed track
    const frame2: RD61Frame = {
      ...frame1,
      timestamp: 1150,
    };
    tracker.processFrame(frame2, room, emit);

    const detected = events.find((e) => e.type === "target_detected");
    const occupied = events.find((e) => e.type === "room_occupied");

    expect(detected).toBeDefined();
    expect(detected!.sensorType).toBe("rd61");
    expect(detected!.target_id).toBe(1);
    expect(detected!.desc).toContain("RD-61 detected cluster #1");

    expect(occupied).toBeDefined();
    expect(occupied!.sensorType).toBe("rd61");
    expect(occupied!.desc).toContain("occupied (RD-61 point-cloud detection)");
  });

  it("prevents duplicate events across identical successive frames", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1 });
    const events: { type: EventType }[] = [];

    const emit = (_r: unknown, type: EventType) => {
      events.push({ type });
    };

    const points = createCluster(0, 1800, 10, 15.0);

    // Run 20 frames with stationary target
    for (let i = 0; i < 20; i++) {
      tracker.processFrame(
        {
          sensor_type: "rd61",
          origin: "simulated",
          room_id: room.id,
          timestamp: 1000 + i * 150,
          points,
        },
        room,
        emit,
      );
    }

    // target_detected and room_occupied should each be emitted EXACTLY ONCE
    const detected = events.filter((e) => e.type === "target_detected");
    const occupied = events.filter((e) => e.type === "room_occupied");

    expect(detected.length).toBe(1);
    expect(occupied.length).toBe(1);
  });

  it("rate limits target_moved events to avoid spamming", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1, moveCooldownMs: 30000 });
    const events: { type: EventType; desc: string }[] = [];

    const emit = (_r: unknown, type: EventType, desc: string) => {
      events.push({ type, desc });
    };

    // Frame 1: Detected while moving at 0.8 m/s
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: createCluster(0, 1800, 10, 15.0, 0.8),
      },
      room,
      emit,
    );

    // Frame 2 at 1150ms: Still moving fast (within cooldown)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: createCluster(50, 1850, 10, 15.0, 0.8),
      },
      room,
      emit,
    );

    const moves = events.filter((e) => e.type === "target_moved");
    expect(moves.length).toBe(1); // Only 1 move event within 30s cooldown

    // Advance 31 seconds
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 32000,
        points: createCluster(100, 1900, 10, 15.0, 0.8),
      },
      room,
      emit,
    );

    const movesAfterCooldown = events.filter((e) => e.type === "target_moved");
    expect(movesAfterCooldown.length).toBe(2);
  });

  it("emits target_lost and room_vacant when cluster disappears", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1, lostTimeoutMs: 1000 });
    const events: { type: EventType; desc: string }[] = [];

    const emit = (_r: unknown, type: EventType, desc: string) => {
      events.push({ type, desc });
    };

    // Target active at t=0
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 0,
        points: createCluster(0, 2000, 10),
      },
      room,
      emit,
    );

    // Target disappears: empty frames
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 500,
        points: [],
      },
      room,
      emit,
    );

    // Frame after lostTimeoutMs (1500 > 1000)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1500,
        points: [],
      },
      room,
      emit,
    );

    // After debounce buffer (800ms)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 2400,
        points: [],
      },
      room,
      emit,
    );

    const lost = events.find((e) => e.type === "target_lost");
    const vacant = events.find((e) => e.type === "room_vacant");

    expect(lost).toBeDefined();
    expect(lost!.desc).toContain("RD-61 cluster #1 left detection field");
    expect(vacant).toBeDefined();
    expect(vacant!.desc).toContain("vacant (RD-61 point cloud clear)");
  });

  it("records and filters events correctly by sensor_type in database layer", async () => {
    // Record simulated LD2450 and RD-61 events
    const ts = new Date().toISOString();
    await firebaseDb.recordEvent({
      room_id: room.id,
      event_type: "target_detected",
      description: "LD2450 target 1 detected",
      target_id: 1,
      sensor_type: "ld2450",
      simulated: true,
      timestamp: ts,
    });

    await firebaseDb.recordEvent({
      room_id: room.id,
      event_type: "target_detected",
      description: "RD-61 cluster #1 detected",
      target_id: 1,
      sensor_type: "rd61",
      simulated: true,
      timestamp: ts,
    });

    // Query all events
    const all = await firebaseDb.getEvents({ roomId: room.id });
    expect(all.rows.length).toBeGreaterThanOrEqual(2);

    // Filter strictly by RD-61
    const rd61Only = await firebaseDb.getEvents({ roomId: room.id, sensorType: "rd61" });
    expect(rd61Only.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rd61Only.rows) {
      expect(r.sensor_type).toBe("rd61");
    }

    // Filter strictly by LD2450
    const ldOnly = await firebaseDb.getEvents({ roomId: room.id, sensorType: "ld2450" });
    expect(ldOnly.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of ldOnly.rows) {
      expect(r.sensor_type).toBe("ld2450");
    }
  });

  it("maintains stable track IDs when targets move continuously", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1 });
    const events: { type: EventType; desc: string; target_id?: number | undefined }[] = [];
    const emit = (_r: unknown, type: EventType, desc: string, target_id?: number) => {
      events.push({ type, desc, target_id });
    };

    // Frame 1: Target at (0, 1000)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: createCluster(0, 1000, 5),
      },
      room,
      emit,
    );

    // Frame 2: Target moves to (100, 1050)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: createCluster(100, 1050, 5),
      },
      room,
      emit,
    );

    // Frame 3: Target moves to (200, 1100)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1300,
        points: createCluster(200, 1100, 5),
      },
      room,
      emit,
    );

    const detections = events.filter((e) => e.type === "target_detected");
    expect(detections.length).toBe(1);
    expect(detections[0]?.target_id).toBe(1);

    const tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(1);
    expect(tracks[0]?.id).toBe(1);
  });

  it("prevents nearby targets from accidentally swapping IDs using distance-sorted matching", () => {
    const tracker = new RD61Tracker({
      confirmationFrames: 1,
      clusterDistance: 150,
      trackMatchDistance: 800,
    });
    const events: { type: EventType; target_id?: number | undefined }[] = [];
    const emit = (_r: unknown, type: EventType, _d: string, target_id?: number) => {
      events.push({ type, target_id });
    };

    // Frame 1: Target 1 at (0, 1000), Target 2 at (600, 1000)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: [...createCluster(0, 1000, 4), ...createCluster(600, 1000, 4)],
      },
      room,
      emit,
    );

    let tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(2);
    const t1 = tracks.find((t) => t.x_mm < 200);
    const t2 = tracks.find((t) => t.x_mm > 400);
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    const id1 = t1!.id;
    const id2 = t2!.id;

    // Frame 2:
    // Target 1 moves to 250 (dist to T1 is ~225, dist to T2 is ~375)
    // Target 2 moves to 580 (dist to T2 is ~20, dist to T1 is ~555)
    // Distance-sorted matching matches C2-T2 (dist ~20) first, ensuring C1 matches T1
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: [...createCluster(250, 1000, 4), ...createCluster(580, 1000, 4)],
      },
      room,
      emit,
    );

    tracks = tracker.getConfirmedTracks();
    const currentT1 = tracks.find((t) => t.id === id1);
    const currentT2 = tracks.find((t) => t.id === id2);

    expect(currentT1).toBeDefined();
    expect(currentT2).toBeDefined();
    // T1 should still be to the left of T2 without swapping
    expect(currentT1!.x_mm).toBeLessThan(currentT2!.x_mm);
  });

  it("safely allocates track IDs beyond 9 without collisions or overwriting track 1", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1 });
    const events: { type: EventType; target_id?: number | undefined }[] = [];
    const emit = (_r: unknown, type: EventType, _d: string, target_id?: number) => {
      events.push({ type, target_id });
    };

    // 10 distinct, widely spaced clusters
    const points: RD61Point[] = [];
    for (let i = 0; i < 10; i++) {
      points.push(...createCluster(i * 1000 - 4500, 2000, 4));
    }

    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points,
      },
      room,
      emit,
    );

    const tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(10);
    const ids = tracks.map((t) => t.id);
    const uniqueIds = new Set(ids);
    // Every track must have a distinct ID (no clobbered tracks)
    expect(uniqueIds.size).toBe(10);
    expect(uniqueIds.has(1)).toBe(true);
    expect(uniqueIds.has(10)).toBe(true);
  });

  it("handles confirmationFrames thresholds and prunes unconfirmed tentative tracks without target_lost", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 3, lostTimeoutMs: 500 });
    const events: { type: EventType; desc: string }[] = [];
    const emit = (_r: unknown, type: EventType, desc: string) => {
      events.push({ type, desc });
    };

    // Frame 1: Tentative (seen 1)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "target_detected").length).toBe(0);

    // Frame 2: Tentative (seen 2)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1100,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "target_detected").length).toBe(0);

    // Frame 3: Confirmed (seen 3 >= 3)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1200,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "target_detected").length).toBe(1);

    // Spurious noise cluster at (3000, 3000) that vanishes before confirmation
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1300,
        points: [...createCluster(0, 1500, 5), ...createCluster(3000, 3000, 5)],
      },
      room,
      emit,
    );

    // After timeout, noise cluster disappears
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 2000,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );

    // There should be NO target_lost for the unconfirmed noise cluster
    const lostEvents = events.filter((e) => e.type === "target_lost");
    expect(lostEvents.length).toBe(0);
  });

  it("does not prematurely lose targets during brief missing frames", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1, lostTimeoutMs: 1200 });
    const events: { type: EventType }[] = [];
    const emit = (_r: unknown, type: EventType) => {
      events.push({ type });
    };

    // Frame 1 at t=0
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 0,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );

    // Frame 2 at t=150: dropped (empty)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 150,
        points: [],
      },
      room,
      emit,
    );

    // Frame 3 at t=300: dropped (empty)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 300,
        points: [],
      },
      room,
      emit,
    );

    // No target_lost should have been emitted
    expect(events.filter((e) => e.type === "target_lost").length).toBe(0);

    // Frame 4 at t=450: target reappears
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 450,
        points: createCluster(10, 1510, 5),
      },
      room,
      emit,
    );

    // Still only 1 target_detected (track was preserved)
    expect(events.filter((e) => e.type === "target_detected").length).toBe(1);
    expect(events.filter((e) => e.type === "target_lost").length).toBe(0);
  });

  it("aborts vacancy debounce if a target returns before debounce expires", () => {
    const tracker = new RD61Tracker({
      confirmationFrames: 1,
      lostTimeoutMs: 500,
      vacancyDebounceMs: 800,
    });
    const events: { type: EventType }[] = [];
    const emit = (_r: unknown, type: EventType) => {
      events.push({ type });
    };

    // Target active at t=0
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 0,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "room_occupied").length).toBe(1);

    // Target leaves; at t=600 track expires (600 - 0 = 600 > 500)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 600,
        points: [],
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "target_lost").length).toBe(1);
    // Vacancy buffer started at t=600

    // At t=1000 (400ms into 800ms debounce buffer), target returns!
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );

    // At t=1500, target still active
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1500,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );

    // room_vacant must NEVER have fired
    expect(events.filter((e) => e.type === "room_vacant").length).toBe(0);
  });

  it("clears all internal tracker state on reset()", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1 });
    const events: { type: EventType; desc: string; sensorType?: string | null | undefined }[] = [];
    const emit = (
      _r: unknown,
      type: EventType,
      desc: string,
      _id?: number,
      sensorType?: "ld2450" | "rd61" | null,
    ) => {
      events.push({ type, desc, sensorType });
    };

    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: createCluster(0, 1500, 6),
      },
      room,
      emit,
    );
    expect(tracker.getConfirmedTracks().length).toBe(1);

    // Reset tracker
    tracker.reset();
    expect(tracker.getConfirmedTracks().length).toBe(0);

    // Process frame again: should re-detect track with ID 1 and re-emit room_occupied
    events.length = 0;
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 5000,
        points: createCluster(500, 1500, 6),
      },
      room,
      emit,
    );

    const detected = events.find((e) => e.type === "target_detected");
    const occupied = events.find((e) => e.type === "room_occupied");
    expect(detected).toBeDefined();
    expect(detected?.desc).toContain("cluster #1");
    expect(occupied).toBeDefined();
  });

  it("handles two targets crossing paths without swapping IDs", () => {
    const tracker = new RD61Tracker({
      confirmationFrames: 1,
      clusterDistance: 200,
      trackMatchDistance: 600,
    });
    const emit = () => {};

    // Target 1 moving along y=1500 from x=-300 to +300
    // Target 2 moving along y=2500 from x=+300 to -300
    // They cross at x=0 with 1000mm y-separation (never merging clusters)
    const steps = [
      { t1x: -300, t2x: 300 },
      { t1x: -150, t2x: 150 },
      { t1x: 0, t2x: 0 },
      { t1x: 150, t2x: -150 },
      { t1x: 300, t2x: -300 },
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      tracker.processFrame(
        {
          sensor_type: "rd61",
          origin: "simulated",
          room_id: room.id,
          timestamp: 1000 + i * 150,
          points: [...createCluster(step.t1x, 1500, 4), ...createCluster(step.t2x, 2500, 4)],
        },
        room,
        emit,
      );
    }

    const tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(2);
    const trackT1 = tracks.find((t) => Math.abs(t.y_mm - 1500) < 300);
    const trackT2 = tracks.find((t) => Math.abs(t.y_mm - 2500) < 300);

    expect(trackT1).toBeDefined();
    expect(trackT2).toBeDefined();
    // Track 1 should be at +x, Track 2 should be at -x (no swapping happened across intersection)
    expect(trackT1!.id).toBe(1);
    expect(trackT2!.id).toBe(2);
    expect(trackT1!.x_mm).toBeGreaterThan(150);
    expect(trackT2!.x_mm).toBeLessThan(-150);
  });

  it("handles three targets moving close together simultaneously", () => {
    const tracker = new RD61Tracker({
      confirmationFrames: 1,
      clusterDistance: 150,
      trackMatchDistance: 500,
    });
    const emit = () => {};

    // Frame 1
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: [
          ...createCluster(0, 1500, 4),
          ...createCluster(350, 2000, 4),
          ...createCluster(700, 1500, 4),
        ],
      },
      room,
      emit,
    );

    let tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(3);

    // Frame 2: each moves by (40, 40)
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: [
          ...createCluster(40, 1540, 4),
          ...createCluster(390, 2040, 4),
          ...createCluster(740, 1540, 4),
        ],
      },
      room,
      emit,
    );

    tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(3);
    const ids = tracks.map((t) => t.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("correctly resolves two clusters competing for one track, awarding track to the closer cluster", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1, trackMatchDistance: 750 });
    const events: { type: EventType; desc: string; target_id?: number | undefined }[] = [];
    const emit = (_r: unknown, type: EventType, desc: string, target_id?: number) => {
      events.push({ type, desc, target_id });
    };

    // Frame 1: Single target at (0, 1500) -> Track 1
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: createCluster(0, 1500, 5),
      },
      room,
      emit,
    );

    // Frame 2: Two distinct clusters competing for Track 1.
    // Cluster B at (-600, 1500) is placed FIRST in the points array (dist 600 <= 750).
    // Cluster A at (300, 1500) is placed SECOND (dist 300 <= 750).
    // Cluster A and B are 900mm apart (> 550mm clusterDistance, so 2 distinct clusters).
    // Cluster A is physically closer to Track 1 (dist 300 vs 600).
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: [...createCluster(-600, 1500, 5), ...createCluster(300, 1500, 5)],
      },
      room,
      emit,
    );

    const tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(2);

    const track1 = tracks.find((t) => t.id === 1);
    const track2 = tracks.find((t) => t.id === 2);
    expect(track1).toBeDefined();
    expect(track2).toBeDefined();

    // Track 1 must have matched Cluster A (closer at +300) -> smoothed x around +200..+250
    // Track 2 was spawned for the farther Cluster B -> x around -600
    expect(track1!.x_mm).toBeGreaterThan(100);
    expect(track2!.x_mm).toBeLessThan(-400);
  });

  it("remains invariant to cluster ordering changes between frames", () => {
    const tracker = new RD61Tracker({
      confirmationFrames: 1,
      clusterDistance: 150,
      trackMatchDistance: 600,
    });
    const emit = () => {};

    // Frame 1: C1 at (-300, 1500), C2 at (+300, 1500) in order [C1, C2]
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: [...createCluster(-300, 1500, 4), ...createCluster(300, 1500, 4)],
      },
      room,
      emit,
    );

    // Frame 2: reverse order [C2, C1]
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: [...createCluster(320, 1500, 4), ...createCluster(-280, 1500, 4)],
      },
      room,
      emit,
    );

    const tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(2);
    const t1 = tracks.find((t) => t.id === 1);
    const t2 = tracks.find((t) => t.id === 2);
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();

    // Track 1 must remain the negative-x target and Track 2 the positive-x target
    expect(t1!.x_mm).toBeLessThan(0);
    expect(t2!.x_mm).toBeGreaterThan(0);
  });

  it("handles one target disappearing while another remains active without state leak", () => {
    const tracker = new RD61Tracker({
      confirmationFrames: 1,
      lostTimeoutMs: 1000,
      vacancyDebounceMs: 500,
    });
    const events: { type: EventType; target_id?: number | undefined }[] = [];
    const emit = (_r: unknown, type: EventType, _d: string, target_id?: number) => {
      events.push({ type, target_id });
    };

    // Frame 1: Two targets
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points: [...createCluster(0, 1500, 4), ...createCluster(1000, 2000, 4)],
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "room_occupied").length).toBe(1);

    // Frame 2 at t=1150: Target 1 disappears, Target 2 remains
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1150,
        points: createCluster(1020, 2010, 4),
      },
      room,
      emit,
    );
    expect(events.filter((e) => e.type === "target_lost").length).toBe(0);

    // Frame 3 at t=2300 (2300 - 1000 = 1300 > 1000 lostTimeoutMs): Target 1 is purged
    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 2300,
        points: createCluster(1040, 2020, 4),
      },
      room,
      emit,
    );

    const lost = events.filter((e) => e.type === "target_lost");
    expect(lost.length).toBe(1);
    expect(lost[0]?.target_id).toBe(1);

    // Room must still be occupied because Target 2 is still active
    expect(events.filter((e) => e.type === "room_vacant").length).toBe(0);

    const tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(1);
    expect(tracks[0]?.id).toBe(2);
  });

  it("allocates sequential IDs, recycles freed IDs, and supports 10+ simultaneous tracks without collision", () => {
    const tracker = new RD61Tracker({ confirmationFrames: 1 });
    const emit = () => {};

    // Spawn 12 simultaneous distinct clusters
    const points: RD61Point[] = [];
    for (let i = 0; i < 12; i++) {
      points.push(...createCluster(i * 800 - 4500, 2000, 4));
    }

    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 1000,
        points,
      },
      room,
      emit,
    );

    let tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(12);
    const ids = tracks.map((t) => t.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // Now drop target 3 at t=3000 (3000 - 1000 > 1200 lostTimeoutMs)
    const pointsWithout3: RD61Point[] = [];
    for (let i = 0; i < 12; i++) {
      if (i === 2) continue; // Skip target 3
      pointsWithout3.push(...createCluster(i * 800 - 4500, 2000, 4));
    }

    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 3000,
        points: pointsWithout3,
      },
      room,
      emit,
    );

    tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(11);
    expect(tracks.find((t) => t.id === 3)).toBeUndefined();

    // Now spawn a new target: it should recycle the lowest available ID (3)
    const pointsWithNew: RD61Point[] = [
      ...pointsWithout3,
      ...createCluster(3000, 5000, 4), // new cluster
    ];

    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 3150,
        points: pointsWithNew,
      },
      room,
      emit,
    );

    tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(12);
    expect(tracks.find((t) => t.id === 3)).toBeDefined();

    // Reset tracker and verify allocator resets to 1
    tracker.reset();
    expect(tracker.getConfirmedTracks().length).toBe(0);

    tracker.processFrame(
      {
        sensor_type: "rd61",
        origin: "simulated",
        room_id: room.id,
        timestamp: 10000,
        points: createCluster(0, 1500, 4),
      },
      room,
      emit,
    );

    tracks = tracker.getConfirmedTracks();
    expect(tracks.length).toBe(1);
    expect(tracks[0]?.id).toBe(1);
  });
});

import type {
  Door,
  LD2450Frame,
  LD2450Target,
  RD61Frame,
  RD61Point,
  RoomObject,
  RoomZone,
} from "./types";

export type Scenario =
  | "empty"
  | "single"
  | "multiple"
  | "stationary"
  | "moving"
  | "entering"
  | "leaving"
  | "disconnect"
  | "restricted_entry"
  | "hazard_entry"
  | "unexpected_entry"
  | "prolonged_presence"
  | "candidate_fall";

export const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: "multiple", label: "Multiple targets", hint: "2–3 people walking" },
  { id: "single", label: "One target", hint: "A single person moving" },
  { id: "moving", label: "Moving targets", hint: "Fast, continuous walking" },
  { id: "stationary", label: "Stationary targets", hint: "People seated, micro-motion" },
  { id: "entering", label: "Target entering", hint: "Someone walks in from the door" },
  { id: "leaving", label: "Target leaving", hint: "Occupant walks out" },
  { id: "restricted_entry", label: "Restricted entry", hint: "Target walks into restricted zone" },
  { id: "hazard_entry", label: "Hazard zone dwell", hint: "Target enters hazard zone and stays" },
  { id: "unexpected_entry", label: "Unexpected door entry", hint: "Unrecognized entry at doorway" },
  {
    id: "prolonged_presence",
    label: "Prolonged presence",
    hint: "Excessive dwell without departure",
  },
  {
    id: "candidate_fall",
    label: "Candidate fall (exp.)",
    hint: "Sudden drop & inactivity on floor",
  },
  { id: "empty", label: "Empty room", hint: "No presence" },
  { id: "disconnect", label: "Sensor disconnection", hint: "Telemetry stops" },
];

interface Agent {
  id: number;
  x: number; // room coords, mm from left wall
  y: number; // mm from sensor wall
  tx: number;
  ty: number;
  speed: number; // mm/s
  pause: number; // s remaining
  leaving?: boolean;
  fallState?: "moving" | "fallen";
  fallTimer?: number;
}

export interface RoomGeometry {
  id: string;
  width_mm: number;
  length_mm: number;
  doors?: Door[] | undefined;
  zones?: RoomZone[] | undefined;
  objects?: RoomObject[] | undefined;
}

/** Seeded PRNG so a room's simulation is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Simulates one room: an LD2450 mounted at the centre of the y=0 wall and an RD-61 beside it.
 * The two outputs are produced independently — targets vs. a raw point cloud.
 */
export class RoomSimulator {
  agents: Agent[] = [];
  scenario: Scenario;
  connected = true;
  private rand: () => number;
  private nextId = 1;

  constructor(
    public room: RoomGeometry,
    scenario: Scenario = "multiple",
  ) {
    this.rand = mulberry32(hash(room.id));
    this.scenario = scenario;
    this.setScenario(scenario);
  }

  setScenario(s: Scenario) {
    this.scenario = s;
    this.agents = [];
    this.nextId = 1;
    this.connected = s !== "disconnect";

    if (s === "empty" || s === "disconnect") return;

    if (s === "entering" || s === "unexpected_entry") {
      this.spawn(true);
      return;
    }

    if (s === "leaving") {
      this.spawn(false);
      const a = this.agents[0];
      if (a) this.sendToDoor(a);
      return;
    }

    if (s === "restricted_entry") {
      // Find a restricted zone if defined, or use top-left corner
      const rz = this.room.zones?.find((z) => z.type === "restricted");
      let targetX = 600;
      let targetY = 800;
      if (rz && rz.polygon && rz.polygon.length > 0) {
        targetX = Math.round(rz.polygon.reduce((sum, p) => sum + p.x_mm, 0) / rz.polygon.length);
        targetY = Math.round(rz.polygon.reduce((sum, p) => sum + p.y_mm, 0) / rz.polygon.length);
      }
      // Start in centre of room
      this.agents.push({
        id: this.nextId++,
        x: this.room.width_mm / 2,
        y: this.room.length_mm / 2,
        tx: targetX,
        ty: targetY,
        speed: 700,
        pause: 0,
      });
      return;
    }

    if (s === "hazard_entry") {
      // Find a hazard zone if defined, or use bottom-right corner
      const hz = this.room.zones?.find((z) => z.type === "hazard");
      let targetX = this.room.width_mm - 600;
      let targetY = this.room.length_mm - 700;
      if (hz && hz.polygon && hz.polygon.length > 0) {
        targetX = Math.round(hz.polygon.reduce((sum, p) => sum + p.x_mm, 0) / hz.polygon.length);
        targetY = Math.round(hz.polygon.reduce((sum, p) => sum + p.y_mm, 0) / hz.polygon.length);
      }
      this.agents.push({
        id: this.nextId++,
        x: this.room.width_mm / 2,
        y: this.room.length_mm / 2,
        tx: targetX,
        ty: targetY,
        speed: 750,
        pause: 0,
      });
      return;
    }

    if (s === "prolonged_presence") {
      this.agents.push({
        id: this.nextId++,
        x: this.room.width_mm / 2,
        y: this.room.length_mm / 2,
        tx: this.room.width_mm / 2,
        ty: this.room.length_mm / 2,
        speed: 0,
        pause: 1e9,
      });
      return;
    }

    if (s === "candidate_fall") {
      // Start on open floor moving, then trigger rapid drop
      this.agents.push({
        id: this.nextId++,
        x: this.room.width_mm / 2,
        y: this.room.length_mm / 2 + 600,
        tx: this.room.width_mm / 2,
        ty: this.room.length_mm / 2,
        speed: 1400, // rapid walking/velocity spike
        pause: 0,
        fallState: "moving",
        fallTimer: 1.5,
      });
      return;
    }

    const n =
      {
        single: 1,
        multiple: 3,
        stationary: 2,
        moving: 2,
      }[s as "single" | "multiple" | "stationary" | "moving"] ?? 1;

    for (let i = 0; i < n; i++) this.spawn(false);
  }

  private door() {
    if (this.room.doors && this.room.doors.length > 0) {
      const d = this.room.doors[0];
      if (d) return { x: d.x_mm, y: d.y_mm };
    }
    return { x: this.room.width_mm - 300, y: this.room.length_mm - 200 };
  }

  private sendToDoor(a: Agent) {
    const d = this.door();
    a.tx = d.x;
    a.ty = d.y + 600;
    a.leaving = true;
    a.pause = 0;
  }

  private randomPoint() {
    const m = 400;
    return {
      x: m + this.rand() * (this.room.width_mm - 2 * m),
      y: 500 + this.rand() * (this.room.length_mm - 500 - m),
    };
  }

  private spawn(atDoor: boolean) {
    if (this.agents.length >= 3) return;
    const p = atDoor ? { x: this.door().x, y: this.room.length_mm - 50 } : this.randomPoint();
    const t = this.randomPoint();
    const stationary = this.scenario === "stationary";
    this.agents.push({
      id: this.nextId++,
      ...p,
      tx: stationary ? p.x : t.x,
      ty: stationary ? p.y : t.y,
      speed: this.scenario === "moving" ? 1100 + this.rand() * 400 : 500 + this.rand() * 500,
      pause: stationary ? 1e9 : 0,
    });
    if (this.nextId > 3) this.nextId = 1;
  }

  /** Advance simulated time by dt seconds. */
  step(dt: number) {
    for (const a of this.agents) {
      // Candidate fall scenario progression
      if (this.scenario === "candidate_fall") {
        if (a.fallState === "moving") {
          if (a.fallTimer !== undefined) {
            a.fallTimer -= dt;
            if (a.fallTimer <= 0) {
              a.fallState = "fallen";
              a.speed = 0;
              a.pause = 1e9; // motionless on floor
            }
          }
        }
      }

      if (a.pause > 0) {
        a.pause -= dt;
        // micro-motion while paused/seated/fallen
        a.x += (this.rand() - 0.5) * 4;
        a.y += (this.rand() - 0.5) * 4;
        continue;
      }

      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const d = Math.hypot(dx, dy);
      const stepLen = a.speed * dt;
      if (d <= stepLen) {
        a.x = a.tx;
        a.y = a.ty;
        if (this.scenario === "restricted_entry" || this.scenario === "hazard_entry") {
          // Stay inside the target zone once reached to trigger dwell
          a.pause = 1e9;
        } else if (!a.leaving) {
          a.pause = this.scenario === "moving" ? 0.2 : 1 + this.rand() * 4;
          const t = this.randomPoint();
          a.tx = t.x;
          a.ty = t.y;
        }
      } else {
        a.x += (dx / d) * stepLen;
        a.y += (dy / d) * stepLen;
      }
    }
    // remove agents that walked out
    this.agents = this.agents.filter((a) => !(a.leaving && a.y > this.room.length_mm));
    // occasional natural arrivals/departures in the multi scenario
    if (this.scenario === "multiple" && this.rand() < dt * 0.02) {
      if (this.agents.length < 3) this.spawn(true);
      else {
        const a = this.agents[Math.floor(this.rand() * this.agents.length)];
        if (a) this.sendToDoor(a);
      }
    }
  }

  /** Convert room coordinates to LD2450 sensor coordinates (sensor at wall centre). */
  ld2450Frame(now: number): LD2450Frame | null {
    if (!this.connected) return null;
    const cx = this.room.width_mm / 2;
    const targets: LD2450Target[] = this.agents
      .filter((a) => a.y >= 0 && a.y <= this.room.length_mm)
      .slice(0, 3)
      .map((a, i) => {
        const moving = a.pause <= 0 && a.speed > 0;
        const radial = moving
          ? ((a.ty - a.y) / (Math.hypot(a.tx - a.x, a.ty - a.y) || 1)) * a.speed
          : 0;
        return {
          target_id: a.id || i + 1,
          x_mm: Math.round(a.x - cx + (this.rand() - 0.5) * 40),
          y_mm: Math.round(Math.max(0, a.y + (this.rand() - 0.5) * 40)),
          speed_cms: Math.round(radial / 10),
        };
      });
    return {
      sensor_type: "ld2450",
      origin: "simulated",
      room_id: this.room.id,
      timestamp: now,
      targets,
    };
  }

  /** Synthetic point cloud: clusters of reflections around each body + sparse clutter. */
  rd61Frame(now: number): RD61Frame | null {
    if (!this.connected) return null;
    const cx = this.room.width_mm / 2;
    const points: RD61Point[] = [];
    for (const a of this.agents) {
      const moving = a.pause <= 0 && a.speed > 0;
      const isFallen = a.fallState === "fallen";
      const n = moving ? 14 + Math.floor(this.rand() * 10) : 4 + Math.floor(this.rand() * 4);
      for (let i = 0; i < n; i++) {
        const r = 120 + this.rand() * 180;
        const th = this.rand() * Math.PI * 2;
        // If fallen, reflection z is close to floor (150-350mm)
        const z = isFallen
          ? Math.round(150 + this.rand() * 200)
          : Math.round(200 + this.rand() * 1500);
        points.push({
          x_mm: Math.round(a.x - cx + Math.cos(th) * r * this.gauss()),
          y_mm: Math.round(a.y + Math.sin(th) * r * this.gauss()),
          z_mm: z,
          doppler: moving
            ? +((a.speed / 1000) * (0.6 + this.rand() * 0.6)).toFixed(2)
            : +((this.rand() - 0.5) * 0.1).toFixed(2),
          snr: +(8 + this.rand() * 18).toFixed(1),
        });
      }
    }
    const clutter = 2 + Math.floor(this.rand() * 4);
    for (let i = 0; i < clutter; i++) {
      points.push({
        x_mm: Math.round((this.rand() - 0.5) * this.room.width_mm),
        y_mm: Math.round(this.rand() * this.room.length_mm),
        z_mm: Math.round(this.rand() * 2200),
        doppler: 0,
        snr: +(2 + this.rand() * 5).toFixed(1),
      });
    }
    return {
      sensor_type: "rd61",
      origin: "simulated",
      room_id: this.room.id,
      timestamp: now,
      points,
    };
  }

  private gauss() {
    return Math.min(1.6, Math.abs((this.rand() + this.rand() + this.rand()) / 1.5 - 1) + 0.4);
  }
}

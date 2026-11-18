import type {
  AlertSeverity,
  EventEvidence,
  RoomZone,
  Door,
  TrajectorySegment,
  TrajectoryPoint,
} from "@/lib/radar/types";
import type { OccupancyEvent } from "@/lib/firebase/db";

/* =========================================================================
 * 1. Base Session & Event Types (Preserves Phase 1–3 compatibility)
 * ========================================================================= */

export interface Session {
  room_id: string;
  start: number;
  end: number;
  status?: "confirmed" | "censored_by_disconnect" | "open" | "censored_by_window";
}

export interface DetailedSession extends Session {
  durationMs: number;
  durationMinutes: number;
  open: boolean;
}

export interface OfflineInterval {
  room_id: string;
  start: number;
  end: number;
  reason: "sensor_disconnected" | "heartbeat_timeout";
}

/* =========================================================================
 * 2. Room Activity Analytics
 * ========================================================================= */

export interface ActivitySummary {
  totalOccupiedMs: number;
  totalVacantMs: number;
  offlineDurationMs: number;
  dataCoveragePct: number;
  utilisationPct: number;
  totalSessions: number;
  avgSessionDurationMinutes: number;
  medianSessionDurationMinutes: number;
  maxSessionDurationMinutes: number;
  totalTargetDetections: number;
  totalMovementEvents: number;
  uniqueTargetChannels: number[];
  durationsHistogram: { label: string; count: number; min: number; max: number }[];
}

export interface DailyActivitySummary {
  [key: string]: unknown;
  dateIso: string;
  label: string;
  dayOfWeek: string;
  occupiedMinutes: number;
  utilisationPct: number;
  sessionCount: number;
  detectionCount: number;
}

/* =========================================================================
 * 3. Spatial Analytics & Coordinate Frame Types
 * ========================================================================= */

export type CoordinateFrame = "sensor_relative" | "room_absolute";

export interface SensorMountTransform {
  mountX_mm: number;
  mountY_mm: number;
  orientationDeg?: number; // 0 = facing +Y, 90 = facing +X, 180 = facing -Y, 270 = facing -X
}

export interface HeatmapCell {
  col: number;
  row: number;
  x_mm: number;
  y_mm: number;
  count: number;
  density: number; // 0.0 to 1.0 (normalized against max cell density)
}

export interface TraversedArea {
  label: string;
  bounds: { minX_mm: number; maxX_mm: number; minY_mm: number; maxY_mm: number };
  pointCount: number;
  relativeDensityPct: number;
}

export interface HeatmapData {
  gridCols: number;
  gridRows: number;
  cellWidthMm: number;
  cellHeightMm: number;
  maxDensityCount: number;
  totalPoints: number;
  cells: HeatmapCell[];
  frequentlyTraversedAreas: TraversedArea[];
  unmappedPointsCount?: number;
}

export interface ZoneActivity {
  zoneId: string;
  zoneName: string;
  zoneType: string;
  pointCount: number;
  dwellMs: number;
  dwellMinutes: number;
  dwellPercentage: number; // Percentage of total active dwell across zones
  visitCount: number;
}

export interface DoorwayActivity {
  doorId: string;
  doorName: string;
  doorType: "entry" | "exit" | "both";
  entries: number;
  exits: number;
  totalCrossings: number;
  peakHour: number | null; // 0..23
  directionality: "supported" | "unsupported";
}

export interface TrajectorySummary {
  totalDistanceMeters: number;
  averageSpeedCms: number; // 2D displacement speed from consecutive samples (cm/s)
  averageRadialSpeedCms: number; // Absolute magnitude of sensor radial Doppler velocity (|speed_cms|)
  totalPoints: number;
  segmentCount: number;
  activeTargetIds: number[];
  movementDensityPointsPerM2: number;
  provisionalJitterDeadbandMm: number;
}

/* =========================================================================
 * 4. Routine & Baseline Insights Types
 * ========================================================================= */

export interface BaselineSufficiency {
  isSufficient: boolean;
  daysObserved: number;
  minRequiredDays: number;
  totalSessions: number;
  reason: string;
}

export interface HourlyRoutineSlot {
  [key: string]: unknown;
  hour: number; // 0..23
  label: string; // e.g. "08:00"
  observedOccupiedMinutes: number;
  observedOccupancyPct: number;
  baselineOccupancyPct: number;
  baselineMinPct: number;
  baselineMaxPct: number;
  isDeviation: boolean;
  deviationMinutes: number;
}

export interface WeekdayRoutine {
  [key: string]: unknown;
  dayIndex: number; // 0 = Sun .. 6 = Sat
  dayName: string; // "Sun", "Mon", ...
  occupiedHours: number;
  utilisationPct: number;
  sessionCount: number;
}

export interface ObservedPattern {
  id: string;
  name: string;
  type: "peak_activity" | "quiet_hours" | "regular_presence";
  timeRange: string;
  averageOccupancyPct: number;
  confidence: "low" | "medium" | "high";
  description: string;
}

export interface ConfiguredRoutineAdherence {
  routineId: string;
  routineName: string;
  timeRange: string;
  expectedPresence: boolean;
  adherencePct: number;
  status: "adhered" | "deviated" | "insufficient_data";
  details: string;
}

export interface RoutineInsights {
  sufficiency: BaselineSufficiency;
  hourlyProfile: HourlyRoutineSlot[];
  weekdayProfile: WeekdayRoutine[];
  observedPatterns: ObservedPattern[];
  configuredAdherence: ConfiguredRoutineAdherence[];
  deviations: string[];
}

/* =========================================================================
 * 5. Alert Analytics Types
 * ========================================================================= */

export interface AlertsSummary {
  totalAlerts: number;
  bySeverity: Record<AlertSeverity, number>;
  byType: Record<string, number>;
  acknowledgedCount: number;
  unacknowledgedCount: number;
  acknowledgementRatePct: number;
  avgTimeToAcknowledgeMs: number | null;
  topAffectedZones: { zoneName: string; count: number }[];
  repeatedPatterns: { title: string; count: number; description: string }[];
  dailyTrends: { date: string; count: number; criticalOrHighCount: number }[];
}

/* =========================================================================
 * 6. Historical Comparison Types
 * ========================================================================= */

export interface PeriodMetrics {
  label: string;
  from: number;
  to: number;
  occupiedHours: number;
  utilisationPct: number;
  sessionCount: number;
  avgDurationMinutes: number;
  alertCount: number;
  detections: number;
}

export interface PeriodComparisonResult {
  current: PeriodMetrics;
  previous: PeriodMetrics;
  deltas: {
    occupiedHoursDelta: number;
    occupiedHoursPctChange: number;
    utilisationDelta: number;
    sessionCountDelta: number;
    alertCountDelta: number;
    detectionsDelta: number;
  };
  zoneShifts: {
    zoneId: string;
    zoneName: string;
    currentMinutes: number;
    previousMinutes: number;
    deltaMinutes: number;
  }[];
}

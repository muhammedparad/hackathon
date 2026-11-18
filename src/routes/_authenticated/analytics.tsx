import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Calendar,
  Compass,
  FileSpreadsheet,
  Flame,
  FlaskConical,
  GitCompare,
  Layers,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { analyticsEventsQuery, roomsQuery, trajectoriesQuery, type Room } from "@/lib/data";
import {
  calculateActivitySummary,
  calculateAlertsSummary,
  calculateDailySummaries,
  calculateDoorwayPassages,
  calculateMovementHeatmap,
  calculateZoneDwellAndActivity,
  comparePeriods,
  deduplicateEvents,
  detailedOccupancySessions,
  formatDateIso,
  generateAnalyticsScenarioData,
  generateRoutineInsights,
  occupancySessions,
  occupiedMs,
  parseDateOnly,
  summarizeTrajectories,
  utilisation,
  type AnalyticsScenario,
  type PeriodComparisonResult,
  type SensorMountTransform,
} from "@/lib/analytics";
import { firebaseDb } from "@/lib/firebase/db";
import { Empty, PageHeader, Panel, Pill, SimTag } from "@/components/app/status";
import { AreaSeries, Bars } from "@/components/app/charts";
import { MovementHeatmap } from "@/components/analytics/movement-heatmap";
import { ZoneActivityCard } from "@/components/analytics/zone-activity-card";
import { DoorwayActivityCard } from "@/components/analytics/doorway-activity-card";
import { RoutineInsightsCard } from "@/components/analytics/routine-insights-card";
import { AlertAnalyticsCard } from "@/components/analytics/alert-analytics-card";
import { PeriodComparisonCard } from "@/components/analytics/period-comparison-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/analytics")({
  validateSearch: z.object({
    room: z.string().optional(),
    tab: z.string().optional(),
  }),
  head: () => ({
    meta: [
      { title: "Smart Household Insights & Analytics — RoomTrace" },
      {
        name: "description",
        content:
          "Household activity patterns, spatial heatmaps, zone dwell, routines, and explainable alert trends.",
      },
      { property: "og:title", content: "Smart Household Insights & Analytics — RoomTrace" },
      {
        property: "og:description",
        content:
          "Household activity patterns, spatial heatmaps, zone dwell, routines, and explainable alert trends.",
      },
    ],
  }),
  component: AnalyticsPage,
});

const RANGES = {
  "24h": { ms: 864e5, label: "Last 24 hours", stepMs: 3600_000, stepLabel: "Hour" },
  "7d": { ms: 7 * 864e5, label: "Last 7 days", stepMs: 864e5, stepLabel: "Day" },
  "30d": { ms: 30 * 864e5, label: "Last 30 days", stepMs: 864e5, stepLabel: "Day" },
  custom: { ms: 7 * 864e5, label: "Custom range", stepMs: 864e5, stepLabel: "Day" },
} as const;
type RangeKey = keyof typeof RANGES;

const SCENARIOS: { key: AnalyticsScenario; label: string }[] = [
  { key: "normal_daily", label: "Normal Daily Activity (Morning/Evening)" },
  { key: "low_activity", label: "Low Room Activity (Sparse Visits)" },
  { key: "high_activity", label: "High Room Activity (Continuous Turnover)" },
  { key: "repeated_zone_visits", label: "Repeated Zone Visits (Couch/Desk)" },
  { key: "multi_target", label: "Multiple Target Movement (Simultaneous)" },
  { key: "doorway_crossings", label: "Repeated Doorway Crossings (Ingress/Egress)" },
  { key: "increased_alerts", label: "Increased Alert Activity (Hazards/Falls)" },
  { key: "period_comparison", label: "Two-Week Historical Baseline Comparison" },
];

function AnalyticsPage() {
  const search = Route.useSearch();
  const qc = useQueryClient();
  const { data: rooms = [], isLoading: roomsLoading } = useQuery(roomsQuery);

  const [activeTab, setActiveTab] = useState<string>(search.tab ?? "overview");
  const [range, setRange] = useState<RangeKey>("7d");
  const [room, setRoom] = useState<string>(search.room ?? "all");
  const [sensor, setSensor] = useState("all");
  const [sim, setSim] = useState(true);
  const [compare, setCompare] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<AnalyticsScenario>("normal_daily");
  const [isInjectingScenario, setIsInjectingScenario] = useState(false);

  // Custom date range state using unified calendar date formatting
  const todayIso = useMemo(() => formatDateIso(Date.now()), []);
  const weekAgoIso = useMemo(() => formatDateIso(Date.now() - 7 * 864e5), []);
  const [customFrom, setCustomFrom] = useState(weekAgoIso);
  const [customTo, setCustomTo] = useState(todayIso);

  const now = useMemo(() => Date.now(), [range, sim, customFrom, customTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine window timestamps
  const { from, to, prevFrom, prevTo, windowMs } = useMemo(() => {
    if (range === "custom") {
      const f = parseDateOnly(customFrom, undefined, false);
      const t = parseDateOnly(customTo, undefined, true); // End of custom day (23:59:59.999)
      const span = Math.max(864e5, t - f);
      return {
        from: f,
        to: t,
        prevFrom: f - span,
        prevTo: f,
        windowMs: span,
      };
    }
    const R = RANGES[range];
    const f = now - R.ms;
    return {
      from: f,
      to: now,
      prevFrom: f - R.ms,
      prevTo: f,
      windowMs: R.ms,
    };
  }, [range, now, customFrom, customTo]);

  // Selected room details
  const activeRoom: Room | undefined = useMemo(() => {
    if (room === "all") return rooms[0];
    return rooms.find((r) => r.id === room);
  }, [room, rooms]);

  const activeRoomId = activeRoom?.id ?? "e4a7a8d0-4491-4e78-9584-c817215c0e01";

  // Query events spanning both previous and current window for comparison
  const eventsQuery = useQuery(
    analyticsEventsQuery(new Date(prevFrom).toISOString(), sim, room === "all" ? undefined : room),
  );

  // Query trajectory segments for spatial heatmap and zone dwell
  const trajectoriesQ = useQuery(
    trajectoriesQuery({
      roomId: activeRoomId,
      fromIso: new Date(prevFrom).toISOString(),
      toIso: new Date(to).toISOString(),
      simulated: sim ? undefined : false,
      sensorType: sensor === "all" ? undefined : (sensor as "ld2450" | "rd61"),
      limitCount: 500,
    }),
  );

  // Core Analytics Computation
  const analytics = useMemo(() => {
    const rawEvents = eventsQuery.data ?? [];
    let ev = deduplicateEvents(rawEvents);
    if (sensor !== "all") {
      ev = ev.filter((e) => e.sensor_type === sensor || e.event_type.startsWith("room_"));
    }
    if (room !== "all") {
      ev = ev.filter((e) => e.room_id === room);
    }

    const rawTrajectories = trajectoriesQ.data ?? [];
    const segments = rawTrajectories.filter((s) => {
      if (room !== "all" && s.room_id !== room) return false;
      if (sensor !== "all" && s.sensor_type !== sensor) return false;
      return true;
    });

    const currentSegments = segments.filter((s) => s.end_epoch >= from && s.start_epoch <= to);
    const previousSegments = segments.filter(
      (s) => s.end_epoch >= prevFrom && s.start_epoch <= prevTo,
    );

    // 1. Activity Summary
    const activitySummary = calculateActivitySummary(
      ev,
      from,
      to,
      room === "all" ? undefined : room,
      { now, windowTo: to, roomIds: rooms.map((r) => r.id) },
    );

    // 2. Daily Summaries
    const allSessions = occupancySessions(ev, now, to);
    const dailySummaries = calculateDailySummaries(
      allSessions,
      ev,
      from,
      to,
      room === "all" ? undefined : room,
      undefined,
      { roomIds: rooms.map((r) => r.id) },
    );

    // 3. Spatial Analytics
    const roomW = activeRoom?.width_mm ?? 5000;
    const roomL = activeRoom?.length_mm ?? 4000;
    const mountTransform: SensorMountTransform = {
      mountX_mm: roomW / 2,
      mountY_mm: 0,
      orientationDeg: 0,
    };
    const heatmapData = calculateMovementHeatmap(currentSegments, roomW, roomL, 20, mountTransform);
    const zoneActivity = calculateZoneDwellAndActivity(
      currentSegments,
      activeRoom?.zones ?? [],
      mountTransform,
      roomW,
      roomL,
    );
    const doorwayActivity = calculateDoorwayPassages(
      activeRoom?.doors ?? [],
      currentSegments,
      ev.filter((e) => new Date(e.timestamp).getTime() >= from),
      roomW,
      roomL,
      750,
      mountTransform,
    );
    const trajectorySummary = summarizeTrajectories(currentSegments, roomW, roomL, {
      maxGapMs: 2500,
      deadbandMm: 35,
      mountTransform,
    });

    // 4. Routine & Baseline Insights
    const baselineSessions = occupancySessions(ev, now, prevTo).filter(
      (s) => s.start >= prevFrom && s.end <= prevTo,
    );
    const routineInsights = generateRoutineInsights(
      ev,
      allSessions.filter((s) => s.start >= from && s.end <= to),
      activeRoom ? [] : [], // Expected routines
      from,
      to,
      baselineSessions,
    );

    // 5. Alert Analytics
    const alertsSummary = calculateAlertsSummary(ev, from, to, room === "all" ? undefined : room);

    // 6. Period Comparison
    const comparisonResult: PeriodComparisonResult = comparePeriods(
      ev,
      {
        from,
        to,
        label: range === "24h" ? "Current 24h" : range === "7d" ? "Current Week" : "Current Period",
      },
      {
        from: prevFrom,
        to: prevTo,
        label:
          range === "24h" ? "Previous 24h" : range === "7d" ? "Previous Week" : "Previous Period",
      },
      {
        roomId: room === "all" ? undefined : room,
        zones: activeRoom?.zones ?? [],
        currentSegments,
        previousSegments,
      },
    );

    // 7. Multi-room overview table data
    const perRoomData = rooms.map((r) => {
      const rSessions = allSessions.filter((s) => s.room_id === r.id);
      return {
        id: r.id,
        name: r.name,
        utilisation: utilisation(rSessions, from, to, r.id),
        occupiedHours: +(occupiedMs(rSessions, from, to, r.id) / 3600_000).toFixed(1),
        sessions: rSessions.filter((s) => s.end > from && s.start < to).length,
        detections: ev.filter(
          (e) =>
            e.room_id === r.id &&
            (e.event_type === "target_detected" || e.event_type === "target_moved") &&
            new Date(e.timestamp).getTime() >= from,
        ).length,
      };
    });

    const hasData =
      ev.some((e) => new Date(e.timestamp).getTime() >= from) || currentSegments.length > 0;

    return {
      hasData,
      activitySummary,
      dailySummaries,
      heatmapData,
      zoneActivity,
      doorwayActivity,
      trajectorySummary,
      routineInsights,
      alertsSummary,
      comparisonResult,
      perRoomData,
    };
  }, [
    eventsQuery.data,
    trajectoriesQ.data,
    room,
    sensor,
    from,
    to,
    prevFrom,
    prevTo,
    now,
    range,
    activeRoom,
    rooms,
  ]);

  // Load Preset Synthetic Simulation Scenario
  const handleLoadScenario = async () => {
    setIsInjectingScenario(true);
    try {
      const scenarioData = generateAnalyticsScenarioData(activeRoomId, selectedScenario);
      // Save trajectory batch
      await firebaseDb.saveTrajectoryBatch(scenarioData.segments);
      // Save event batch
      for (const e of scenarioData.events) {
        await firebaseDb.recordEvent(e);
      }
      toast.success(`Loaded "${scenarioData.title}" simulated scenario data!`);
      // Invalidate queries so analytics recalculate immediately
      await qc.invalidateQueries({ queryKey: ["analytics-events"] });
      await qc.invalidateQueries({ queryKey: ["trajectories"] });
    } catch {
      toast.error("Failed to inject simulation scenario data.");
    } finally {
      setIsInjectingScenario(false);
    }
  };

  const simTag = sim ? <SimTag /> : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Smart Household Activity Insights"
        description="Comprehensive activity analytics, spatial heatmaps, zone dwell, routines, and alert trends."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={compare ? "secondary" : "outline"}
              size="sm"
              className="h-9"
              onClick={() => setCompare((v) => !v)}
            >
              <GitCompare className="mr-1.5 size-4" />
              {compare ? "Hide Comparison" : "Compare Periods"}
            </Button>
          </div>
        }
      />

      {/* Filter and Configuration Controls Bar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border bg-card p-3 shadow-card">
        {/* Date Range Selector */}
        <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
          <SelectTrigger className="h-9 w-40" aria-label="Date range">
            <Calendar className="mr-1.5 size-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RANGES).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Custom Date Pickers */}
        {range === "custom" && (
          <div className="flex items-center gap-1.5 text-xs">
            <Input
              type="date"
              className="h-9 w-32"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="From date"
            />
            <span className="text-muted-foreground">to</span>
            <Input
              type="date"
              className="h-9 w-32"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="To date"
            />
          </div>
        )}

        {/* Room Selector */}
        <Select value={room} onValueChange={setRoom}>
          <SelectTrigger className="h-9 w-44" aria-label="Room">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Rooms ({rooms.length})</SelectItem>
            {rooms.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Sensor Filter */}
        <Select value={sensor} onValueChange={setSensor}>
          <SelectTrigger className="h-9 w-36" aria-label="Sensor">
            <Compass className="mr-1.5 size-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sensors</SelectItem>
            <SelectItem value="ld2450">LD2450 (Targets)</SelectItem>
            <SelectItem value="rd61">RD-61 (Point-Cloud)</SelectItem>
          </SelectContent>
        </Select>

        {/* Simulated Provenance Switch */}
        <div className="ml-auto flex items-center gap-2">
          <Switch id="sim" checked={sim} onCheckedChange={setSim} />
          <Label htmlFor="sim" className="flex items-center gap-1.5 text-xs cursor-pointer">
            Include Simulated Data
            {simTag}
          </Label>
        </div>
      </div>

      {/* Preset Scenario Generator Bar (Visible when simulation data is enabled) */}
      {sim && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sim/30 bg-sim-soft/30 p-3 text-xs">
          <div className="flex items-center gap-2">
            <FlaskConical className="size-4 text-sim" />
            <span className="font-semibold text-foreground">Virtual Scenario Generator:</span>
            <span className="text-muted-foreground">
              Inject reproducible multi-day virtual datasets to explore analytics.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedScenario}
              onValueChange={(v) => setSelectedScenario(v as AnalyticsScenario)}
            >
              <SelectTrigger className="h-8 w-64 bg-card text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCENARIOS.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="default"
              className="h-8 text-xs bg-sim hover:bg-sim/90 text-white"
              onClick={handleLoadScenario}
              disabled={isInjectingScenario}
            >
              {isInjectingScenario ? (
                <>
                  <RefreshCw className="mr-1.5 size-3 animate-spin" /> Generating...
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 size-3" /> Load Scenario
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Loading or Empty State */}
      {eventsQuery.isLoading || trajectoriesQ.isLoading || roomsLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : !analytics.hasData ? (
        <Panel>
          <Empty
            icon={<BarChart3 className="size-6" />}
            title="No analytics records found for this period"
          >
            {sim ? (
              <div className="space-y-3">
                <p>
                  No virtual telemetry recorded for the selected date range. Click{" "}
                  <strong>Load Scenario</strong> above to instantly inject reproducible household
                  activity data.
                </p>
                <Button
                  size="sm"
                  onClick={handleLoadScenario}
                  disabled={isInjectingScenario}
                  className="bg-primary text-xs"
                >
                  <Sparkles className="mr-1.5 size-3.5" /> Inject Standard Daily Activity Scenario
                </Button>
              </div>
            ) : (
              <p>
                No verified hardware radar records found for this window. To review simulated data,
                turn on “Include Simulated Data” in the controls above.
              </p>
            )}
          </Empty>
        </Panel>
      ) : (
        /* Analytics Sections & Navigation Tabs */
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="h-10 w-full justify-start gap-1 rounded-xl border bg-card p-1 shadow-card overflow-x-auto">
            <TabsTrigger value="overview" className="text-xs">
              <Activity className="mr-1.5 size-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="spatial" className="text-xs">
              <Flame className="mr-1.5 size-3.5 text-amber-500" /> Spatial Activity
            </TabsTrigger>
            <TabsTrigger value="routines" className="text-xs">
              <Sparkles className="mr-1.5 size-3.5 text-primary" /> Household Routines
            </TabsTrigger>
            <TabsTrigger value="alerts" className="text-xs">
              <AlertTriangle className="mr-1.5 size-3.5 text-destructive" /> Alert Analytics
            </TabsTrigger>
            {compare && (
              <TabsTrigger value="comparison" className="text-xs">
                <GitCompare className="mr-1.5 size-3.5 text-primary" /> Period Comparison
              </TabsTrigger>
            )}
          </TabsList>

          {/* ============================================================== */}
          {/* TAB 1: OVERVIEW */}
          {/* ============================================================== */}
          <TabsContent value="overview" className="space-y-6">
            {/* KPI Cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <KpiCard
                label="Room Utilisation"
                value={`${analytics.activitySummary.utilisationPct}%`}
                hint="Proportion of valid observed time room was occupied"
                sim={sim}
              />
              <KpiCard
                label="Occupancy Duration"
                value={`${+(analytics.activitySummary.totalOccupiedMs / 3600_000).toFixed(1)}h`}
                hint="Total confirmed occupied time in window"
                sim={sim}
              />
              <KpiCard
                label="Data Coverage"
                value={`${analytics.activitySummary.dataCoveragePct}%`}
                hint={
                  analytics.activitySummary.offlineDurationMs > 0
                    ? `${+(analytics.activitySummary.offlineDurationMs / 3600_000).toFixed(1)}h sensor offline/censored`
                    : "100% active telemetry"
                }
                sim={sim}
              />
              <KpiCard
                label="Movement Sessions"
                value={String(analytics.activitySummary.totalSessions)}
                hint="Discrete occupied periods"
                sim={sim}
              />
              <KpiCard
                label="Avg Session Length"
                value={`${analytics.activitySummary.avgSessionDurationMinutes}m`}
                hint={`Median: ${analytics.activitySummary.medianSessionDurationMinutes}m`}
                sim={sim}
              />
              <KpiCard
                label="Active Alerts"
                value={String(analytics.alertsSummary.totalAlerts)}
                hint={`${analytics.alertsSummary.acknowledgedCount} acknowledged`}
                sim={sim}
              />
            </div>

            {/* Daily Occupancy Trend Chart */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title={<>Occupancy Over Time {simTag}</>} hint="Occupied minutes per day.">
                <AreaSeries
                  data={analytics.dailySummaries}
                  x="label"
                  y="occupiedMinutes"
                  unit="m"
                  height={220}
                />
              </Panel>

              <Panel
                title={<>Target Detections vs Movement Events {simTag}</>}
                hint="Anonymous reflections vs displacement triggers."
              >
                <Bars
                  data={analytics.dailySummaries}
                  x="label"
                  bars={[
                    { key: "detectionCount", label: "Detections", color: "var(--chart-1)" },
                    { key: "sessionCount", label: "Sessions", color: "var(--chart-3)" },
                  ]}
                  height={220}
                />
              </Panel>
            </div>

            {/* Duration Histogram & Multi-Room Table */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel
                title={<>Occupancy Session Duration Distribution {simTag}</>}
                hint="Histogram of how long detected room visits lasted."
              >
                <Bars
                  data={analytics.activitySummary.durationsHistogram}
                  x="label"
                  bars={[{ key: "count", label: "Sessions", color: "var(--chart-2)" }]}
                  height={200}
                />
              </Panel>

              {/* Multi-Room Breakdown */}
              <Panel title={<>Room Utilisation Breakdown {simTag}</>}>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-left font-medium text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Room</th>
                        <th className="px-3 py-2 text-right">Utilisation</th>
                        <th className="px-3 py-2 text-right">Occupied Hours</th>
                        <th className="px-3 py-2 text-right">Sessions</th>
                        <th className="px-3 py-2 text-right">Detections</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border font-mono">
                      {analytics.perRoomData.map((r) => (
                        <tr key={r.id} className="hover:bg-muted/20">
                          <td className="px-3 py-2 font-sans font-medium text-foreground">
                            {r.name}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold">{r.utilisation}%</td>
                          <td className="px-3 py-2 text-right">{r.occupiedHours}h</td>
                          <td className="px-3 py-2 text-right">{r.sessions}</td>
                          <td className="px-3 py-2 text-right">{r.detections}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          </TabsContent>

          {/* ============================================================== */}
          {/* TAB 2: SPATIAL ACTIVITY & HEATMAP */}
          {/* ============================================================== */}
          <TabsContent value="spatial" className="space-y-6">
            {/* Trajectory Summary Banner */}
            <div className="grid gap-3 sm:grid-cols-5 rounded-xl border bg-card p-4">
              <div>
                <div className="text-xs text-muted-foreground">Total Distance Traversed</div>
                <div className="mt-1 font-mono text-xl font-bold">
                  {analytics.trajectorySummary.totalDistanceMeters.toLocaleString()} m
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Provisional {analytics.trajectorySummary.provisionalJitterDeadbandMm}mm deadband
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Average 2D Speed</div>
                <div className="mt-1 font-mono text-xl font-bold">
                  {analytics.trajectorySummary.averageSpeedCms} cm/s
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  2D consecutive displacement
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Radial Doppler Speed</div>
                <div className="mt-1 font-mono text-xl font-bold">
                  {analytics.trajectorySummary.averageRadialSpeedCms} cm/s
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Sensor line-of-sight velocity
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Spatial Movement Density</div>
                <div className="mt-1 font-mono text-xl font-bold">
                  {analytics.trajectorySummary.movementDensityPointsPerM2} pts/m²
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Points per m² floor area
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Concurrent Target Channels</div>
                <div className="mt-1 font-mono text-xl font-bold">
                  {analytics.trajectorySummary.activeTargetIds.length > 0
                    ? `Channels ${analytics.trajectorySummary.activeTargetIds.join(", ")}`
                    : "None"}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Anonymous radar echoes
                </div>
              </div>
            </div>

            {/* Movement Heatmap */}
            <Panel
              title={
                <div className="flex items-center gap-2">
                  <Flame className="size-4 text-amber-500" />
                  <span>Room Movement Heatmap {simTag}</span>
                </div>
              }
              hint="Grid-binned spatial density of all recorded radar target points overlaid on the room floor plan."
            >
              <MovementHeatmap
                heatmapData={analytics.heatmapData}
                roomWidthMm={activeRoom?.width_mm ?? 5000}
                roomLengthMm={activeRoom?.length_mm ?? 4000}
                zones={activeRoom?.zones ?? []}
                doors={activeRoom?.doors ?? []}
                simulated={sim}
              />
            </Panel>

            {/* Zone Activity & Doorway Transit Charts */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel
                title={<>Zone Dwell Times & Visit Share {simTag}</>}
                hint="Dwell duration and visit counts inside configured room zones."
              >
                <ZoneActivityCard zones={analytics.zoneActivity} />
              </Panel>

              <Panel
                title={<>Doorway Entry & Exit Flow {simTag}</>}
                hint="Directional inward vs outward transits across configured room doorways."
              >
                <DoorwayActivityCard doorways={analytics.doorwayActivity} />
              </Panel>
            </div>
          </TabsContent>

          {/* ============================================================== */}
          {/* TAB 3: HOUSEHOLD ROUTINES & BASELINES */}
          {/* ============================================================== */}
          <TabsContent value="routines" className="space-y-6">
            <RoutineInsightsCard insights={analytics.routineInsights} />
          </TabsContent>

          {/* ============================================================== */}
          {/* TAB 4: ALERT ANALYTICS */}
          {/* ============================================================== */}
          <TabsContent value="alerts" className="space-y-6">
            <AlertAnalyticsCard summary={analytics.alertsSummary} />
          </TabsContent>

          {/* ============================================================== */}
          {/* TAB 5: PERIOD COMPARISON */}
          {/* ============================================================== */}
          <TabsContent value="comparison" className="space-y-6">
            <PeriodComparisonCard comparison={analytics.comparisonResult} />
          </TabsContent>
        </Tabs>
      )}

      {/* Privacy & Provenance Disclosure Footer */}
      <div className="flex items-start gap-3 rounded-xl border border-muted bg-card/60 p-4 text-xs text-muted-foreground shadow-sm">
        <ShieldCheck className="mt-0.5 size-4 text-primary shrink-0" />
        <div className="space-y-1">
          <div className="font-semibold text-foreground">
            Camera-Free Anonymous Radar Privacy Guarantee
          </div>
          <p>
            RoomTrace extracts activity insights exclusively from mmWave radar target reflections.
            No cameras, video recording, facial recognition, biometric identity scanning, or medical
            diagnosis algorithms are used. All target channels represent anonymous radar echoes,
            never confirmed human identities.
          </p>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  sim,
}: {
  label: string;
  value: string;
  hint?: string;
  sim: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {sim && <SimTag />}
      </div>
      <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-foreground tabular">
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

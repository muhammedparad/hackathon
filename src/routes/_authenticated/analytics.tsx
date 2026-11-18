import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
  GitCompare,
  Layers,
  MapPin,
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
  generateRoutineInsights,
  occupancySessions,
  occupiedMs,
  parseDateOnly,
  summarizeTrajectories,
  utilisation,
  type PeriodComparisonResult,
  type SensorMountTransform,
} from "@/lib/analytics";
import { Empty, PageHeader, Panel, Pill } from "@/components/app/status";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

function AnalyticsPage() {
  const search = Route.useSearch();
  const { data: rooms = [], isLoading: roomsLoading } = useQuery(roomsQuery);

  const [activeTab, setActiveTab] = useState<string>(search.tab ?? "overview");
  const [range, setRange] = useState<RangeKey>("7d");
  const [room, setRoom] = useState<string>(search.room ?? "all");
  const [sensor, setSensor] = useState("all");
  const [compare, setCompare] = useState(false);

  // Custom date range state using unified calendar date formatting
  const todayIso = useMemo(() => formatDateIso(Date.now()), []);
  const weekAgoIso = useMemo(() => formatDateIso(Date.now() - 7 * 864e5), []);
  const [customFrom, setCustomFrom] = useState(weekAgoIso);
  const [customTo, setCustomTo] = useState(todayIso);

  const now = useMemo(() => Date.now(), [range, customFrom, customTo]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const activeRoomId = activeRoom?.id;

  // Query events spanning both previous and current window for comparison
  const eventsQuery = useQuery(
    analyticsEventsQuery(new Date(prevFrom).toISOString(), room === "all" ? undefined : room),
  );

  // Query trajectory segments for spatial heatmap and zone dwell
  const trajectoriesQ = useQuery(
    trajectoriesQuery({
      roomId: activeRoomId,
      fromIso: new Date(prevFrom).toISOString(),
      toIso: new Date(to).toISOString(),
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
      </div>

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
            <p>
              No radar records found for this window. Data appears here once a registered device
              reports to the server.
            </p>
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
              />
              <KpiCard
                label="Occupancy Duration"
                value={`${+(analytics.activitySummary.totalOccupiedMs / 3600_000).toFixed(1)}h`}
                hint="Total confirmed occupied time in window"
              />
              <KpiCard
                label="Data Coverage"
                value={`${analytics.activitySummary.dataCoveragePct}%`}
                hint={
                  analytics.activitySummary.offlineDurationMs > 0
                    ? `${+(analytics.activitySummary.offlineDurationMs / 3600_000).toFixed(1)}h sensor offline/censored`
                    : "100% active telemetry"
                }
              />
              <KpiCard
                label="Movement Sessions"
                value={String(analytics.activitySummary.totalSessions)}
                hint="Discrete occupied periods"
              />
              <KpiCard
                label="Avg Session Length"
                value={`${analytics.activitySummary.avgSessionDurationMinutes}m`}
                hint={`Median: ${analytics.activitySummary.medianSessionDurationMinutes}m`}
              />
              <KpiCard
                label="Active Alerts"
                value={String(analytics.alertsSummary.totalAlerts)}
                hint={`${analytics.alertsSummary.acknowledgedCount} acknowledged`}
              />
            </div>

            {/* Daily Occupancy Trend Chart */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title={<>Occupancy Over Time</>} hint="Occupied minutes per day.">
                <AreaSeries
                  data={analytics.dailySummaries}
                  x="label"
                  y="occupiedMinutes"
                  unit="m"
                  height={220}
                />
              </Panel>

              <Panel
                title={<>Target Detections vs Movement Events</>}
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
                title={<>Occupancy Session Duration Distribution</>}
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
              <Panel title={<>Room Utilisation Breakdown</>}>
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
                  <span>Room Movement Heatmap</span>
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
              />
            </Panel>

            {/* Zone Activity & Doorway Transit Charts */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Panel
                title={<>Zone Dwell Times & Visit Share</>}
                hint="Dwell duration and visit counts inside configured room zones."
              >
                <ZoneActivityCard zones={analytics.zoneActivity} />
              </Panel>

              <Panel
                title={<>Doorway Entry & Exit Flow</>}
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

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
      </div>
      <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-foreground tabular">
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

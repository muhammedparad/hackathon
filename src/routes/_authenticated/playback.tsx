import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  AlertTriangle,
  Boxes,
  Calendar,
  Clock,
  FastForward,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
} from "lucide-react";
import { roomsQuery, type Room } from "@/lib/data";
import { firebaseDb } from "@/lib/firebase/db";
import {
  generateSimulatedPlaybackData,
  interpolateTargetsAtTime,
  type InterpolatedFrame,
} from "@/lib/radar/playback-engine";
import type { TrajectorySegment } from "@/lib/radar/types";
import { Empty, PageHeader, Panel, Pill, SimTag } from "@/components/app/status";
import { LD2450View } from "@/components/radar/ld2450-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const playbackSearchSchema = z.object({
  roomId: z.string().optional(),
  t: z.union([z.number(), z.string()]).optional(),
  targetId: z.union([z.number(), z.string()]).optional(),
  date: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/playback")({
  validateSearch: playbackSearchSchema,
  head: () => ({
    meta: [
      { title: "Route Playback — RoomTrace" },
      {
        name: "description",
        content: "Historical route scrubber, target trajectory playback, and dwell times.",
      },
      { property: "og:title", content: "Route Playback — RoomTrace" },
      {
        property: "og:description",
        content: "Historical route scrubber, target trajectory playback, and dwell times.",
      },
    ],
  }),
  component: PlaybackPage,
});

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min === 0) return `${remSec}s`;
  return `${min}m ${remSec}s`;
}

function formatClockTime(epochMs: number): string {
  if (!epochMs) return "--:--:--";
  const d = new Date(epochMs);
  return d.toTimeString().split(" ")[0] ?? "--:--:--";
}

function PlaybackPage() {
  const search = Route.useSearch();
  const searchTargetId = search.targetId ? Number(search.targetId) : null;
  const searchEpoch = search.t ? Number(search.t) : null;
  const { data: rooms = [], isLoading: roomsLoading } = useQuery(roomsQuery);
  const [selectedRoomId, setSelectedRoomId] = useState<string>(search.roomId ?? "");
  const [dataSource, setDataSource] = useState<"virtual" | "hardware">("virtual");
  const [showZones, setShowZones] = useState(true);
  const [showObjects, setShowObjects] = useState(true);
  const [showTrails, setShowTrails] = useState(true);
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(searchTargetId);

  // Local historical date selection (defaults to search param, or search epoch, or today YYYY-MM-DD)
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    if (search.date) return search.date;
    if (searchEpoch) {
      const d = new Date(searchEpoch);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  });

  // Calculate local timezone day boundaries
  const { fromIso, toIso, selectedDateNoonEpoch } = useMemo(() => {
    if (!selectedDate) {
      return { fromIso: undefined, toIso: undefined, selectedDateNoonEpoch: Date.now() };
    }
    const [y, m, d] = selectedDate.split("-").map(Number);
    if (!y || !m || !d) {
      return { fromIso: undefined, toIso: undefined, selectedDateNoonEpoch: Date.now() };
    }
    const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
    const endLocal = new Date(y, m - 1, d, 23, 59, 59, 999);
    const noonLocal = new Date(y, m - 1, d, 12, 0, 0, 0);
    return {
      fromIso: startLocal.toISOString(),
      toIso: endLocal.toISOString(),
      selectedDateNoonEpoch: noonLocal.getTime(),
    };
  }, [selectedDate]);

  // Playback engine states
  const [segments, setSegments] = useState<TrajectorySegment[]>([]);
  const [isLoadingSegments, setIsLoadingSegments] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [currentTime, setCurrentTime] = useState<number>(0);

  // Effective selected room
  const currentRoom: Room | undefined = useMemo(() => {
    return rooms.find((r) => r.id === selectedRoomId) ?? rooms[0];
  }, [rooms, selectedRoomId]);

  // Sync selectedRoomId once rooms load if not already set by search
  useEffect(() => {
    if (rooms.length > 0 && !selectedRoomId) {
      setSelectedRoomId(rooms[0]?.id ?? "");
    }
  }, [rooms, selectedRoomId]);

  // Calculate timeline start and end
  const { startTime, endTime, totalDurationMs } = useMemo(() => {
    if (segments.length === 0) {
      return { startTime: 0, endTime: 0, totalDurationMs: 0 };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const s of segments) {
      if (s.start_epoch < min) min = s.start_epoch;
      if (s.end_epoch > max) max = s.end_epoch;
    }
    return {
      startTime: min,
      endTime: max,
      totalDurationMs: Math.max(0, max - min),
    };
  }, [segments]);

  // Load trajectory segments from Firestore / cache
  const loadTrajectories = useCallback(async () => {
    if (!currentRoom) return;
    setIsLoadingSegments(true);
    try {
      const isSim = dataSource === "virtual";
      const loaded = await firebaseDb.getTrajectorySegments({
        roomId: currentRoom.id,
        simulated: isSim,
        fromIso,
        toIso,
        limitCount: 500,
      });

      if (loaded.length > 0) {
        setSegments(loaded);
        if (searchEpoch) {
          setCurrentTime(searchEpoch);
        } else {
          setCurrentTime(loaded[0]?.start_epoch ?? 0);
        }
      } else {
        setSegments([]);
        setCurrentTime(searchEpoch ?? 0);
      }
    } catch {
      setSegments([]);
    } finally {
      setIsLoadingSegments(false);
      setIsPlaying(false);
    }
  }, [currentRoom, dataSource, fromIso, toIso, searchEpoch]);

  useEffect(() => {
    void loadTrajectories();
  }, [loadTrajectories]);

  // Scenario generator for quick testing on selected date
  const loadScenario = async (scenario: "morning_routine" | "balcony_hazard" | "dual_crossing") => {
    if (!currentRoom) return;
    setIsLoadingSegments(true);
    try {
      const demo = generateSimulatedPlaybackData(currentRoom.id, scenario, selectedDateNoonEpoch);
      setSegments(demo);
      setCurrentTime(demo[0]?.start_epoch ?? 0);
      await firebaseDb.saveTrajectoryBatch(demo);
      setDataSource("virtual");
    } finally {
      setIsLoadingSegments(false);
      setIsPlaying(false);
    }
  };

  // Interpolated targets at currentTime
  const interpolatedFrame: InterpolatedFrame = useMemo(() => {
    if (!currentTime || segments.length === 0 || !currentRoom) {
      return { timestamp: currentTime, targets: [], activeCount: 0 };
    }
    return interpolateTargetsAtTime(segments, currentTime, currentRoom.zones ?? [], 8000);
  }, [segments, currentTime, currentRoom]);

  // Animation frame loop for smooth, stable playback
  const lastWallClockRef = useRef<number>(performance.now());
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      return;
    }

    lastWallClockRef.current = performance.now();

    const loop = (nowWallClock: number) => {
      const deltaWallMs = nowWallClock - lastWallClockRef.current;
      lastWallClockRef.current = nowWallClock;

      setCurrentTime((prev) => {
        const next = prev + deltaWallMs * speed;
        if (next >= endTime) {
          setIsPlaying(false);
          return endTime;
        }
        return next;
      });

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying, speed, endTime]);

  // Keyboard shortcut: Spacebar to toggle Play/Pause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setIsPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Controls: Seek, Step, Reset
  const seekRelative = (deltaMs: number) => {
    setCurrentTime((t) => Math.max(startTime, Math.min(endTime, t + deltaMs)));
  };

  const resetPlayback = () => {
    setIsPlaying(false);
    setCurrentTime(startTime);
  };

  const selectedTarget = useMemo(() => {
    return interpolatedFrame.targets.find((t) => t.target_id === selectedTargetId);
  }, [interpolatedFrame.targets, selectedTargetId]);

  if (!roomsLoading && rooms.length === 0) {
    return (
      <>
        <PageHeader title="Route Playback" />
        <Panel>
          <Empty
            icon={<Boxes className="size-5" />}
            title="No rooms configured"
            action={
              <Button asChild>
                <Link to="/rooms">Create a room</Link>
              </Button>
            }
          >
            Create a room first to enable trajectory tracking and route playback.
          </Empty>
        </Panel>
      </>
    );
  }

  const scrubberProgress =
    totalDurationMs > 0
      ? Math.max(0, Math.min(100, ((currentTime - startTime) / totalDurationMs) * 100))
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Route Playback"
        description="Inspect historical target trajectories, movement trails, and zone dwells across time."
        actions={
          <div className="flex items-center gap-2">
            {dataSource === "virtual" && <SimTag />}
            <Select
              value={dataSource}
              onValueChange={(v: "virtual" | "hardware") => setDataSource(v)}
            >
              <SelectTrigger className="h-9 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="virtual">Virtual Simulation</SelectItem>
                <SelectItem value="hardware">Hardware Telemetry</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      {/* TOOLBAR CONTROLS */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          {/* Room Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Room:</span>
            <Select value={selectedRoomId} onValueChange={setSelectedRoomId}>
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="Select Room" />
              </SelectTrigger>
              <SelectContent>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Picker */}
          <div className="flex items-center gap-2 pl-2 border-l">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Calendar className="size-3.5 text-muted-foreground" /> Date:
            </span>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="h-8 w-36 text-xs font-mono"
            />
          </div>

          {/* Quick Scenario Picker (for virtual playback) */}
          {dataSource === "virtual" && (
            <div className="flex items-center gap-1.5 pl-2 border-l">
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Sparkles className="size-3.5 text-primary" /> Preset:
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => loadScenario("morning_routine")}
              >
                Routine
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => loadScenario("balcony_hazard")}
              >
                Balcony Hazard
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => loadScenario("dual_crossing")}
              >
                Dual Crossing
              </Button>
            </div>
          )}
        </div>

        {/* Display Toggles */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <Switch id="pb-trails" checked={showTrails} onCheckedChange={setShowTrails} />
            <Label htmlFor="pb-trails" className="text-xs cursor-pointer">
              Trails
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="pb-zones" checked={showZones} onCheckedChange={setShowZones} />
            <Label htmlFor="pb-zones" className="text-xs cursor-pointer">
              Zones
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="pb-objects" checked={showObjects} onCheckedChange={setShowObjects} />
            <Label htmlFor="pb-objects" className="text-xs cursor-pointer">
              Furniture
            </Label>
          </div>
          {dataSource === "virtual" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (currentRoom) {
                  await firebaseDb.clearSimulatedTrajectories(currentRoom.id);
                  await loadTrajectories();
                }
              }}
              title="Clear virtual trajectories"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* MAIN PLAYBACK DISPLAY & INSPECTOR */}
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        {/* Main Floor Plan Map */}
        <Panel
          title={
            <span className="flex items-center gap-2">
              Route scrubber map {dataSource === "virtual" && <SimTag />}
            </span>
          }
          subtitle="Top-down visual route playback with trails, zone collision, and dwell tracking"
          action={
            <Pill t={interpolatedFrame.activeCount > 0 ? "success" : "neutral"}>
              {interpolatedFrame.activeCount} target{interpolatedFrame.activeCount === 1 ? "" : "s"}{" "}
              tracked
            </Pill>
          }
        >
          {currentRoom ? (
            <div className="relative">
              <LD2450View
                widthMm={currentRoom.width_mm}
                lengthMm={currentRoom.length_mm}
                playbackTargets={interpolatedFrame.targets}
                selected={selectedTargetId}
                onSelect={setSelectedTargetId}
                doors={currentRoom.doors}
                zones={currentRoom.zones}
                objects={currentRoom.objects}
                showZones={showZones}
                showObjects={showObjects}
                showTrails={showTrails}
                door={dataSource === "virtual"}
              />

              {/* Timestamp overlay */}
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-md bg-card/90 px-2.5 py-1 text-xs font-mono shadow-sm border backdrop-blur">
                <Clock className="size-3.5 text-muted-foreground" />
                <span>{formatClockTime(currentTime)}</span>
                <span className="text-muted-foreground">
                  ({formatDuration(currentTime - startTime)})
                </span>
              </div>

              {/* Empty state overlay when no trajectories exist for selected date */}
              {segments.length === 0 && !isLoadingSegments && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/85 backdrop-blur-xs p-6 text-center rounded-lg border">
                  <Calendar className="size-8 text-muted-foreground mb-2" />
                  <p className="font-semibold text-sm">No trajectory records for {selectedDate}</p>
                  <p className="text-xs text-muted-foreground max-w-sm mt-1">
                    {dataSource === "virtual"
                      ? "Generate simulated trajectory data using one of the preset scenarios in the toolbar above."
                      : "No hardware radar telemetry or trajectories were stored for this room on this date."}
                  </p>
                  {dataSource === "virtual" && (
                    <Button
                      size="sm"
                      className="mt-3 text-xs"
                      onClick={() => loadScenario("morning_routine")}
                    >
                      <Sparkles className="size-3.5 mr-1.5" />
                      Generate Sample Route
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <Empty icon={<Calendar className="size-5" />} title="No Room Selected" />
          )}
        </Panel>

        {/* Side Inspector Panel */}
        <div className="space-y-6">
          <Panel title="Active Targets" subtitle={`At ${formatClockTime(currentTime)}`}>
            {interpolatedFrame.targets.length > 0 ? (
              <div className="space-y-3">
                {interpolatedFrame.targets.map((t) => (
                  <div
                    key={t.target_id}
                    onClick={() => setSelectedTargetId(t.target_id)}
                    className={`cursor-pointer rounded-lg border p-3 text-xs transition-colors ${
                      selectedTargetId === t.target_id
                        ? "border-primary bg-primary/5"
                        : "bg-muted/30 hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center justify-between pb-1.5 border-b mb-2">
                      <span className="font-semibold text-foreground">
                        Target #{t.target_id} · {t.sensor_type.toUpperCase()}
                      </span>
                      {t.is_in_hazard && (
                        <span className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                          <AlertTriangle className="size-3" /> Hazard Zone
                        </span>
                      )}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-muted-foreground">
                      <div>
                        X: <span className="text-foreground">{t.x_mm} mm</span>
                      </div>
                      <div>
                        Y: <span className="text-foreground">{t.y_mm} mm</span>
                      </div>
                      <div>
                        Speed: <span className="text-foreground">{t.speed_cms} cm/s</span>
                      </div>
                      <div>
                        Dwell: <span className="text-foreground">{formatDuration(t.dwell_ms)}</span>
                      </div>
                      {t.current_zone && (
                        <div className="col-span-2 text-foreground font-sans pt-1">
                          Zone: <span className="font-medium text-primary">{t.current_zone}</span>
                        </div>
                      )}
                    </dl>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {segments.length === 0
                  ? "No trajectory segments loaded."
                  : "No targets present at this timeline position."}
              </p>
            )}
          </Panel>

          {/* Selected Target Deep Inspector */}
          <Panel
            title="Target Metrics"
            subtitle={selectedTarget ? `Target #${selectedTarget.target_id}` : "Select a target"}
          >
            {selectedTarget ? (
              <dl className="space-y-2.5 text-xs">
                <div className="flex justify-between border-b pb-1.5">
                  <dt className="text-muted-foreground">Coordinates</dt>
                  <dd className="font-mono tabular">
                    ({selectedTarget.x_mm}, {selectedTarget.y_mm}) mm
                  </dd>
                </div>
                <div className="flex justify-between border-b pb-1.5">
                  <dt className="text-muted-foreground">Distance from radar</dt>
                  <dd className="font-mono tabular">
                    {Math.round(Math.hypot(selectedTarget.x_mm, selectedTarget.y_mm))} mm
                  </dd>
                </div>
                <div className="flex justify-between border-b pb-1.5">
                  <dt className="text-muted-foreground">Radial Heading Angle</dt>
                  <dd className="font-mono tabular">
                    {(
                      (Math.atan2(selectedTarget.x_mm, selectedTarget.y_mm) * 180) /
                      Math.PI
                    ).toFixed(1)}
                    °
                  </dd>
                </div>
                <div className="flex justify-between border-b pb-1.5">
                  <dt className="text-muted-foreground">Radial Speed</dt>
                  <dd className="font-mono tabular">{selectedTarget.speed_cms} cm/s</dd>
                </div>
                <div className="flex justify-between border-b pb-1.5">
                  <dt className="text-muted-foreground">Stationary Dwell</dt>
                  <dd className="font-mono tabular">{formatDuration(selectedTarget.dwell_ms)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Trail Length</dt>
                  <dd className="font-mono tabular">{selectedTarget.trail.length} points</dd>
                </div>
              </dl>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Click a target dot on the floor plan or list to inspect real-time trajectory
                metrics.
              </p>
            )}
          </Panel>
        </div>
      </div>

      {/* TIMELINE SCRUBBER & PLAYBACK CONTROLS */}
      <div className="rounded-xl border bg-card p-5 shadow-card space-y-3">
        {/* Scrubber Slider */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono">{formatClockTime(currentTime)}</span>
            <span className="text-[11px] font-medium">
              Progress: {scrubberProgress.toFixed(1)}% · Elapsed:{" "}
              {formatDuration(currentTime - startTime)} / Total: {formatDuration(totalDurationMs)}
            </span>
            <span className="font-mono">{formatClockTime(endTime)}</span>
          </div>

          <Slider
            value={[currentTime]}
            min={startTime || 0}
            max={endTime || 100}
            step={250}
            onValueChange={(val) => {
              if (val[0] !== undefined) {
                setCurrentTime(val[0]);
              }
            }}
            disabled={segments.length === 0}
            className="cursor-pointer"
          />
        </div>

        {/* Playback Button Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          {/* Main Transport Buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9 p-0"
              onClick={resetPlayback}
              title="Reset to start"
            >
              <RotateCcw className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9 p-0"
              onClick={() => seekRelative(-5000)}
              title="Step backward 5s"
            >
              <SkipBack className="size-4" />
            </Button>
            <Button
              size="sm"
              className="h-9 w-24 gap-1.5 font-medium"
              onClick={() => {
                if (currentTime >= endTime && endTime > 0) {
                  setCurrentTime(startTime);
                }
                setIsPlaying(!isPlaying);
              }}
              disabled={segments.length === 0}
            >
              {isPlaying ? (
                <>
                  <Pause className="size-4" /> Pause
                </>
              ) : (
                <>
                  <Play className="size-4" /> Play
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9 p-0"
              onClick={() => seekRelative(5000)}
              title="Step forward 5s"
            >
              <SkipForward className="size-4" />
            </Button>
          </div>

          {/* Playback Speed Multipliers: 1x, 2x, 4x, 10x */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Speed:</span>
            {[1, 2, 4, 10].map((s) => (
              <Button
                key={s}
                variant={speed === s ? "default" : "outline"}
                size="sm"
                className="h-8 px-2.5 text-xs font-mono"
                onClick={() => setSpeed(s)}
              >
                {s}x
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

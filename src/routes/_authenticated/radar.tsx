import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Boxes, Radar, ScatterChart } from "lucide-react";
import { roomsQuery } from "@/lib/data";
import { isStale, useLive } from "@/lib/radar/live";
import { Empty, PageHeader, Panel, Pill, SimTag, timeAgo } from "@/components/app/status";
import { ModeToggle, SimControls } from "@/components/app/sim-controls";
import { LD2450View } from "@/components/radar/ld2450-view";
import { RD61View } from "@/components/radar/rd61-view";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/radar")({
  head: () => ({
    meta: [
      { title: "Radar Visualization — RoomTrace" },
      { name: "description", content: "Top-down LD2450 target map and RD-61 point cloud." },
      { property: "og:title", content: "Radar Visualization — RoomTrace" },
      { property: "og:description", content: "Top-down LD2450 target map and RD-61 point cloud." },
    ],
  }),
  component: RadarPage,
});

function RadarPage() {
  const { data: rooms = [], isLoading } = useQuery(roomsQuery);
  const live = useLive();
  const room = rooms.find((r) => r.id === live.selectedRoomId);
  const [sel, setSel] = useState<number | null>(null);
  const [trails, setTrails] = useState(true);
  const [showZones, setShowZones] = useState(true);
  const [showObjects, setShowObjects] = useState(true);
  const [persistence, setPersistence] = useState(6);
  const f = room ? live.frames[room.id] : undefined;
  const sim = live.mode === "simulation";
  const target = f?.ld?.targets.find((t) => t.target_id === sel);

  if (!isLoading && !room)
    return (
      <>
        <PageHeader title="Radar Visualization" />
        <Panel>
          <Empty
            icon={<Boxes className="size-5" />}
            title="No room selected"
            action={
              <Button asChild>
                <Link to="/rooms">Create a room</Link>
              </Button>
            }
          >
            Radar views are drawn to each room's configured dimensions.
          </Empty>
        </Panel>
      </>
    );

  return (
    <div>
      <PageHeader
        title="Radar Visualization"
        description="The two sensors produce different data and are shown separately."
        actions={
          <>
            <ModeToggle />
            <SimControls roomId={room?.id ?? null} />
          </>
        }
      />
      <Tabs defaultValue="ld2450">
        <TabsList className="mb-4">
          <TabsTrigger value="ld2450">
            <Radar className="size-4" /> LD2450 · 24 GHz targets
          </TabsTrigger>
          <TabsTrigger value="rd61">
            <ScatterChart className="size-4" /> RD-61 · 60 GHz point cloud
          </TabsTrigger>
        </TabsList>
        <TabsContent value="ld2450">
          <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  Target coordinates {sim && <SimTag />}
                </span>
              }
              subtitle="Scroll to zoom, drag to pan, click a target to inspect"
              action={
                <>
                  <div className="flex items-center gap-2">
                    <Switch id="trails" checked={trails} onCheckedChange={setTrails} />
                    <Label htmlFor="trails" className="text-xs">
                      Trails
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch id="zones" checked={showZones} onCheckedChange={setShowZones} />
                    <Label htmlFor="zones" className="text-xs">
                      Zones
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch id="objects" checked={showObjects} onCheckedChange={setShowObjects} />
                    <Label htmlFor="objects" className="text-xs">
                      Furniture
                    </Label>
                  </div>
                  <Pill
                    t={isStale(f?.ld?.timestamp, live.now) ? "warning" : "success"}
                    pulse={!isStale(f?.ld?.timestamp, live.now)}
                  >
                    {isStale(f?.ld?.timestamp, live.now) ? "Stale" : "Streaming"}
                  </Pill>
                </>
              }
            >
              {room && f?.ld ? (
                <LD2450View
                  widthMm={room.width_mm}
                  lengthMm={room.length_mm}
                  doors={room.doors}
                  zones={room.zones}
                  objects={room.objects}
                  showZones={showZones}
                  showObjects={showObjects}
                  frame={f.ld}
                  selected={sel}
                  onSelect={setSel}
                  showTrails={trails}
                  stale={isStale(f.ld.timestamp, live.now)}
                  door={sim}
                />
              ) : (
                <Empty icon={<Radar className="size-5" />} title="No LD2450 frames">
                  {sim
                    ? "Simulation is stopped or the sensor is disconnected."
                    : "No hardware LD2450 telemetry for this room yet."}
                </Empty>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                Dashed sector = LD2450 field of view (±60°, 6 m). Rings are 1 m apart. Arrows show
                radial motion: amber away from the sensor, green towards it.
              </p>
            </Panel>
            <Panel
              title="Target inspector"
              subtitle={target ? `Tracking target #${target.target_id}` : "Nothing selected"}
            >
              {target ? (
                <dl className="space-y-3 text-sm">
                  {[
                    ["Target ID", `#${target.target_id}`],
                    ["X coordinate", `${target.x_mm} mm`],
                    ["Y coordinate", `${target.y_mm} mm`],
                    ["Distance", `${Math.round(Math.hypot(target.x_mm, target.y_mm))} mm`],
                    [
                      "Angle",
                      `${((Math.atan2(target.x_mm, target.y_mm) * 180) / Math.PI).toFixed(1)}°`,
                    ],
                    ["Speed", `${target.speed_cms} cm/s`],
                    ["Frame", timeAgo(f?.ld?.timestamp, live.now)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b pb-2 last:border-0">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-mono tabular">{v}</dd>
                    </div>
                  ))}
                  <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    {Math.abs(target.speed_cms) <= 15
                      ? "No meaningful radial motion."
                      : target.speed_cms > 0
                        ? "Moving away from the sensor."
                        : "Moving towards the sensor."}
                  </div>
                  {sim && <SimTag />}
                </dl>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {sel ? "Target no longer tracked." : "Select a target on the map."}
                </p>
              )}
            </Panel>
          </div>
        </TabsContent>
        <TabsContent value="rd61">
          <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
            <Panel
              title={
                <span className="flex flex-wrap items-center gap-2">
                  RD-61 Point cloud (top-down) {sim && <SimTag />}
                  <Pill t="warning">Experimental · Protocol Unverified (FW #2967)</Pill>
                </span>
              }
              subtitle="Hover a reflection to read coordinates and Doppler velocity"
              action={
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Switch id="rd-zones" checked={showZones} onCheckedChange={setShowZones} />
                    <Label htmlFor="rd-zones" className="text-xs">
                      Zones
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="rd-objects"
                      checked={showObjects}
                      onCheckedChange={setShowObjects}
                    />
                    <Label htmlFor="rd-objects" className="text-xs">
                      Furniture
                    </Label>
                  </div>
                  <div className="flex w-36 items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Trails
                    </span>
                    <Slider
                      value={[persistence]}
                      min={1}
                      max={12}
                      step={1}
                      onValueChange={(v) => setPersistence(v[0] ?? 6)}
                      aria-label="Persistence in frames"
                    />
                    <span className="w-4 text-right font-mono text-xs tabular">{persistence}</span>
                  </div>
                </div>
              }
            >
              {room && f?.rd ? (
                <RD61View
                  widthMm={room.width_mm}
                  lengthMm={room.length_mm}
                  doors={room.doors}
                  zones={room.zones}
                  objects={room.objects}
                  showZones={showZones}
                  showObjects={showObjects}
                  frame={f.rd}
                  persistence={persistence}
                />
              ) : (
                <Empty icon={<ScatterChart className="size-5" />} title="No RD-61 frames">
                  {sim
                    ? "Simulation is stopped or the sensor is disconnected."
                    : "No hardware RD-61 point cloud for this room yet."}
                </Empty>
              )}
            </Panel>
            <Panel
              title="Point cloud stats"
              hint="The RD-61 reports raw reflection points, not identified people. These values describe the latest frame."
            >
              {f?.rd ? (
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Points</dt>
                    <dd className="font-mono tabular">{f.rd.points.length}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Moving points</dt>
                    <dd className="font-mono tabular">
                      {f.rd.points.filter((p) => Math.abs(p.doppler) > 0.15).length}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Mean SNR</dt>
                    <dd className="font-mono tabular">
                      {(
                        f.rd.points.reduce((a, p) => a + p.snr, 0) / Math.max(1, f.rd.points.length)
                      ).toFixed(1)}{" "}
                      dB
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Height range</dt>
                    <dd className="font-mono tabular">
                      {Math.min(...f.rd.points.map((p) => p.z_mm))}–
                      {Math.max(...f.rd.points.map((p) => p.z_mm))} mm
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">No data.</p>
              )}
              <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
                Colour shows motion, dot size shows signal strength. Older frames fade out over the
                trail length you set.
              </p>
            </Panel>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

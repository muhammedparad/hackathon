import { createFileRoute, Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileSearch,
  History,
  ShieldAlert,
} from "lucide-react";
import { eventsQuery, fetchEvents, roomsQuery, type EventFilters } from "@/lib/data";
import { EVENT_LABELS, EVENT_TYPES, type AlertSeverity, type EventType } from "@/lib/radar/types";
import { firebaseDb, type OccupancyEvent } from "@/lib/firebase/db";
import { Empty, PageHeader, Panel, SimTag } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/events")({
  head: () => ({
    meta: [
      { title: "Event History — RoomTrace" },
      {
        name: "description",
        content: "Searchable log of detections, occupancy changes and sensor events.",
      },
      { property: "og:title", content: "Event History — RoomTrace" },
      {
        property: "og:description",
        content: "Searchable log of detections, occupancy changes and sensor events.",
      },
    ],
  }),
  component: EventsPage,
});

const PAGE = 25;

export function SeverityBadge({
  severity,
}: {
  severity: AlertSeverity | string | null | undefined;
}) {
  const s = severity ?? "info";
  const styles: Record<string, string> = {
    critical: "bg-destructive/15 text-destructive border-destructive/30",
    high: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
    medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    low: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
    info: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border",
        styles[s] ?? styles["info"],
      )}
    >
      {s}
    </span>
  );
}

function EventsPage() {
  const { data: rooms = [] } = useQuery(roomsQuery);
  const qc = useQueryClient();
  const [date, setDate] = useState("");
  const [room, setRoom] = useState("all");
  const [type, setType] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [sensor, setSensor] = useState("all");
  const [ackFilter, setAckFilter] = useState("all");
  const [sim, setSim] = useState(true);
  const [page, setPage] = useState(0);

  // Evidence modal state
  const [selectedEvidenceEvent, setSelectedEvidenceEvent] = useState<OccupancyEvent | null>(null);

  const f: EventFilters = {
    from: date ? new Date(date + "T00:00:00").toISOString() : undefined,
    to: date ? new Date(date + "T23:59:59").toISOString() : undefined,
    roomId: room === "all" ? undefined : room,
    eventType: type === "all" ? undefined : type,
    severity: severity === "all" ? undefined : (severity as AlertSeverity),
    sensorType: sensor === "all" ? undefined : sensor,
    acknowledged: ackFilter === "all" ? undefined : ackFilter === "ack",
    includeSimulated: sim,
    page,
    pageSize: PAGE,
  };

  const q = useQuery({ ...eventsQuery(f), placeholderData: keepPreviousData });
  const total = q.data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const roomName = (id: string | null) => rooms.find((r) => r.id === id)?.name ?? "—";
  const reset =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v);
      setPage(0);
    };

  const handleAcknowledge = async (e: OccupancyEvent) => {
    if (!e.id) return;
    try {
      await firebaseDb.acknowledgeEvent({
        eventId: e.id,
        roomId: e.room_id,
        simulated: e.simulated ?? true,
        userId: "user",
      });
      toast.success("Alert acknowledged");
      qc.invalidateQueries({ queryKey: ["events"] });
      if (selectedEvidenceEvent && selectedEvidenceEvent.id === e.id) {
        setSelectedEvidenceEvent({
          ...selectedEvidenceEvent,
          acknowledged: true,
          acknowledged_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to acknowledge event");
    }
  };

  const exportCsv = async () => {
    const rows: OccupancyEvent[] = [];
    for (let p = 0; p < 10; p++) {
      const data = await fetchEvents({ ...f, page: p, pageSize: 1000 });
      rows.push(...data.rows);
      if (data.rows.length < 1000) break;
    }
    if (!rows.length) {
      toast.info("Nothing to export");
      return;
    }
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      "timestamp,room,event,severity,sensor,target_id,zone,details,evidence_quality,confidence,acknowledged,source",
      ...rows.map((r) =>
        [
          r.timestamp,
          roomName(r.room_id),
          r.event_type,
          r.severity ?? "info",
          r.sensor_type,
          r.target_id,
          r.zone_name ?? r.zone_id ?? "",
          r.description,
          r.evidence?.evidence_quality ??
            r.evidence_quality ??
            (r.confidence === "high"
              ? "High Evidence Quality"
              : r.confidence === "medium"
                ? "Moderate Evidence Quality"
                : "Screening Heuristic — Experimental"),
          r.confidence != null ? String(r.confidence).toUpperCase() : "",
          r.acknowledged ? "yes" : "no",
          r.simulated ? "simulated" : "hardware",
        ]
          .map(esc)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `roomtrace-events-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} events`);
  };

  return (
    <div>
      <PageHeader
        title="Event History"
        description="Searchable log of detections, occupancy changes and explainable alerts."
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="size-4" /> Export CSV
          </Button>
        }
      />

      {/* Filter controls bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-card">
        <Input
          type="date"
          value={date}
          onChange={(e) => reset(setDate)(e.target.value)}
          className="h-9 w-36"
          aria-label="Date"
        />
        <Select value={room} onValueChange={reset(setRoom)}>
          <SelectTrigger className="h-9 w-36" aria-label="Room">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rooms</SelectItem>
            {rooms.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={reset(setType)}>
          <SelectTrigger className="h-9 w-44" aria-label="Event type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {EVENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {EVENT_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={reset(setSeverity)}>
          <SelectTrigger className="h-9 w-32" aria-label="Severity">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </SelectContent>
        </Select>
        <Select value={ackFilter} onValueChange={reset(setAckFilter)}>
          <SelectTrigger className="h-9 w-36" aria-label="Status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="unack">Unacknowledged</SelectItem>
            <SelectItem value="ack">Acknowledged</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sensor} onValueChange={reset(setSensor)}>
          <SelectTrigger className="h-9 w-32" aria-label="Sensor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sensors</SelectItem>
            <SelectItem value="ld2450">LD2450</SelectItem>
            <SelectItem value="rd61">RD-61</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Switch id="sim-e" checked={sim} onCheckedChange={reset(setSim)} />
          <Label htmlFor="sim-e" className="text-sm">
            Include simulated
          </Label>
        </div>
      </div>

      {/* Main events table */}
      <Panel className="overflow-hidden [&>div]:p-0">
        {q.isLoading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !q.data?.rows.length ? (
          <Empty icon={<History className="size-5" />} title="No events match">
            Try clearing filters, or run the simulation to generate events.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  {[
                    "Timestamp",
                    "Room",
                    "Event",
                    "Severity",
                    "Sensor",
                    "Target",
                    "Details",
                    "Status",
                    "Actions",
                  ].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((e) => (
                  <tr key={e.id} className="border-t hover:bg-muted/40 transition-colors">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs tabular">
                      {new Date(e.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 font-medium">{roomName(e.room_id)}</td>
                    <td className="whitespace-nowrap px-4 font-medium">
                      {EVENT_LABELS[e.event_type as EventType] ?? e.event_type}
                    </td>
                    <td className="px-4">
                      <SeverityBadge severity={e.severity} />
                    </td>
                    <td className="px-4 font-mono text-xs">
                      {e.sensor_type === "ld2450"
                        ? "LD2450"
                        : e.sensor_type === "rd61"
                          ? "RD-61"
                          : "—"}
                    </td>
                    <td className="px-4 font-mono">{e.target_id ? `#${e.target_id}` : "—"}</td>
                    <td className="max-w-xs truncate px-4 text-muted-foreground">
                      {e.description}
                    </td>
                    <td className="whitespace-nowrap px-4">
                      {e.acknowledged ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400 font-medium">
                          <CheckCircle2 className="size-3.5" /> Ack
                        </span>
                      ) : e.severity && e.severity !== "info" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => handleAcknowledge(e)}
                        >
                          Ack
                        </Button>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 flex items-center gap-2 py-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs flex items-center gap-1"
                        onClick={() => setSelectedEvidenceEvent(e)}
                      >
                        <FileSearch className="size-3" /> Evidence
                      </Button>
                      {e.simulated && <SimTag />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t px-5 py-3 text-sm text-muted-foreground">
          <span>
            {total.toLocaleString()} events · page {page + 1} of {pages}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={page + 1 >= pages}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </Panel>

      {/* Explainable Alert Evidence Modal */}
      <Dialog
        open={selectedEvidenceEvent !== null}
        onOpenChange={(open) => !open && setSelectedEvidenceEvent(null)}
      >
        {selectedEvidenceEvent && (
          <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <div className="flex items-center justify-between gap-2 pr-6">
                <DialogTitle className="flex items-center gap-2 text-lg">
                  {EVENT_LABELS[selectedEvidenceEvent.event_type as EventType] ??
                    selectedEvidenceEvent.event_type}
                  <SeverityBadge severity={selectedEvidenceEvent.severity} />
                  {selectedEvidenceEvent.simulated && <SimTag />}
                </DialogTitle>
              </div>
              <DialogDescription>
                {roomName(selectedEvidenceEvent.room_id)} ·{" "}
                {new Date(selectedEvidenceEvent.timestamp).toLocaleString()}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Plain-English summary */}
              <div className="rounded-lg border bg-muted/40 p-3.5 space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <FileSearch className="size-3.5" /> Explainable Evidence Summary
                </div>
                <p className="text-sm leading-relaxed text-foreground font-medium">
                  {selectedEvidenceEvent.evidence?.summary || selectedEvidenceEvent.description}
                </p>
              </div>

              {/* Measured Metrics vs Thresholds */}
              <div className="rounded-lg border p-3.5 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Detection Criteria & Measured Values
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Rule ID:</span>{" "}
                    <span className="font-mono font-medium">
                      {selectedEvidenceEvent.evidence?.rule_id || selectedEvidenceEvent.event_type}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Zone / Location:</span>{" "}
                    <span className="font-medium">
                      {selectedEvidenceEvent.zone_name ||
                        (selectedEvidenceEvent.zone_id
                          ? `Zone ${selectedEvidenceEvent.zone_id}`
                          : selectedEvidenceEvent.x_mm != null
                            ? `Floor area (${selectedEvidenceEvent.x_mm}, ${selectedEvidenceEvent.y_mm})`
                            : "General room")}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Measured Value:</span>{" "}
                    <span className="font-semibold text-primary">
                      {selectedEvidenceEvent.evidence?.measured_value ?? "Detected in frame"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Configured Threshold:</span>{" "}
                    <span className="font-mono text-muted-foreground">
                      {selectedEvidenceEvent.evidence?.threshold_value ?? "Geometric boundary"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Target / Sensor:</span>{" "}
                    <span className="font-mono">
                      {selectedEvidenceEvent.target_id
                        ? `#${selectedEvidenceEvent.target_id}`
                        : "—"}{" "}
                      / {selectedEvidenceEvent.sensor_type?.toUpperCase() ?? "LD2450"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Radar Coordinates:</span>{" "}
                    <span className="font-mono text-[11px]">
                      {selectedEvidenceEvent.x_mm != null
                        ? `X:${selectedEvidenceEvent.x_mm} Y:${selectedEvidenceEvent.y_mm} mm`
                        : "—"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Confidence & Evidence Quality */}
              {(() => {
                const qualityLabel =
                  selectedEvidenceEvent.evidence?.evidence_quality ??
                  selectedEvidenceEvent.evidence_quality ??
                  (selectedEvidenceEvent.confidence === "high"
                    ? "High Evidence Quality"
                    : selectedEvidenceEvent.confidence === "medium"
                      ? "Moderate Evidence Quality"
                      : "Screening Heuristic — Experimental");

                return (
                  <div className="rounded-lg border p-3.5 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Evidence Quality Rating
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {qualityLabel === "High Evidence Quality"
                          ? "High signal fidelity — verified geometric boundary transition"
                          : qualityLabel === "Moderate Evidence Quality"
                            ? "Moderate evidence — rule heuristic matched trajectory"
                            : "Screening heuristic — uncalibrated rule-based screening"}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-semibold px-2.5 py-1 text-xs whitespace-nowrap",
                          qualityLabel === "High Evidence Quality" &&
                            "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
                          qualityLabel === "Moderate Evidence Quality" &&
                            "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
                          qualityLabel === "Screening Heuristic — Experimental" &&
                            "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
                        )}
                      >
                        {qualityLabel}
                      </Badge>
                      <div className="text-[10px] text-muted-foreground font-medium uppercase mt-1">
                        Qualitative Rating
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Privacy & Limitations Disclaimer */}
              <div
                className={cn(
                  "rounded-lg border p-3.5 text-xs space-y-1.5",
                  selectedEvidenceEvent.event_type === "candidate_fall"
                    ? "bg-rose-500/10 border-rose-500/30 text-rose-950 dark:text-rose-200"
                    : "bg-amber-500/10 border-amber-500/30 text-amber-950 dark:text-amber-200",
                )}
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="size-4 shrink-0" />
                  {selectedEvidenceEvent.event_type === "candidate_fall"
                    ? "Candidate Fall — Experimental Heuristic"
                    : "Camera-Free Radar Sensing Limitations"}
                </div>
                <p className="text-[11px] leading-relaxed opacity-90">
                  {selectedEvidenceEvent.evidence?.limitations ||
                    (selectedEvidenceEvent.event_type === "candidate_fall"
                      ? "Experimental Heuristic: Candidate fall detection monitors velocity spikes followed by floor-level inactivity. It is not a certified medical alarm, clinical monitor, or emergency response service."
                      : "Camera-Free Awareness: RoomTrace does not use optical lenses, video cameras, or facial biometric models. It analyzes anonymous radar reflection points and spatial geometries.")}
                </p>
              </div>
            </div>

            <DialogFooter className="flex sm:justify-between items-center gap-2 pt-2">
              <div>
                {!selectedEvidenceEvent.acknowledged ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleAcknowledge(selectedEvidenceEvent)}
                    className="flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="size-4" /> Acknowledge Alert
                  </Button>
                ) : (
                  <span className="text-xs text-green-600 dark:text-green-400 font-medium flex items-center gap-1">
                    <CheckCircle2 className="size-3.5" /> Acknowledged{" "}
                    {selectedEvidenceEvent.acknowledged_at
                      ? `at ${new Date(selectedEvidenceEvent.acknowledged_at).toLocaleTimeString()}`
                      : ""}
                  </span>
                )}
              </div>
              <Link
                to="/playback"
                search={{
                  roomId: selectedEvidenceEvent.room_id,
                  t: new Date(selectedEvidenceEvent.timestamp).getTime(),
                  targetId: selectedEvidenceEvent.target_id ?? undefined,
                }}
              >
                <Button size="sm" className="flex items-center gap-1.5">
                  <ExternalLink className="size-4" /> Inspect Route in Playback
                </Button>
              </Link>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

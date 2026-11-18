import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Cpu, KeyRound, Plus, Settings2, Trash2 } from "lucide-react";
import { firebaseDb } from "@/lib/firebase/db";
import { devicesQuery, roomsQuery, sensorsQuery, type Sensor } from "@/lib/data";
import { registerDevice, rotateDeviceSecret } from "@/lib/devices.functions";
import { useLive } from "@/lib/radar/live";
import { deviceConnection } from "@/lib/radar/types";
import { ConnBadge, Empty, Hint, PageHeader, Panel, timeAgo } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/devices")({
  head: () => ({
    meta: [
      { title: "Devices & Sensors — RoomTrace" },
      {
        name: "description",
        content: "Register ESP32-S3 devices and configure LD2450 and RD-61 radars.",
      },
      { property: "og:title", content: "Devices & Sensors — RoomTrace" },
      {
        property: "og:description",
        content: "Register ESP32-S3 devices and configure LD2450 and RD-61 radars.",
      },
    ],
  }),
  component: DevicesPage,
});

const BAUDS = [9600, 57600, 115200, 256000];

function DevicesPage() {
  const devices = useQuery(devicesQuery);
  const sensors = useQuery(sensorsQuery);
  const rooms = useQuery(roomsQuery);
  const live = useLive();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ device_id: string; secret: string } | null>(null);
  const [del, setDel] = useState<{ id: string; name: string } | null>(null);
  const [editSensor, setEditSensor] = useState<Sensor | null>(null);
  const rotate = useServerFn(rotateDeviceSecret);

  const remove = async (id: string) => {
    try {
      await firebaseDb.deleteDevice(id);
    } catch {
      /* fallback to local cache */
    }
    try {
      const raw = localStorage.getItem("roomtrace_local_devices");
      if (raw) {
        const devs = JSON.parse(raw) as Array<{ id: string }>;
        localStorage.setItem(
          "roomtrace_local_devices",
          JSON.stringify(devs.filter((d) => d.id !== id)),
        );
      }
    } catch {
      /* ignore */
    }
    toast.success("Device removed");
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["sensors"] });
  };

  return (
    <div>
      <PageHeader
        title="Devices & Sensors"
        description="Status only shows Connected after the backend receives an authenticated heartbeat or telemetry from the device."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Register ESP32-S3
          </Button>
        }
      />
      {devices.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (devices.data ?? []).length === 0 ? (
        <Panel>
          <Empty
            icon={<Cpu className="size-5" />}
            title="No devices registered"
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus className="size-4" /> Register device
              </Button>
            }
          >
            Register your ESP32-S3 to get a device ID and secret for the firmware. Until it reports
            in, it will show as Unknown.
          </Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {(devices.data ?? []).map((d) => {
            const conn = deviceConnection(d.last_seen, live.now);
            const ss = (sensors.data ?? []).filter((s) => s.device_id === d.id);
            return (
              <div key={d.id} className="rounded-xl border bg-card shadow-card">
                <div className="flex flex-wrap items-center gap-4 border-b p-5">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary">
                    <Cpu className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{d.device_name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {d.device_id} · ESP32-S3
                    </div>
                  </div>
                  <ConnBadge s={conn} />
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          const r = await rotate({ data: { id: d.id } });
                          setSecret({ device_id: d.device_id, secret: r.secret });
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <KeyRound className="size-3.5" /> New secret
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDel({ id: d.id, name: d.device_name })}
                      aria-label="Remove device"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2 lg:grid-cols-5">
                  <Field k="Firmware" v={d.firmware_version ?? "Not reported"} />
                  <Field k="IP address" v={d.ip_address ?? "Not reported"} />
                  <Field k="Last heartbeat" v={timeAgo(d.last_seen, live.now)} />
                  <Field
                    k="Room"
                    v={(rooms.data ?? []).find((r) => r.id === d.room_id)?.name ?? "Unassigned"}
                  />
                  <Field k="State" v={conn === "unknown" ? "Never reported" : conn} />
                </div>
                <div className="grid gap-3 border-t bg-muted/30 p-5 md:grid-cols-2">
                  {ss.length === 0 && (
                    <p className="text-sm text-muted-foreground">No sensors fitted.</p>
                  )}
                  {ss.map((s) => {
                    const c = s.configuration as Record<string, string | number>;
                    return (
                      <div key={s.id} className="rounded-lg border bg-card p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium">{s.model}</div>
                            <div className="text-xs text-muted-foreground">
                              {s.sensor_type === "ld2450"
                                ? "24 GHz · target tracking"
                                : "60 GHz · point cloud"}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <ConnBadge
                              s={
                                conn === "connected" && s.status === "connected"
                                  ? "connected"
                                  : conn === "connected"
                                    ? "unknown"
                                    : conn
                              }
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              onClick={() => setEditSensor(s)}
                              aria-label="Configure sensor"
                            >
                              <Settings2 className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          {s.sensor_type === "ld2450" ? (
                            <>
                              <Field k="UART" v={String(c["uart"] ?? "—")} />
                              <Field k="Baud rate" v={String(c["baud_rate"] ?? "—")} />
                            </>
                          ) : (
                            <>
                              <Field k="Interface" v={String(c["interface"] ?? "—")} />
                              <Field k="Firmware" v={String(c["firmware_version"] || "—")} />
                              <Field k="Data mode" v={String(c["data_mode"] ?? "—")} />
                            </>
                          )}
                          <Field
                            k="Mounting"
                            v={String(
                              c["mount_height_mm"]
                                ? `${c["mount_height_mm"]} mm high`
                                : "Near wall, centre",
                            )}
                          />
                        </dl>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <RegisterDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(r) => {
          setAdding(false);
          setSecret(r);
        }}
      />
      <SensorDialog sensor={editSensor} onClose={() => setEditSensor(null)} />
      <SecretDialog value={secret} onClose={() => setSecret(null)} />
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{del?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The device, its sensors and its stored telemetry will be deleted. Its secret stops
              working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => del && remove(del.id)}
            >
              Remove device
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="mt-0.5 truncate font-medium capitalize-first">{v}</dd>
    </div>
  );
}

function RegisterDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (r: { device_id: string; secret: string }) => void;
}) {
  const reg = useServerFn(registerDevice);
  const qc = useQueryClient();
  const { data: rooms = [] } = useQuery(roomsQuery);
  const [busy, setBusy] = useState(false);
  const [ld, setLd] = useState(true);
  const [rd, setRd] = useState(true);
  const [room, setRoom] = useState<string>("none");
  const [baud, setBaud] = useState("256000");
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const r = await reg({
        data: {
          device_name: String(fd.get("name")),
          device_id: String(fd.get("did")),
          room_id: room === "none" ? null : room,
          ld2450: { enabled: ld, uart: String(fd.get("uart") || "UART1"), baud: Number(baud) },
          rd61: {
            enabled: rd,
            kit: "RD-60-Kit",
            firmware: String(fd.get("rdfw") || ""),
            data_mode: String(fd.get("mode") || "point_cloud"),
          },
        },
      });
      void qc.invalidateQueries({ queryKey: ["devices"] });
      void qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Device registered");
      onCreated(r);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not register device");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Register ESP32-S3</DialogTitle>
          <DialogDescription>
            You'll receive a device secret once. Flash it into the firmware — it is never shown
            again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="name">Device name</Label>
              <Input id="name" name="name" required maxLength={80} placeholder="Lab node 1" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="did">Device ID</Label>
              <Input
                id="did"
                name="did"
                required
                pattern="[A-Za-z0-9_\-]{3,64}"
                placeholder="esp32-lab-01"
                className="font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Room</Label>
            <Select value={room} onValueChange={setRoom}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="ld">HLK-LD2450 · 24 GHz</Label>
              <Switch id="ld" checked={ld} onCheckedChange={setLd} />
            </div>
            {ld && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="uart" className="text-xs">
                    UART port
                  </Label>
                  <Input id="uart" name="uart" defaultValue="UART1" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Baud rate <Hint>The LD2450 ships at 256000 baud.</Hint>
                  </Label>
                  <Select value={baud} onValueChange={setBaud}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BAUDS.map((b) => (
                        <SelectItem key={b} value={String(b)}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="rd">Ai-Thinker RD-61 · 60 GHz (via RD-60-Kit)</Label>
              <Switch id="rd" checked={rd} onCheckedChange={setRd} />
            </div>
            {rd && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rdfw" className="text-xs">
                    RD-61 firmware{" "}
                    <Hint>
                      Target firmware #2967 (Standard Point Cloud V1.0.0). Protocol unverified; do
                      not use #2978.
                    </Hint>
                  </Label>
                  <Input id="rdfw" name="rdfw" defaultValue="#2967" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mode" className="text-xs">
                    Data mode
                  </Label>
                  <Input id="mode" name="mode" defaultValue="point_cloud" />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Registering…" : "Register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SensorDialog({ sensor, onClose }: { sensor: Sensor | null; onClose: () => void }) {
  const qc = useQueryClient();
  const c = (sensor?.configuration ?? {}) as Record<string, string | number>;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!sensor) return;
    const fd = new FormData(e.currentTarget);
    const next: Record<string, string | number> = { ...c };
    for (const [k, v] of fd.entries()) {
      const s = String(v).trim();
      next[k] = /^\d+$/.test(s) ? Number(s) : s;
    }
    try {
      await firebaseDb.updateSensor(sensor.id, { configuration: next });
    } catch {
      /* fallback to local cache */
    }
    try {
      const raw = localStorage.getItem("roomtrace_local_sensors");
      if (raw) {
        const sens = JSON.parse(raw) as Array<{ id: string; configuration?: unknown }>;
        const updated = sens.map((s) => (s.id === sensor.id ? { ...s, configuration: next } : s));
        localStorage.setItem("roomtrace_local_sensors", JSON.stringify(updated));
      }
    } catch {
      /* ignore */
    }
    toast.success("Sensor configuration saved");
    void qc.invalidateQueries({ queryKey: ["sensors"] });
    onClose();
  };
  return (
    <Dialog open={!!sensor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {sensor?.model}</DialogTitle>
          <DialogDescription>
            Stored configuration for your firmware to read. Changes are not pushed to the device
            automatically.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" key={sensor?.id}>
          {sensor?.sensor_type === "ld2450" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="s-uart">UART port</Label>
                <Input id="s-uart" name="uart" defaultValue={String(c["uart"] ?? "UART1")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-baud">Baud rate</Label>
                <Input
                  id="s-baud"
                  name="baud_rate"
                  type="number"
                  defaultValue={String(c["baud_rate"] ?? 256000)}
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="s-if">Interface</Label>
                <Input
                  id="s-if"
                  name="interface"
                  defaultValue={String(c["interface"] ?? "RD-60-Kit")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-fw">Firmware version</Label>
                <Input
                  id="s-fw"
                  name="firmware_version"
                  defaultValue={String(c["firmware_version"] ?? "")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-dm">Data mode</Label>
                <Input
                  id="s-dm"
                  name="data_mode"
                  defaultValue={String(c["data_mode"] ?? "point_cloud")}
                />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="s-h">Mount height (mm)</Label>
            <Input
              id="s-h"
              name="mount_height_mm"
              type="number"
              min={0}
              max={4000}
              defaultValue={String(c["mount_height_mm"] ?? "")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({
  value,
  onClose,
}: {
  value: { device_id: string; secret: string } | null;
  onClose: () => void;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const curl = value
    ? `curl -X POST ${origin}/api/public/device/telemetry \\\n  -H "Content-Type: application/json" \\\n  -H "X-Device-Id: ${value.device_id}" \\\n  -H "X-Device-Key: ${value.secret}" \\\n  -d '{"data":{"sensor_type":"ld2450","targets":[{"target_id":1,"x_mm":-250,"y_mm":1800,"speed_cms":12}]}}'`
    : "";
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Device secret</DialogTitle>
          <DialogDescription>
            Copy it now. For security it is stored only as a hash and can't be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border bg-muted p-3 font-mono text-sm">
          <span className="flex-1 break-all">{value?.secret}</span>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(value?.secret ?? "");
              toast.success("Copied");
            }}
            aria-label="Copy secret"
          >
            <Copy className="size-4" />
          </Button>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Example telemetry request
          </div>
          <pre className="overflow-auto rounded-lg bg-foreground p-3 text-[11px] leading-relaxed text-background">
            {curl}
          </pre>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I've saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

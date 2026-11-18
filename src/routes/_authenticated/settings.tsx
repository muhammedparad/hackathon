import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { firebaseDb } from "@/lib/firebase/db";
import { authClient, getAuthProviderType } from "@/lib/auth";
import { devicesQuery, roomsQuery } from "@/lib/data";
import { useLive } from "@/lib/radar/live";
import { STALE_AFTER_MS, HEARTBEAT_TIMEOUT_MS } from "@/lib/radar/types";
import { PageHeader, Panel, Pill } from "@/components/app/status";
import { ModeToggle, SimControls } from "@/components/app/sim-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — RoomTrace" },
      {
        name: "description",
        content: "Account, data source, simulation and notification settings.",
      },
      { property: "og:title", content: "Settings — RoomTrace" },
      {
        property: "og:description",
        content: "Account, data source, simulation and notification settings.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const live = useLive();
  const qc = useQueryClient();
  const { data: rooms = [] } = useQuery(roomsQuery);
  const { data: devices = [] } = useQuery(devicesQuery);
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState("");
  const [pw, setPw] = useState({ cur: "", next: "" });
  const [notif, setNotif] = useState({ occupancy: true, sensor: true, sound: false });

  const [authProvider, setAuthProvider] = useState(getAuthProviderType());

  useEffect(() => {
    void authClient.getUser().then((user) => {
      setEmail(user?.email ?? "");
      setCreated(user?.created_at ?? "");
    });
    setAuthProvider(getAuthProviderType());
    try {
      const n = localStorage.getItem("rt.notif");
      if (n) setNotif(JSON.parse(n));
    } catch {
      /* ignore */
    }
  }, []);
  const setN = (k: keyof typeof notif, v: boolean) => {
    const n = { ...notif, [k]: v };
    setNotif(n);
    localStorage.setItem("rt.notif", JSON.stringify(n));
  };

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.next.length < 6) {
      toast.error("New password must be at least 6 characters");
      return;
    }
    const { error } = await authClient.updateUser({ password: pw.next });
    if (error) {
      toast.error(error.message);
      return;
    }
    setPw({ cur: "", next: "" });
    toast.success("Password updated successfully");
  };

  const clearSim = async () => {
    try {
      for (const r of rooms) {
        await firebaseDb.clearSimulatedEvents(r.id);
        await firebaseDb.clearSimulatedTrajectories(r.id);
      }
    } catch {
      /* ignore */
    }
    void qc.invalidateQueries({ queryKey: ["events"] });
    void qc.invalidateQueries({ queryKey: ["analytics-events"] });
    toast.success("Simulated history cleared");
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <Panel title="Data source">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl text-sm">
            <p className="font-medium">
              {live.mode === "simulation" ? "Simulation mode" : "Hardware mode"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {live.mode === "simulation"
                ? "Synthetic LD2450 targets and RD-61 point clouds are generated in your browser. Everything is labelled SIMULATED."
                : "Only telemetry received from authenticated ESP32-S3 devices is shown. Nothing is generated."}
            </p>
          </div>
          <ModeToggle />
        </div>
        {live.mode === "hardware" && (
          <div className="mt-4 rounded-lg border bg-muted/40 p-3 text-sm">
            Hardware status:{" "}
            {devices.some((d) => d.last_seen) ? (
              <Pill t="success">Telemetry received</Pill>
            ) : (
              <Pill t="warning">Unverified — no device has reported yet</Pill>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Simulation">
        <div className="space-y-4">
          <SimControls roomId={live.selectedRoomId} />
          <div className="flex items-center justify-between gap-4 text-sm">
            <div>
              <p className="font-medium">Record simulated events</p>
              <p className="text-muted-foreground">
                Store simulated occupancy events so Analytics and Event History have data. They're
                flagged as simulated and can be filtered out.
              </p>
            </div>
            <Switch
              checked={live.persistSimEvents}
              onCheckedChange={live.setPersistSimEvents}
              aria-label="Record simulated events"
            />
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">
                Clear simulated history
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear simulated history?</AlertDialogTitle>
                <AlertDialogDescription>
                  All events flagged as simulated will be deleted. Hardware events are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={clearSim}>Clear</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Profile & account">
          <dl className="mb-5 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Member since</dt>
              <dd>{created ? new Date(created).toLocaleDateString() : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Auth Provider</dt>
              <dd className="font-mono text-xs uppercase px-1.5 py-0.5 rounded bg-muted font-semibold">
                {authProvider}
              </dd>
            </div>
          </dl>
          <form onSubmit={changePw} className="space-y-3">
            <p className="text-sm font-medium">Change password</p>
            <div className="space-y-1.5">
              <Label htmlFor="cur">Current password</Label>
              <Input
                id="cur"
                type="password"
                autoComplete="current-password"
                value={pw.cur}
                onChange={(e) => setPw({ ...pw, cur: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">New password</Label>
              <Input
                id="new"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={pw.next}
                onChange={(e) => setPw({ ...pw, next: e.target.value })}
              />
            </div>
            <Button type="submit" size="sm">
              Update password
            </Button>
          </form>
        </Panel>
        <Panel title="Notifications">
          {(
            [
              ["occupancy", "Occupancy changes", "When a room becomes occupied or vacant"],
              ["sensor", "Sensor status", "When a device disconnects or reconnects"],
              ["sound", "Sound", "Play a chime for new alerts"],
            ] as const
          ).map(([k, t, d]) => (
            <div
              key={k}
              className="flex items-center justify-between gap-4 border-b py-3 text-sm first:pt-0 last:border-0"
            >
              <div>
                <p className="font-medium">{t}</p>
                <p className="text-muted-foreground">{d}</p>
              </div>
              <Switch checked={notif[k]} onCheckedChange={(v) => setN(k, v)} aria-label={t} />
            </div>
          ))}
        </Panel>
        <Panel title="Room & device configuration">
          <p className="text-sm text-muted-foreground">
            {rooms.length} room(s) and {devices.length} device(s) configured.
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/rooms">Manage rooms</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/devices">Manage devices</Link>
            </Button>
          </div>
        </Panel>
        <div id="system">
          <Panel title="System information">
            <dl className="space-y-2 text-sm">
              {[
                ["Version", "RoomTrace 0.1"],
                ["Data flow", "ESP32-S3 → HTTPS → API → DB → Realtime"],
                ["Telemetry endpoint", "/api/public/device/telemetry"],
                ["Heartbeat endpoint", "/api/public/device/heartbeat"],
                ["Stale after", `${STALE_AFTER_MS / 1000} s`],
                ["Device timeout", `${HEARTBEAT_TIMEOUT_MS / 1000} s`],
                ["Realtime stream", live.streamStatus],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right font-mono text-xs">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">
              Hardware integration has not been tested with physical sensors yet.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

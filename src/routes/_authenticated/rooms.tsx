import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Armchair,
  BarChart3,
  Boxes,
  DoorOpen,
  Layers,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { firebaseDb } from "@/lib/firebase/db";
import {
  devicesQuery,
  roomsQuery,
  useRoomMutations,
  type Door,
  type Room,
  type RoomObject,
  type RoomZone,
} from "@/lib/data";
import { roomState, useLive } from "@/lib/radar/live";
import { Empty, PageHeader, Panel, RoomBadge } from "@/components/app/status";
import { LD2450View } from "@/components/radar/ld2450-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export const Route = createFileRoute("/_authenticated/rooms")({
  head: () => ({
    meta: [
      { title: "Rooms — RoomTrace" },
      {
        name: "description",
        content: "Create rooms, set dimensions, doors, zones, and assign radar sensors.",
      },
      { property: "og:title", content: "Rooms — RoomTrace" },
      {
        property: "og:description",
        content: "Create rooms, set dimensions, doors, zones, and assign radar sensors.",
      },
    ],
  }),
  component: RoomsPage,
});

function RoomsPage() {
  const rooms = useQuery(roomsQuery);
  const devices = useQuery(devicesQuery);
  const live = useLive();
  const qc = useQueryClient();
  const { remove } = useRoomMutations();
  const [edit, setEdit] = useState<Partial<Room> | null>(null);
  const [del, setDel] = useState<Room | null>(null);

  const assign = async (deviceId: string, roomId: string | null) => {
    try {
      await firebaseDb.assignDeviceRoom(deviceId, roomId);
    } catch {
      /* fallback to local cache */
    }
    try {
      const raw = localStorage.getItem("roomtrace_local_devices");
      if (raw) {
        const devs = JSON.parse(raw) as Array<{ id: string; room_id?: string | null }>;
        const updated = devs.map((d) => (d.id === deviceId ? { ...d, room_id: roomId } : d));
        localStorage.setItem("roomtrace_local_devices", JSON.stringify(updated));
      }
    } catch {
      /* ignore */
    }
    toast.success(roomId ? "Device assigned" : "Device unassigned");
    void qc.invalidateQueries({ queryKey: ["devices"] });
  };

  return (
    <div>
      <PageHeader
        title="Rooms"
        description="Each room is a rectangular or polygon floor plan with configured doors, hazard zones, and furniture."
        actions={
          <Button
            onClick={() =>
              setEdit({
                name: "",
                width_mm: 5000,
                length_mm: 4000,
                description: "",
                doors: [],
                zones: [],
                objects: [],
              })
            }
          >
            <Plus className="size-4" /> New room
          </Button>
        }
      />
      {rooms.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-80 rounded-xl" />
          ))}
        </div>
      ) : (rooms.data ?? []).length === 0 ? (
        <Panel>
          <Empty
            icon={<Boxes className="size-5" />}
            title="No rooms configured"
            action={
              <Button
                onClick={() =>
                  setEdit({
                    name: "",
                    width_mm: 5000,
                    length_mm: 4000,
                    description: "",
                    doors: [],
                    zones: [],
                    objects: [],
                  })
                }
              >
                <Plus className="size-4" /> Create room
              </Button>
            }
          >
            Rooms define the floor plan, boundary zones, and doors used by radar visualization and
            collision routing.
          </Empty>
        </Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(rooms.data ?? []).map((r) => {
            const devs = (devices.data ?? []).filter((d) => d.room_id === r.id);
            const free = (devices.data ?? []).filter((d) => d.room_id !== r.id);
            const doorCount = r.doors?.length ?? 0;
            const zoneCount = r.zones?.length ?? 0;
            const objCount = r.objects?.length ?? 0;
            return (
              <div key={r.id} className="flex flex-col rounded-xl border bg-card shadow-card">
                <div className="flex items-start justify-between gap-2 p-5 pb-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{r.name}</h3>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.description || "No description"}
                    </p>
                  </div>
                  <RoomBadge s={roomState(live.frames[r.id], live.now, live.mode)} />
                </div>
                <div className="px-5">
                  <LD2450View
                    compact
                    widthMm={r.width_mm}
                    lengthMm={r.length_mm}
                    doors={r.doors}
                    zones={r.zones}
                    objects={r.objects}
                    frame={live.frames[r.id]?.ld}
                    showTrails={false}
                  />
                </div>
                <div className="space-y-3 p-5 pt-3 text-sm">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Dimensions</span>
                    <span className="font-mono text-foreground">
                      {r.width_mm} × {r.length_mm} mm
                    </span>
                  </div>

                  {/* Floor plan features pill bar */}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded bg-muted/70 px-2 py-0.5">
                      <DoorOpen className="size-3" /> {doorCount}{" "}
                      {doorCount === 1 ? "door" : "doors"}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded bg-muted/70 px-2 py-0.5">
                      <ShieldAlert className="size-3" /> {zoneCount}{" "}
                      {zoneCount === 1 ? "zone" : "zones"}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded bg-muted/70 px-2 py-0.5">
                      <Armchair className="size-3" /> {objCount}{" "}
                      {objCount === 1 ? "object" : "objects"}
                    </span>
                  </div>

                  <div>
                    <div className="mb-1.5 text-xs text-muted-foreground">Assigned devices</div>
                    <div className="flex flex-wrap gap-1.5">
                      {devs.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => assign(d.id, null)}
                          title="Click to unassign"
                          className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs hover:bg-destructive/10 hover:text-destructive"
                        >
                          {d.device_id} ×
                        </button>
                      ))}
                      {free.length > 0 && (
                        <Select value="" onValueChange={(v) => assign(v, r.id)}>
                          <SelectTrigger
                            className="h-6 w-auto gap-1 border-dashed px-2 text-xs"
                            aria-label="Assign device"
                          >
                            <SelectValue placeholder="+ Assign" />
                          </SelectTrigger>
                          <SelectContent>
                            {free.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.device_name} ({d.device_id})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {devs.length === 0 && free.length === 0 && (
                        <Link to="/devices" className="text-xs text-primary hover:underline">
                          Register a device
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-auto flex gap-1 border-t p-2">
                  <Button variant="ghost" size="sm" onClick={() => setEdit(r)}>
                    <Pencil className="size-3.5" /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/analytics" search={{ room: r.id }}>
                      <BarChart3 className="size-3.5" /> Analytics
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-destructive hover:text-destructive"
                    onClick={() => setDel(r)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <RoomDialog room={edit} onClose={() => setEdit(null)} />
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{del?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the room and its event history. Assigned devices will be unassigned, not
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                del &&
                remove.mutate(del.id, {
                  onSuccess: () => toast.success("Room deleted"),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              Delete room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RoomDialog({ room, onClose }: { room: Partial<Room> | null; onClose: () => void }) {
  const { save } = useRoomMutations();
  const [err, setErr] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [widthMm, setWidthMm] = useState(5000);
  const [lengthMm, setLengthMm] = useState(4000);
  const [doors, setDoors] = useState<Door[]>([]);
  const [zones, setZones] = useState<RoomZone[]>([]);
  const [objects, setObjects] = useState<RoomObject[]>([]);
  const [activeTab, setActiveTab] = useState("general");

  // Sync state when dialog opens
  useEffect(() => {
    if (room) {
      setName(room.name ?? "");
      setDesc(room.description ?? "");
      setWidthMm(room.width_mm ?? 5000);
      setLengthMm(room.length_mm ?? 4000);
      setDoors(room.doors ? JSON.parse(JSON.stringify(room.doors)) : []);
      setZones(room.zones ? JSON.parse(JSON.stringify(room.zones)) : []);
      setObjects(room.objects ? JSON.parse(JSON.stringify(room.objects)) : []);
      setErr(null);
      setActiveTab("general");
    }
  }, [room]);

  const addDoor = () => {
    const newDoor: Door = {
      id: `door_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: `Door ${doors.length + 1}`,
      wall: "bottom",
      x_mm: Math.round(widthMm * 0.8),
      y_mm: Math.round(lengthMm * 0.95),
      width_mm: 900,
      type: "both",
    };
    setDoors([...doors, newDoor]);
  };

  const removeDoor = (id: string) => {
    setDoors(doors.filter((d) => d.id !== id));
  };

  const updateDoor = (id: string, updates: Partial<Door>) => {
    setDoors(doors.map((d) => (d.id === id ? { ...d, ...updates } : d)));
  };

  const addZone = (type: RoomZone["type"] = "hazard") => {
    // Generate a default 1000x1000mm box inside room
    const startX = Math.min(widthMm - 1200, Math.max(200, Math.round(widthMm * 0.6)));
    const startY = Math.min(lengthMm - 1200, Math.max(200, Math.round(lengthMm * 0.2)));
    const newZone: RoomZone = {
      id: `zone_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      room_id: room?.id ?? "temp",
      name:
        type === "hazard"
          ? "Hazard Zone"
          : type === "restricted"
            ? "Restricted Area"
            : "Lounge Zone",
      type,
      polygon: [
        { x_mm: startX, y_mm: startY },
        { x_mm: startX + 1000, y_mm: startY },
        { x_mm: startX + 1000, y_mm: startY + 1000 },
        { x_mm: startX, y_mm: startY + 1000 },
      ],
      alert_on_entry: type === "hazard" || type === "restricted",
    };
    setZones([...zones, newZone]);
  };

  const removeZone = (id: string) => {
    setZones(zones.filter((z) => z.id !== id));
  };

  const updateZone = (id: string, updates: Partial<RoomZone>) => {
    setZones(zones.map((z) => (z.id === id ? { ...z, ...updates } : z)));
  };

  const addObject = (type: RoomObject["type"] = "couch") => {
    const newObj: RoomObject = {
      id: `obj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      room_id: room?.id ?? "temp",
      name: type === "couch" ? "Couch" : type === "bed" ? "Bed" : "Table",
      type,
      x_mm: Math.round(widthMm / 2),
      y_mm: Math.round(lengthMm / 2),
      width_mm: type === "couch" ? 1800 : type === "bed" ? 1600 : 1000,
      length_mm: type === "couch" ? 850 : type === "bed" ? 2000 : 800,
      rotation_deg: 0,
    };
    setObjects([...objects, newObj]);
  };

  const removeObject = (id: string) => {
    setObjects(objects.filter((o) => o.id !== id));
  };

  const updateObject = (id: string, updates: Partial<RoomObject>) => {
    setObjects(objects.map((o) => (o.id === id ? { ...o, ...updates } : o)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    if (!(widthMm >= 1000 && widthMm <= 20000 && lengthMm >= 1000 && lengthMm <= 20000)) {
      setErr("Dimensions must be between 1,000 and 20,000 mm");
      return;
    }
    setErr(null);

    save.mutate(
      {
        ...(room?.id ? { id: room.id } : {}),
        name: name.trim(),
        width_mm: Math.round(widthMm),
        length_mm: Math.round(lengthMm),
        description: desc.trim() || null,
        doors,
        zones,
        objects,
      },
      {
        onSuccess: () => {
          toast.success(room?.id ? "Room updated" : "Room created");
          onClose();
        },
        onError: (e) => setErr(e.message),
      },
    );
  };

  return (
    <Dialog open={!!room} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{room?.id ? "Edit room floor plan" : "New room floor plan"}</DialogTitle>
          <DialogDescription>
            Configure room dimensions, door entry/exit points, hazard/restricted zones, and
            furniture objects.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid grid-cols-4 w-full">
              <TabsTrigger value="general">
                <Boxes className="size-3.5 mr-1.5" /> Dimensions
              </TabsTrigger>
              <TabsTrigger value="doors">
                <DoorOpen className="size-3.5 mr-1.5" /> Doors ({doors.length})
              </TabsTrigger>
              <TabsTrigger value="zones">
                <ShieldAlert className="size-3.5 mr-1.5" /> Zones ({zones.length})
              </TabsTrigger>
              <TabsTrigger value="furniture">
                <Armchair className="size-3.5 mr-1.5" /> Furniture ({objects.length})
              </TabsTrigger>
            </TabsList>

            {/* TAB 1: GENERAL DIMENSIONS */}
            <TabsContent value="general" className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="room-name">Room Name</Label>
                <Input
                  id="room-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Master Bedroom, Living Room"
                  maxLength={80}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="room-width">Width (mm) — along sensor wall</Label>
                  <Input
                    id="room-width"
                    type="number"
                    min={1000}
                    max={20000}
                    step={100}
                    value={widthMm}
                    onChange={(e) => setWidthMm(Number(e.target.value))}
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Standard range: 2,000–10,000 mm
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="room-length">Length (mm) — radar depth</Label>
                  <Input
                    id="room-length"
                    type="number"
                    min={1000}
                    max={20000}
                    step={100}
                    value={lengthMm}
                    onChange={(e) => setLengthMm(Number(e.target.value))}
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Standard range: 2,000–10,000 mm
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="room-desc">Description / Location</Label>
                <Textarea
                  id="room-desc"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Optional details or sensor mounting notes..."
                  maxLength={300}
                  rows={2}
                />
              </div>
            </TabsContent>

            {/* TAB 2: DOORS */}
            <TabsContent value="doors" className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Configured entry and exit doorways. Simulated targets enter and leave the room
                  through these points.
                </p>
                <Button type="button" size="sm" variant="outline" onClick={addDoor}>
                  <Plus className="size-3.5 mr-1" /> Add Door
                </Button>
              </div>

              {doors.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  No doors configured. Click “Add Door” to specify entrance and exit points.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {doors.map((door, idx) => (
                    <div
                      key={door.id}
                      className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">Door #{idx + 1}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
                          onClick={() => removeDoor(door.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        <div>
                          <Label className="text-[10px]">Name</Label>
                          <Input
                            className="h-7 text-xs"
                            value={door.name}
                            onChange={(e) => updateDoor(door.id, { name: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Wall</Label>
                          <Select
                            value={door.wall ?? "bottom"}
                            onValueChange={(v: "bottom" | "top" | "left" | "right") =>
                              updateDoor(door.id, { wall: v })
                            }
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="bottom">Bottom (Far)</SelectItem>
                              <SelectItem value="top">Top (Sensor)</SelectItem>
                              <SelectItem value="left">Left Wall</SelectItem>
                              <SelectItem value="right">Right Wall</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-[10px]">X Position (mm)</Label>
                          <Input
                            className="h-7 text-xs"
                            type="number"
                            value={door.x_mm}
                            onChange={(e) => updateDoor(door.id, { x_mm: Number(e.target.value) })}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Y Position (mm)</Label>
                          <Input
                            className="h-7 text-xs"
                            type="number"
                            value={door.y_mm}
                            onChange={(e) => updateDoor(door.id, { y_mm: Number(e.target.value) })}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* TAB 3: ZONES */}
            <TabsContent value="zones" className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Hazard and restricted zones trigger explainable notifications when residents cross
                  boundary lines.
                </p>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => addZone("hazard")}
                  >
                    <AlertTriangle className="size-3.5 mr-1 text-destructive" /> + Hazard Zone
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => addZone("sofa")}>
                    <Plus className="size-3.5 mr-1" /> + Zone
                  </Button>
                </div>
              </div>

              {zones.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  No zones configured. Add hazard zones (e.g. Balcony, Kitchen Stove) or resting
                  zones (e.g. Bed, Sofa).
                </div>
              ) : (
                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {zones.map((zone, idx) => (
                    <div
                      key={zone.id}
                      className={`rounded-lg border p-3 space-y-2 text-xs ${
                        zone.type === "hazard" || zone.type === "restricted"
                          ? "bg-destructive/5 border-destructive/30"
                          : "bg-muted/30"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">Zone #{idx + 1}</span>
                          <span className="capitalize rounded px-1.5 py-0.5 text-[10px] bg-muted font-mono">
                            {zone.type}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
                          onClick={() => removeZone(zone.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <Label className="text-[10px]">Zone Name</Label>
                          <Input
                            className="h-7 text-xs"
                            value={zone.name}
                            onChange={(e) => updateZone(zone.id, { name: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Type</Label>
                          <Select
                            value={zone.type}
                            onValueChange={(v: RoomZone["type"]) =>
                              updateZone(zone.id, {
                                type: v,
                                alert_on_entry: v === "hazard" || v === "restricted",
                              })
                            }
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="hazard">Hazard Zone</SelectItem>
                              <SelectItem value="restricted">Restricted Area</SelectItem>
                              <SelectItem value="bed">Bed</SelectItem>
                              <SelectItem value="sofa">Sofa</SelectItem>
                              <SelectItem value="custom">Custom</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between pt-4">
                          <Label
                            htmlFor={`alert-${zone.id}`}
                            className="text-[11px] cursor-pointer"
                          >
                            Alert on entry
                          </Label>
                          <Switch
                            id={`alert-${zone.id}`}
                            checked={zone.alert_on_entry}
                            onCheckedChange={(checked) =>
                              updateZone(zone.id, { alert_on_entry: checked })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* TAB 4: FURNITURE */}
            <TabsContent value="furniture" className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  User-defined room objects provide physical context for dwell times and stationary
                  micro-motion.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => addObject("couch")}
                >
                  <Plus className="size-3.5 mr-1" /> Add Furniture
                </Button>
              </div>

              {objects.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  No furniture objects configured. Add couches, beds, desks, or tables.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {objects.map((obj, idx) => (
                    <div
                      key={obj.id}
                      className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">Object #{idx + 1}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
                          onClick={() => removeObject(obj.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-4 gap-2">
                        <div>
                          <Label className="text-[10px]">Name</Label>
                          <Input
                            className="h-7 text-xs"
                            value={obj.name}
                            onChange={(e) => updateObject(obj.id, { name: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Type</Label>
                          <Select
                            value={obj.type}
                            onValueChange={(v: RoomObject["type"]) =>
                              updateObject(obj.id, { type: v })
                            }
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="couch">Couch / Sofa</SelectItem>
                              <SelectItem value="bed">Bed</SelectItem>
                              <SelectItem value="table">Table</SelectItem>
                              <SelectItem value="desk">Desk</SelectItem>
                              <SelectItem value="custom">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-[10px]">X Center (mm)</Label>
                          <Input
                            className="h-7 text-xs"
                            type="number"
                            value={obj.x_mm}
                            onChange={(e) => updateObject(obj.id, { x_mm: Number(e.target.value) })}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Y Center (mm)</Label>
                          <Input
                            className="h-7 text-xs"
                            type="number"
                            value={obj.y_mm}
                            onChange={(e) => updateObject(obj.id, { y_mm: Number(e.target.value) })}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>

          {/* LIVE FLOOR PLAN PREVIEW PANE */}
          <div className="rounded-xl border bg-card/60 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Layers className="size-3.5" /> Live Floor Plan Preview
              </span>
              <span>
                {widthMm} × {lengthMm} mm · {doors.length} doors · {zones.length} zones ·{" "}
                {objects.length} objects
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border bg-background/50">
              <LD2450View
                compact
                widthMm={widthMm}
                lengthMm={lengthMm}
                doors={doors}
                zones={zones}
                objects={objects}
                frame={undefined}
                showTrails={false}
              />
            </div>
          </div>

          {err && <p className="text-sm text-destructive">{err}</p>}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving floor plan…" : "Save room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

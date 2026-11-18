import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { localDateString } from "@/lib/notify";
import { createReminder, deleteReminder, remindersQuery, updateReminder } from "@/lib/reminders";

/** Create, switch off and delete reminders. They pop up in the app at their time (see ReminderTicker). */
export function RemindersPanel() {
  const qc = useQueryClient();
  const { data: reminders = [], isError } = useQuery(remindersQuery);
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("09:00");
  const [repeat, setRepeat] = useState<"daily" | "once">("daily");
  const [date, setDate] = useState(() => localDateString(new Date()));
  const [busy, setBusy] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["reminders"] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createReminder({ title, time, repeat, date: repeat === "once" ? date : null });
      setTitle("");
      await refresh();
      toast.success("Reminder added");
    } catch {
      toast.error("Could not save the reminder. Publish the latest firestore.rules first.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="rem-title">Reminder</Label>
          <Input
            id="rem-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Check on the living room"
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rem-time">Time</Label>
          <Input
            id="rem-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rem-repeat">Repeat</Label>
          <select
            id="rem-repeat"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value as "daily" | "once")}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="daily">Every day</option>
            <option value="once">Once</option>
          </select>
        </div>
        {repeat === "once" ? (
          <div className="space-y-1.5">
            <Label htmlFor="rem-date">Date</Label>
            <Input
              id="rem-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
        ) : (
          <Button type="submit" disabled={busy || !title.trim()}>
            Add
          </Button>
        )}
        {repeat === "once" && (
          <Button type="submit" disabled={busy || !title.trim()} className="sm:col-start-4">
            Add
          </Button>
        )}
      </form>

      {isError ? (
        <p className="text-sm text-destructive">
          Could not load reminders. Publish the latest firestore.rules (it now includes reminders).
        </p>
      ) : reminders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No reminders yet. They pop up here in the app while it is open.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {reminders.map((r) => (
            <li key={r.id} className="flex items-center gap-3 p-3 text-sm">
              <Switch
                checked={r.enabled}
                aria-label={`${r.title} on or off`}
                onCheckedChange={(v) =>
                  void updateReminder(r.id, { enabled: v })
                    .then(refresh)
                    .catch(() => undefined)
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.title}</p>
                <p className="text-xs text-muted-foreground">
                  {r.time} · {r.repeat === "daily" ? "every day" : `once on ${r.date}`}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete ${r.title}`}
                onClick={() =>
                  void deleteReminder(r.id)
                    .then(refresh)
                    .catch(() => undefined)
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { useLive } from "@/lib/radar/live";
import { SCENARIOS, type Scenario } from "@/lib/radar/simulation";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function ModeToggle() {
  const { mode, setMode } = useLive();
  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(v) => v && setMode(v as typeof mode)}
      className="rounded-lg border bg-card p-0.5"
      aria-label="Data source"
    >
      <ToggleGroupItem
        value="simulation"
        className="h-8 px-3 font-mono text-[11px] font-semibold tracking-wider data-[state=on]:bg-sim-soft data-[state=on]:text-sim"
      >
        SIMULATION
      </ToggleGroupItem>
      <ToggleGroupItem
        value="hardware"
        className="h-8 px-3 font-mono text-[11px] font-semibold tracking-wider data-[state=on]:bg-success/10 data-[state=on]:text-success"
      >
        HARDWARE
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function SimControls({ roomId }: { roomId: string | null }) {
  const l = useLive();
  if (l.mode !== "simulation") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {roomId && (
        <Select
          value={l.scenarios[roomId] ?? "multiple"}
          onValueChange={(v) => l.setScenario(roomId, v as Scenario)}
        >
          <SelectTrigger className="h-9 w-48 bg-card" aria-label="Scenario">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCENARIOS.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
                <span className="ml-2 text-xs text-muted-foreground">{s.hint}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex items-center rounded-lg border bg-card p-0.5">
        {l.simStatus === "running" ? (
          <Button size="sm" variant="ghost" onClick={l.pause} aria-label="Pause simulation">
            <Pause className="size-4" /> Pause
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={l.start} aria-label="Start simulation">
            <Play className="size-4" /> Start
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={l.stop}
          aria-label="Stop simulation"
          title="Stop"
        >
          <Square className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={l.reset}
          aria-label="Reset simulation"
          title="Reset"
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>
      <Select value={String(l.speed)} onValueChange={(v) => l.setSpeed(Number(v))}>
        <SelectTrigger className="h-9 w-24 bg-card" aria-label="Simulation speed">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[0.5, 1, 2, 4].map((s) => (
            <SelectItem key={s} value={String(s)}>
              {s}× speed
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

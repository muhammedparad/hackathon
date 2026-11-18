import { useRef, useState, type ReactNode } from "react";
import { Box, Flame, Grid2x2, Map as MapIcon, Maximize2, Minimize2 } from "lucide-react";
import { Radar3D, type Radar3DProps } from "@/components/radar/radar-3d";
import { Radar2D } from "@/components/radar/radar-2d";
import type { RadarView } from "@/lib/radar/iso";
import type { LD2450Target } from "@/lib/radar/types";
import { cn } from "@/lib/utils";

export type StageTab = "3d" | "2d" | "heatmap";
export interface StageShow {
  targets: boolean;
  grid: boolean;
  pointCloud: boolean;
  trajectory: boolean;
}

export interface RadarStageProps {
  room: Radar3DProps["room"];
  targets: LD2450Target[];
  trails?: Radar3DProps["trails"];
  points?: Radar3DProps["points"];
  hub: Radar3DProps["hub"];
  stale?: boolean | undefined;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Contents of the Heatmap tab. */
  heatmap: ReactNode;
  /** Drawn over both radar cards (no-data notices, clocks, event banners). Position it with absolute classes. */
  overlay?: ReactNode;
  /** Buttons on the right of the tab row (freeze, counters, ...). */
  headerRight?: ReactNode;
  defaultShow?: Partial<StageShow>;
}

const CARD = "rounded-2xl border border-slate-100 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.06)]";
const TABS: Array<{ id: StageTab; label: string; icon: typeof Box }> = [
  { id: "3d", label: "3D View", icon: Box },
  { id: "2d", label: "2D View", icon: Grid2x2 },
  { id: "heatmap", label: "Heatmap", icon: Flame },
];
const VIEWS: Array<{ id: RadarView; label: string }> = [
  { id: "perspective", label: "Perspective" },
  { id: "top", label: "Top" },
  { id: "front", label: "Front" },
  { id: "right", label: "Right" },
];
const VIEW_NAME: Record<RadarView, string> = {
  perspective: "Perspective",
  top: "Top",
  front: "Front",
  right: "Right",
};

const PANEL_BG =
  "bg-[radial-gradient(ellipse_at_50%_25%,#14307a_0%,#0a1a4f_45%,#050b26_100%)] ring-1 ring-sky-400/20";

/** One dark card with a title and an expand-to-full-screen button. */
function DarkPanel({
  title,
  icon: Icon,
  className,
  children,
}: {
  title: string;
  icon: typeof Box;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const toggle = async () => {
    const el = ref.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFull(false);
      } else if (el.requestFullscreen) {
        await el.requestFullscreen();
        setFull(true);
      }
    } catch {
      /* full screen is not available here */
    }
  };
  return (
    <section
      ref={ref}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-2xl",
        PANEL_BG,
        className,
      )}
      aria-label={title}
    >
      <header className="flex items-center justify-between gap-2 px-4 pb-1 pt-3.5">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-white">
          <Icon className="size-4 shrink-0 text-sky-300" />
          <span className="truncate">{title}</span>
        </h2>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-sky-400/30 text-sky-200 transition hover:bg-white/10"
          aria-label={full ? `Exit full screen: ${title}` : `Full screen: ${title}`}
        >
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-sm font-medium transition",
        active
          ? "border-blue-600 bg-blue-600 text-white shadow-sm"
          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {children}
    </button>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (v: boolean) => void;
  label: string;
  title?: string | undefined;
}) {
  return (
    <label
      title={title}
      className={cn(
        "inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-2 text-sm text-slate-700",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-slate-300 accent-blue-600"
      />
      {label}
    </label>
  );
}

/**
 * The radar screen shared by Live Radar and Playback: tabs (3D / 2D / Heatmap); in 3D, the perspective room and the
 * top-down floor plan side by side; and one control bar for the camera angle and the layers.
 */
export function RadarStage(p: RadarStageProps) {
  const [tab, setTab] = useState<StageTab>("3d");
  const [view, setView] = useState<RadarView>("perspective");
  const [show, setShow] = useState<StageShow>({
    targets: true,
    grid: true,
    pointCloud: false,
    trajectory: false,
    ...p.defaultShow,
  });
  const hasPoints = (p.points?.length ?? 0) > 0;
  const panelH = "h-[360px] sm:h-[440px] lg:h-[500px]";

  return (
    <section className="min-w-0 space-y-3" aria-label="Radar">
      <div className="flex items-center justify-between gap-2">
        <div
          className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Radar view"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full px-5 text-sm font-semibold transition",
                tab === t.id
                  ? "bg-blue-600 text-white shadow"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          ))}
        </div>
        {p.headerRight && <div className="flex shrink-0 items-center gap-1.5">{p.headerRight}</div>}
      </div>

      <div className="relative">
        {tab === "3d" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <DarkPanel title={`3D Radar (${VIEW_NAME[view]})`} icon={Box} className={panelH}>
              <Radar3D
                className="size-full"
                room={p.room}
                targets={p.targets}
                trails={p.trails}
                points={p.points}
                view={view}
                show={show}
                hub={p.hub}
                selectedId={p.selectedId}
                onSelect={p.onSelect}
                stale={p.stale}
              />
            </DarkPanel>
            <DarkPanel title="2D Top View" icon={MapIcon} className={panelH}>
              <Radar2D
                className="size-full"
                room={p.room}
                targets={p.targets}
                trails={p.trails}
                show={show}
                selectedId={p.selectedId}
                onSelect={p.onSelect}
                stale={p.stale}
              />
            </DarkPanel>
          </div>
        )}

        {tab === "2d" && (
          <DarkPanel
            title="2D Top View"
            icon={MapIcon}
            className="h-[440px] sm:h-[540px] lg:h-[600px]"
          >
            <Radar2D
              className="size-full"
              room={p.room}
              targets={p.targets}
              trails={p.trails}
              show={show}
              selectedId={p.selectedId}
              onSelect={p.onSelect}
              stale={p.stale}
            />
          </DarkPanel>
        )}

        {tab === "heatmap" && (
          <div className={cn(CARD, "min-h-[360px] overflow-auto p-2")}>{p.heatmap}</div>
        )}

        {tab !== "heatmap" && p.overlay}
      </div>

      {tab !== "heatmap" && (
        <div
          className={cn(
            CARD,
            "flex min-w-0 flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6",
          )}
        >
          {tab === "3d" ? (
            <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {VIEWS.map((v) => (
                <Chip key={v.id} active={view === v.id} onClick={() => setView(v.id)}>
                  {v.id === "perspective" && <Box className="size-3.5" />}
                  {v.label}
                </Chip>
              ))}
            </div>
          ) : (
            <span className="text-sm text-slate-500">Top-down floor plan</span>
          )}
          <div className="flex flex-wrap gap-x-5">
            <Toggle
              label="Targets"
              checked={show.targets}
              onChange={(v) => setShow((s) => ({ ...s, targets: v }))}
            />
            <Toggle
              label="Range Grid"
              checked={show.grid}
              onChange={(v) => setShow((s) => ({ ...s, grid: v }))}
            />
            <Toggle
              label="Point Cloud"
              checked={show.pointCloud && hasPoints}
              disabled={!hasPoints}
              title={hasPoints ? undefined : "No RD-61 point cloud is being received"}
              onChange={(v) => setShow((s) => ({ ...s, pointCloud: v }))}
            />
            <Toggle
              label="Trajectory"
              checked={show.trajectory}
              onChange={(v) => setShow((s) => ({ ...s, trajectory: v }))}
            />
          </div>
        </div>
      )}
    </section>
  );
}

import { cn } from "@/lib/utils";
import type { ConnectionState, RoomState } from "@/lib/radar/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FlaskConical, Info } from "lucide-react";
import type { ReactNode } from "react";

const tone = {
  success: "bg-success/10 text-success ring-success/20",
  warning: "bg-warning/15 text-warning-foreground ring-warning/30",
  error: "bg-destructive/10 text-destructive ring-destructive/20",
  neutral: "bg-muted text-muted-foreground ring-border",
  primary: "bg-primary/10 text-primary ring-primary/20",
} as const;
const dot = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/50",
  primary: "bg-primary",
} as const;

export function Pill({
  t,
  children,
  pulse,
  className,
}: {
  t: keyof typeof tone;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tone[t],
        className,
      )}
    >
      <span className="relative flex size-1.5">
        {pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              dot[t],
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", dot[t])} />
      </span>
      {children}
    </span>
  );
}

export function ConnBadge({ s }: { s: ConnectionState }) {
  const map = {
    connected: ["success", "Connected"],
    disconnected: ["error", "Disconnected"],
    connecting: ["warning", "Connecting"],
    unknown: ["neutral", "Unknown"],
  } as const;
  const [t, l] = map[s];
  return (
    <Pill t={t} pulse={s === "connected"}>
      {l}
    </Pill>
  );
}

export function RoomBadge({ s }: { s: RoomState }) {
  const map = {
    occupied: ["primary", "Occupied"],
    vacant: ["success", "Vacant"],
    unknown: ["neutral", "Unknown"],
    sensor_offline: ["error", "Sensor offline"],
  } as const;
  const [t, l] = map[s];
  return (
    <Pill t={t} pulse={s === "occupied"}>
      {l}
    </Pill>
  );
}

export function SimTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-sim-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-sim",
        className,
      )}
    >
      <FlaskConical className="size-3" aria-hidden /> SIMULATED
    </span>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex text-muted-foreground hover:text-foreground"
          aria-label="More info"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClass,
  hint,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  hint?: ReactNode;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              {title}
              {hint && <Hint>{hint}</Hint>}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn("p-5", bodyClass)}>{children}</div>
    </section>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        {icon}
      </div>
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function timeAgo(ts: number | string | null | undefined, now = Date.now()) {
  if (ts == null) return "Never";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

/** Tiny trend line for metric cards. */
export function Sparkline({
  data,
  className,
  color = "var(--chart-1)",
  height = 34,
}: {
  data: number[];
  className?: string;
  color?: string;
  height?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map(
    (v, i) => `${(i / (data.length - 1)) * 100},${32 - ((v - min) / span) * 28}`,
  );
  return (
    <svg
      viewBox="0 0 100 34"
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
      aria-hidden
    >
      <polygon points={`0,34 ${pts.join(" ")} 100,34`} fill={color} opacity={0.1} />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const KPI_TONE = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-warning-foreground",
  error: "bg-destructive/10 text-destructive",
  neutral: "bg-accent text-primary",
} as const;

const KPI_STRIP = {
  primary: "bg-primary/45",
  success: "bg-success/45",
  warning: "bg-warning/55",
  error: "bg-destructive/45",
  neutral: "bg-border",
} as const;

/** Metric card: icon, headline number, context line, optional trend. */
export function Kpi({
  icon,
  label,
  value,
  sub,
  sim,
  tone = "neutral",
  status,
  hint,
  spark,
  className,
}: {
  icon?: ReactNode | undefined;
  label: string;
  value: string | number;
  sub?: string | undefined;
  sim?: boolean | undefined;
  tone?: keyof typeof KPI_TONE | undefined;
  status?: string | undefined;
  hint?: string | undefined;
  spark?: number[] | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card p-5 shadow-card transition-shadow hover:shadow-raised",
        className,
      )}
      title={hint}
    >
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-0.5", KPI_STRIP[tone])} />
      <div className="flex items-center justify-between gap-2">
        {icon ? (
          <div
            className={cn(
              "flex size-9 items-center justify-center rounded-lg [&_svg]:size-4",
              KPI_TONE[tone],
            )}
          >
            {icon}
          </div>
        ) : (
          <span />
        )}
        {sim ? (
          <SimTag />
        ) : status ? (
          <Pill t={tone === "neutral" ? "neutral" : tone}>{status}</Pill>
        ) : null}
      </div>
      <div className="mt-4 font-mono text-3xl font-semibold tracking-tight tabular">{value}</div>
      <div className="mt-0.5 text-sm font-medium">{label}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      {spark && spark.length > 1 && (
        <Sparkline
          data={spark}
          className="mt-3"
          height={30}
          color={tone === "success" ? "var(--success)" : "var(--chart-1)"}
        />
      )}
    </div>
  );
}

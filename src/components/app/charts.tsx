import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const axis = {
  stroke: "var(--muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;
const tip = {
  contentStyle: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 12,
  },
};

export function AreaSeries({
  data,
  x,
  y,
  unit,
  height = 220,
}: {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  unit?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: -16, right: 8, top: 8 }}>
        <defs>
          <linearGradient id={`g-${y}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey={x} {...axis} minTickGap={20} />
        <YAxis {...axis} {...(unit ? { unit } : {})} />
        <Tooltip {...tip} />
        <Area
          type="monotone"
          dataKey={y}
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill={`url(#g-${y})`}
          {...(unit ? { unit } : {})}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Bars({
  data,
  x,
  bars,
  unit,
  height = 220,
  layout = "horizontal",
}: {
  data: Record<string, unknown>[];
  x: string;
  bars: { key: string; label: string; color: string }[];
  unit?: string;
  height?: number;
  layout?: "horizontal" | "vertical";
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout={layout}
        margin={{ left: layout === "vertical" ? 8 : -16, right: 8, top: 8 }}
      >
        <CartesianGrid
          stroke="var(--grid)"
          vertical={layout === "vertical"}
          horizontal={layout === "horizontal"}
        />
        {layout === "horizontal" ? (
          <>
            <XAxis dataKey={x} {...axis} />
            <YAxis {...axis} {...(unit ? { unit } : {})} />
          </>
        ) : (
          <>
            <XAxis type="number" {...axis} {...(unit ? { unit } : {})} />
            <YAxis type="category" dataKey={x} {...axis} width={100} />
          </>
        )}
        <Tooltip {...tip} cursor={{ fill: "var(--muted)" }} />
        {bars.map((b) => (
          <Bar
            key={b.key}
            dataKey={b.key}
            name={b.label}
            fill={b.color}
            radius={4}
            {...(unit ? { unit } : {})}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

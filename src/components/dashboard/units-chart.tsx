"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";

export type UnitsChartPoint = {
  date: string;
  cumulativeUnits: number;
};

// A y axis on round values: the smallest 1 / 2 / 2.5 / 5 x 10^n step that covers the series (0 always
// included) in at most four bands, with the axis ending on gridlines.
function roundAxis(values: number[]): { domain: [number, number]; ticks: number[] } {
  const finite = values.filter(Number.isFinite);
  const min = Math.min(0, ...finite);
  const max = Math.max(0, ...finite);
  const raw = (max - min || 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step);
  const hi = Math.ceil(max / step);
  const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => Math.round((lo + i) * step * 1e6) / 1e6);
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

// `compact` shrinks the chart for secondary placements (e.g. a per-sport
// chart sitting alongside a primary all-picks one) without changing any of
// the underlying data/series logic - purely a sizing variant.
// `themed` is the chart as it sits in a /dashboard panel (panel-shell.tsx): that
// theme's grid / axis / line colors, the page's own typeface, and a y axis on
// round values with the break-even line marked.
// (The capper page's per-pick chart is its own component: capper-units-chart.tsx.)
export function UnitsChart({
  data,
  compact = false,
  themed = false,
}: {
  data: UnitsChartPoint[];
  compact?: boolean;
  themed?: boolean;
}) {
  // Recharts renders raw SVG with colors set via inline props, not Tailwind
  // classes - a `dark:` variant can't reach them, so this needs to know the
  // live theme and pick hex values itself (kept close to the border-subtle/
  // muted-foreground/card tokens' actual light/dark values).
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const heightClass = compact ? "h-40" : "h-64";

  if (data.length === 0) {
    return (
      <div className={"flex items-center justify-center text-sm text-muted-foreground " + heightClass}>
        No settled picks yet to chart.
      </div>
    );
  }

  const gridColor = themed ? (isDark ? "rgba(255,255,255,0.1)" : "rgba(15,20,32,0.08)") : isDark ? "#1f2937" : "#f3f4f6";
  const tickColor = themed ? (isDark ? "#9ca3af" : "#5B6275") : isDark ? "#9ca3af" : "#6b7280";
  const lineColor = themed && isDark ? "#60a5fa" : "#2563eb";
  const tick = { fontSize: 11, fill: tickColor, ...(themed ? { fontFamily: "inherit", fontWeight: 500 } : {}) };
  const axis = themed ? roundAxis(data.map((d) => d.cumulativeUnits)) : null;

  return (
    <div className={heightClass}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray={themed ? undefined : "3 3"} vertical={!themed} stroke={gridColor} />
          <XAxis
            dataKey="date"
            tick={tick}
            axisLine={false}
            tickLine={false}
            minTickGap={themed ? 28 : undefined}
          />
          <YAxis
            tick={tick}
            axisLine={false}
            tickLine={false}
            {...(axis ? { domain: axis.domain, ticks: axis.ticks, interval: 0, tickFormatter: (v: number) => v + "u" } : {})}
          />
          {themed && <ReferenceLine y={0} stroke={isDark ? "rgba(255,255,255,0.5)" : "rgba(15,20,32,0.45)"} strokeWidth={1.5} />}
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid " + gridColor,
              fontSize: 12,
              backgroundColor: isDark ? "#111827" : "#ffffff",
              color: isDark ? "#f9fafb" : "#111827",
            }}
            formatter={(value: number) => [value.toFixed(2) + "u", "Cumulative units"]}
          />
          <Line
            type="monotone"
            dataKey="cumulativeUnits"
            stroke={lineColor}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

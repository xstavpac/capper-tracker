"use client";

import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import { formatSignedUnits, unitsExtremes } from "@/lib/units-extremes";
import type { UnitsChartPoint } from "@/components/dashboard/units-chart";

const LINE = "#2563EB";
const PEAK = "#10B981";
const LOW = "#EF4444";

// The capper page's units chart: one point per pick with straight segments between them, an x axis
// that labels each date once (several points share a date), a soft fill under the line, the
// break-even line dashed, and markers on the peak, the low and the latest pick.
// Recharts draws raw SVG, so the theme's colors are picked here (see units-chart.tsx).
export function CapperUnitsChart({ data }: { data: UnitsChartPoint[] }) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;

  if (data.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">No settled picks yet to chart.</div>;
  }

  const gridColor = isDark ? "rgba(255,255,255,0.1)" : "#EEF1F6";
  const surface = isDark ? "#111827" : "#ffffff";
  const tick = { fontSize: 11, fill: isDark ? "#9ca3af" : "#64748B" };
  const rows = data.map((d, i) => ({ ...d, i }));
  const dateStarts = rows.flatMap((d, i) => (i === 0 || d.date !== data[i - 1].date ? [i] : []));
  const extremes = unitsExtremes(data.map((d) => d.cumulativeUnits));
  const last = data.length - 1;
  // A flat series (or a single pick) has no peak or low to call out: only the latest point.
  const marked = extremes && extremes.peak !== extremes.low ? extremes : null;
  const dot = { r: 6, stroke: surface, strokeWidth: 3 };
  const tag = (i: number, fill: string, position: "top" | "bottom") => ({
    value: formatSignedUnits(data[i].cumulativeUnits, 1),
    position,
    offset: 10,
    fill,
    fontSize: 11,
    fontWeight: 800,
  });

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 26, right: 22, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="capper-units-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={LINE} stopOpacity={0.22} />
              <stop offset="100%" stopColor={LINE} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={gridColor} />
          <XAxis
            dataKey="i"
            tick={tick}
            axisLine={false}
            tickLine={false}
            minTickGap={16}
            ticks={dateStarts}
            tickFormatter={(i: number) => data[i]?.date ?? ""}
          />
          <YAxis tick={tick} axisLine={false} tickLine={false} padding={{ bottom: 22 }} />
          <ReferenceLine y={0} stroke="#94A3B8" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid " + gridColor,
              fontSize: 12,
              backgroundColor: surface,
              color: isDark ? "#f9fafb" : "#111827",
            }}
            formatter={(value: number) => [value.toFixed(2) + "u", "Cumulative units"]}
            labelFormatter={(i: number) => data[i]?.date ?? ""}
          />
          <Area
            type="linear"
            dataKey="cumulativeUnits"
            stroke={isDark ? "#60a5fa" : LINE}
            strokeWidth={2.25}
            fill="url(#capper-units-fill)"
            dot={false}
            activeDot={{ r: 4 }}
            // The markers are drawn at once; an animated line would leave them floating until it arrives.
            isAnimationActive={false}
          />
          {marked && <ReferenceDot x={marked.peak} y={data[marked.peak].cumulativeUnits} {...dot} fill={PEAK} label={tag(marked.peak, isDark ? "#6EE7B7" : "#047857", "top")} />}
          {marked && <ReferenceDot x={marked.low} y={data[marked.low].cumulativeUnits} {...dot} fill={LOW} label={tag(marked.low, isDark ? "#FCA5A5" : "#B91C1C", "bottom")} />}
          {(!marked || (last !== marked.peak && last !== marked.low)) && <ReferenceDot x={last} y={data[last].cumulativeUnits} {...dot} fill={LINE} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import type { PickNumberChartPoint } from "@/server/data/stats";

export type ComparisonSeries = {
  id: string;
  label: string;
  color: string;
  points: PickNumberChartPoint[];
};

// Merges 1-2 series onto a shared pickNumber axis - unlike
// historical-variable-chart.tsx's mergeSeriesForChart (which unions every
// DATE any series has a point on), this just needs every integer from 1
// through the longest series' length, since pick numbers are already dense
// and contiguous within each series (no gaps to union). A capper with fewer
// picks than the other naturally has null for every pickNumber past their
// own last pick - Recharts stops that line there rather than drawing a
// misleading connection to nothing, which is exactly the right behavior for
// "these two trajectories are different lengths," not a bug to work around.
function mergeByPickNumber(series: ComparisonSeries[]): Record<string, number | null>[] {
  const maxLength = Math.max(0, ...series.map((s) => s.points.length));
  const rows: Record<string, number | null>[] = [];
  for (let n = 1; n <= maxLength; n++) {
    const row: Record<string, number | null> = { pickNumber: n };
    for (const s of series) {
      row[s.id] = s.points.find((p) => p.pickNumber === n)?.cumulativeUnits ?? null;
    }
    rows.push(row);
  }
  return rows;
}

// The /charts line chart: one line per capper on a "pick 1, 2, 3..." axis, drawn like the capper
// page's units chart (capper-units-chart.tsx): horizontal gridlines only, the break-even line
// dashed. The series' names and end values are in the card's header, not in a legend here.
// Recharts draws raw SVG, so the theme's colors are picked here.
export function CapperComparisonChart({
  series,
  height = 320,
}: {
  series: ComparisonSeries[];
  // See HistoricalVariableChart's height prop - same vh-string-or-pixel-number
  // contract, for the same fullscreen reason.
  height?: number | string;
}) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const gridColor = isDark ? "rgba(255,255,255,0.1)" : "#EEF1F6";
  const surface = isDark ? "#111827" : "#ffffff";
  const tick = { fontSize: 11, fill: isDark ? "#9ca3af" : "#94A3B8" };

  const data = useMemo(() => mergeByPickNumber(series), [series]);
  const hasAnyPoints = series.some((s) => s.points.length > 0);

  if (!hasAnyPoints) {
    return (
      <div className="flex items-center justify-center text-center text-[13px] font-medium text-muted-foreground" style={{ height }}>
        No settled picks match these filters yet.
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 12, left: -10, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke={gridColor} />
          {/* minTickGap thins the pick numbers out on a narrow card instead of crowding them. */}
          <XAxis
            dataKey="pickNumber"
            tick={tick}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
            interval="preserveStartEnd"
            label={{ value: "Pick #", position: "insideBottom", offset: -5, fontSize: 11, fill: tick.fill }}
          />
          <YAxis tick={tick} axisLine={false} tickLine={false} tickCount={5} />
          <ReferenceLine y={0} stroke="#94A3B8" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{
              borderRadius: 10,
              border: "1px solid " + (isDark ? "rgba(255,255,255,0.14)" : "#E2E8F0"),
              boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
              fontSize: 12,
              backgroundColor: surface,
              color: isDark ? "#f9fafb" : "#0F172A",
            }}
            labelFormatter={(n) => "Pick #" + n}
            formatter={(value: unknown, name: unknown) => [
              typeof value === "number" ? value.toFixed(2) + "u" : "-",
              String(name),
            ]}
          />
          {series.map((s) => (
            <Line key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2.25} dot={false} activeDot={{ r: 4 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

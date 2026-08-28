"use client";

import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
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

// Same lightweight Recharts wrapper pattern as UnitsChart/
// HistoricalVariableChart (same theme-aware grid/tick colors, same tooltip
// styling) - genuinely new, not reused, since neither of those fits: UnitsChart
// hardcodes a single series on a `date` x-axis, and HistoricalVariableChart's
// date-union merge/tick-formatting is built specifically for calendar dates,
// not the "pick 1, 2, 3..." ordinal axis this needs.
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
  const gridColor = isDark ? "#1f2937" : "#f3f4f6";
  const tickColor = isDark ? "#9ca3af" : "#6b7280";

  const data = useMemo(() => mergeByPickNumber(series), [series]);
  const hasAnyPoints = series.some((s) => s.points.length > 0);

  if (!hasAnyPoints) {
    return (
      <div
        className="flex items-center justify-center rounded-card border border-dashed border-border text-sm text-muted-foreground"
        style={{ height }}
      >
        No settled picks match these filters yet.
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
          <XAxis
            dataKey="pickNumber"
            tick={{ fontSize: 11, fill: tickColor }}
            axisLine={false}
            tickLine={false}
            label={{ value: "Pick #", position: "insideBottom", offset: -5, fontSize: 11, fill: tickColor }}
          />
          <YAxis tick={{ fontSize: 11, fill: tickColor }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid " + gridColor,
              fontSize: 12,
              backgroundColor: isDark ? "#111827" : "#ffffff",
              color: isDark ? "#f9fafb" : "#111827",
            }}
            labelFormatter={(n) => "Pick #" + n}
            formatter={(value: unknown, name: unknown) => [
              typeof value === "number" ? value.toFixed(2) + "u" : "-",
              String(name),
            ]}
          />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s) => (
            <Line key={s.id} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

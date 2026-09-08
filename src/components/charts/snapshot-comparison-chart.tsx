"use client";

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import type { VariableUnit } from "@/lib/model-builder";
import { formatValueForUnit } from "@/components/charts/historical-variable-chart";

// The renderer for a season-snapshot custom metric: one bar per team, value
// on the Y axis. Deliberately a separate, minimal component rather than a
// mode of HistoricalVariableChart - that one is built entirely around a
// date-union X axis and multi-Y-axis line series, none of which a
// "one undated value per team" comparison needs. Same lightweight
// theme-aware Recharts wrapper pattern as HistoricalVariableChart /
// CapperComparisonChart (same grid/tick colors, same tooltip styling).
//
// Snapshot metrics never carry the time-series messaging (no "Building
// historical depth"), never take a date range, and are only reachable from
// Team Comparison mode - see custom-metric-picker.ts for how the variable
// picker enforces that.

export type SnapshotBar = { team: string; value: number | null; color: string };

export function SnapshotComparisonChart({
  bars,
  unit,
  label,
  periodLabel,
  height = 320,
  emptyMessage = "No value for these teams in this snapshot.",
}: {
  bars: SnapshotBar[];
  unit: VariableUnit;
  // Metric name, shown above the chart alongside the period.
  label: string;
  periodLabel?: string;
  // See HistoricalVariableChart's height prop - same vh-string-or-pixel-number
  // contract, for the same fullscreen reason.
  height?: number | string;
  emptyMessage?: string;
}) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const gridColor = isDark ? "#1f2937" : "#f3f4f6";
  const tickColor = isDark ? "#9ca3af" : "#6b7280";

  const withValue = bars.filter((b) => b.value !== null);

  if (withValue.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-card border border-dashed border-border px-4 text-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  const data = bars.map((b) => ({ team: b.team, value: b.value, color: b.color }));

  return (
    <div>
      <div className="mb-2 text-xs font-medium text-foreground">
        {label}
        {periodLabel ? <span className="text-muted-foreground"> · {periodLabel}</span> : null}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis dataKey="team" tick={{ fontSize: 11, fill: tickColor }} tickMargin={8} />
          <YAxis
            tick={{ fontSize: 11, fill: tickColor }}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => formatValueForUnit(v, unit)}
          />
          <Tooltip
            cursor={{ fill: isDark ? "#ffffff10" : "#00000008" }}
            contentStyle={{
              borderRadius: 12,
              border: "1px solid " + gridColor,
              fontSize: 12,
              backgroundColor: isDark ? "#111827" : "#ffffff",
              color: isDark ? "#f9fafb" : "#111827",
            }}
            formatter={(value: unknown) => [
              typeof value === "number" ? formatValueForUnit(value, unit) : "-",
              label,
            ]}
          />
          <Bar dataKey="value" isAnimationActive={false} radius={[4, 4, 0, 0]} maxBarSize={96}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

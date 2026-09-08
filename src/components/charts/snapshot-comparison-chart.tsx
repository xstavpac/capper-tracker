"use client";

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, LabelList } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import { formatValueForUnit } from "@/components/charts/historical-variable-chart";
import type { SnapshotBar, SnapshotMetricSeries } from "@/lib/snapshot-chart";

export type { SnapshotBar, SnapshotMetricSeries };

// The renderer for season-snapshot custom metrics in Team Comparison: a
// two-team bar comparison per selected metric. Deliberately a separate,
// minimal component rather than a mode of HistoricalVariableChart - that one
// is built entirely around a date-union X axis and multi-Y-axis line series,
// none of which an "undated value per team" comparison needs. Same
// lightweight theme-aware Recharts wrapper pattern as the other Charts
// components (same grid/tick colors, same tooltip styling).
//
// MULTIPLE METRICS -> SMALL MULTIPLES, not grouped bars on one axis. Snapshot
// metrics routinely have wildly different scales (avg_exit_velocity ~89,
// xwoba ~0.32, batted_balls ~1400); a shared Y axis flattens the small ones
// to nothing, and grouped bars on separate hidden axes make the bar heights
// non-comparable - misleading, since height is a bar's whole encoding. So
// each metric gets its own small chart with its own zero-based, auto-scaled
// axis. This is the same answer the daily line chart reaches for scale
// mismatch, and matches its split-view layout.
//
// Snapshot metrics never carry the time-series messaging (no "Building
// historical depth"), never take a date range, and are only reachable from
// Team Comparison mode - see custom-metric-picker.ts for how the variable
// picker enforces that.

const MINI_HEIGHT = 240;

function MiniChart({
  metric,
  height,
  isDark,
}: {
  metric: SnapshotMetricSeries;
  height: number | string;
  isDark: boolean;
}) {
  const gridColor = isDark ? "#1f2937" : "#f3f4f6";
  const tickColor = isDark ? "#9ca3af" : "#6b7280";

  const withValue = metric.bars.filter((b) => b.value !== null);
  const data = metric.bars.map((b) => ({ team: b.team, value: b.value, color: b.color }));

  return (
    <div>
      <div className="mb-2 truncate text-xs font-medium text-foreground" title={metric.label}>
        {metric.label}
        {metric.periodLabel ? <span className="text-muted-foreground"> · {metric.periodLabel}</span> : null}
      </div>
      {withValue.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-card border border-dashed border-border px-4 text-center text-xs text-muted-foreground"
          style={{ height }}
        >
          No value for these teams.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} margin={{ top: 18, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
            <XAxis dataKey="team" tick={{ fontSize: 11, fill: tickColor }} tickMargin={8} />
            <YAxis
              tick={{ fontSize: 11, fill: tickColor }}
              width={52}
              // Bars must grow from a zero baseline, or a 89.1-vs-87.4
              // comparison reads as a landslide. Always include 0; extend the
              // other way only if a value is negative (a signed "count"
              // metric).
              domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
              tickFormatter={(v: number) => formatValueForUnit(v, metric.unit)}
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
                typeof value === "number" ? formatValueForUnit(value, metric.unit) : "-",
                metric.label,
              ]}
            />
            <Bar dataKey="value" isAnimationActive={false} radius={[4, 4, 0, 0]} maxBarSize={24}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
              <LabelList
                dataKey="value"
                position="top"
                offset={6}
                style={{ fontSize: 11, fill: tickColor }}
                formatter={(v: unknown) => (typeof v === "number" ? formatValueForUnit(v, metric.unit) : "")}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function SnapshotComparisonChart({
  metrics,
  teams,
  height = 320,
  emptyMessage = "No value for these teams in this snapshot.",
}: {
  metrics: SnapshotMetricSeries[];
  // The two teams being compared, slot order (A, B) - drives the shared
  // legend so identity isn't carried by color alone.
  teams: { team: string; color: string }[];
  // Per-chart height. A single metric uses it directly (unchanged from the
  // original single-metric behavior); with several, each small multiple is
  // capped so a tall fullscreen value doesn't make one chart per screen.
  height?: number | string;
  emptyMessage?: string;
}) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;

  const anyValue = metrics.some((m) => m.bars.some((b) => b.value !== null));
  if (metrics.length === 0 || !anyValue) {
    return (
      <div
        className="flex items-center justify-center rounded-card border border-dashed border-border px-4 text-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  const single = metrics.length === 1;
  const miniHeight = single
    ? height
    : Math.min(typeof height === "number" ? height : MINI_HEIGHT, 300) || MINI_HEIGHT;

  return (
    <div>
      <div className={single ? "" : "grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3"}>
        {metrics.map((m) => (
          <MiniChart key={m.variableId} metric={m} height={miniHeight} isDark={isDark} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {teams.map((t) => (
          <span key={t.team} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: t.color }} />
            <span className="font-medium text-foreground">{t.team}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type { VariableUnit } from "@/lib/model-builder";

export type ChartSeriesPoint = { date: string; value: number | null };

export type ChartSeries = {
  id: string; // unique across the series array - used as both the merged-row key and the Y-axis id
  label: string; // legend/tooltip display name, e.g. "Yankees ERA"
  unit: VariableUnit;
  color: string;
  points: ChartSeriesPoint[]; // dates need not line up across series - see mergeSeriesForChart
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Dates are already plain Eastern calendar-day strings ("YYYY-MM-DD") from
// the data adapter, not real timestamps - formatted here with simple string
// splitting rather than the app's Date/timezone-aware formatEastern, since
// there's no timezone conversion to do on a value that's already a day, not
// an instant.
function formatDateTick(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return (MONTH_ABBR[month - 1] ?? parts[1]) + " " + day;
}

function formatValueForUnit(value: number, unit: VariableUnit): string {
  switch (unit) {
    case "percent":
      return (value * 100).toFixed(1) + "%";
    case "decimal":
      return value.toFixed(3);
    case "odds":
      return value > 0 ? "+" + value : String(value);
    case "runs":
    case "innings":
    case "games":
      return value.toFixed(1);
    default:
      return String(value);
  }
}

// One row per distinct date across ALL series, each series contributing its
// own column keyed by series.id - the shape recharts' LineChart needs to
// draw multiple lines against one shared X axis. A date a given series has
// no point for just leaves that column undefined for that row, which
// combined with connectNulls={false} on <Line> shows a gap in only that
// line rather than interpolating a fake value.
function mergeSeriesForChart(series: ChartSeries[]): Record<string, number | string | null>[] {
  const dateSet = new Set<string>();
  for (const s of series) for (const p of s.points) dateSet.add(p.date);
  const dates = Array.from(dateSet).sort();

  return dates.map((date) => {
    const row: Record<string, number | string | null> = { date };
    for (const s of series) {
      row[s.id] = s.points.find((p) => p.date === date)?.value ?? null;
    }
    return row;
  });
}

function CustomTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number | null }[];
  label?: string;
  series: ChartSeries[];
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-soft">
      <div className="mb-1 font-medium text-gray-900">{label ? formatDateTick(label) : ""}</div>
      <div className="space-y-0.5">
        {series.map((s) => {
          const entry = payload.find((p) => p.dataKey === s.id);
          if (!entry || entry.value === null || entry.value === undefined) return null;
          return (
            <div key={s.id} className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="text-gray-500">{s.label}:</span>
              <span className="font-medium text-gray-900">{formatValueForUnit(entry.value, s.unit)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Mismatched units (ERA ~2-6, batting average ~.200-.350, win% 0-100%) must
// never share one Y-axis scale, or a large swing in one series reads as a
// flat line next to another - and this can't be solved by grouping on the
// catalog's abstract `unit` field alone, since e.g. ERA and batting average
// are both typed "decimal" despite wildly different ranges. Instead, every
// series here gets its OWN Y-axis (`yAxisId={series.id}`, independently
// auto-scaled to that series' own domain) - visually, only the first two are
// rendered with a visible axis (left/right, the readable limit before a
// chart gets cluttered with axis rulers), the rest render with `hide` so
// they don't draw a ruler but still correctly scale their own line. The
// hover tooltip always shows every series' exact value regardless of how
// many axes are visible, so nothing is ever only-approximately readable.
export function HistoricalVariableChart({ series, height = 320 }: { series: ChartSeries[]; height?: number }) {
  const visibleSeries = useMemo(() => series.filter((s) => s.points.some((p) => p.value !== null)), [series]);
  const data = useMemo(() => mergeSeriesForChart(visibleSeries), [visibleSeries]);

  if (visibleSeries.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-card border border-dashed border-gray-200 text-sm text-gray-400"
        style={{ height }}
      >
        No historical data available for the selected range yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickMargin={8} tickFormatter={formatDateTick} />
        {visibleSeries.map((s, i) => (
          <YAxis
            key={s.id}
            yAxisId={s.id}
            orientation={i % 2 === 0 ? "left" : "right"}
            hide={i >= 2}
            width={i < 2 ? 48 : 0}
            tick={{ fontSize: 11 }}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => formatValueForUnit(v, s.unit)}
          />
        ))}
        <Tooltip content={<CustomTooltip series={visibleSeries} />} />
        {visibleSeries.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {visibleSeries.map((s) => (
          <Line
            key={s.id}
            yAxisId={s.id}
            dataKey={s.id}
            name={s.label}
            stroke={s.color}
            dot={data.length <= 30}
            connectNulls={false}
            strokeWidth={2}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

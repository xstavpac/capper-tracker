"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";

export type UnitsChartPoint = {
  date: string;
  cumulativeUnits: number;
};

// `compact` shrinks the chart for secondary placements (e.g. a per-sport
// chart sitting alongside a primary all-picks one) without changing any of
// the underlying data/series logic - purely a sizing variant.
export function UnitsChart({ data, compact = false }: { data: UnitsChartPoint[]; compact?: boolean }) {
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

  const gridColor = isDark ? "#1f2937" : "#f3f4f6";
  const tickColor = isDark ? "#9ca3af" : "#6b7280";

  return (
    <div className={heightClass}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: tickColor }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: tickColor }} axisLine={false} tickLine={false} />
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
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

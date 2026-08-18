"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";

export type UnitsChartPoint = {
  date: string;
  cumulativeUnits: number;
};

export function UnitsChart({ data }: { data: UnitsChartPoint[] }) {
  // Recharts renders raw SVG with colors set via inline props, not Tailwind
  // classes - a `dark:` variant can't reach them, so this needs to know the
  // live theme and pick hex values itself (kept close to the border-subtle/
  // muted-foreground/card tokens' actual light/dark values).
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No settled picks yet to chart.
      </div>
    );
  }

  const gridColor = isDark ? "#1f2937" : "#f3f4f6";
  const tickColor = isDark ? "#9ca3af" : "#6b7280";

  return (
    <div className="h-64">
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

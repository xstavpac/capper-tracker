"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";

export function WinLossPieChart({
  wins,
  losses,
  pushes,
}: {
  wins: number;
  losses: number;
  pushes: number;
}) {
  // Same reasoning as UnitsChart: Recharts sets colors via inline SVG props,
  // not Tailwind classes, so a `dark:` variant can't reach the tooltip/legend
  // chrome - only the slice fills, which are saturated enough to stay
  // readable unmodified.
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;

  const data = [
    { name: "Wins", value: wins, color: "#10B981" },
    { name: "Losses", value: losses, color: "#EF4444" },
    { name: "Pushes", value: pushes, color: "#9CA3AF" },
  ].filter((d) => d.value > 0);

  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        No settled picks yet.
      </div>
    );
  }

  const gridColor = isDark ? "#1f2937" : "#f3f4f6";
  const textColor = isDark ? "#f9fafb" : "#111827";

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid " + gridColor,
              fontSize: 12,
              backgroundColor: isDark ? "#111827" : "#ffffff",
              color: textColor,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: textColor }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

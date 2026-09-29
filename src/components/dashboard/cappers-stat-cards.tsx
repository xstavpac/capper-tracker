import { HOT_STREAK_MIN, type OverviewStats } from "@/server/data/cappers-page-aggregates";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";

function signed(n: number, suffix = "") {
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n) + suffix;
}

function StatCard({ label, value, valueClass, sub, subClass }: { label: string; value: string; valueClass?: string; sub?: string; subClass?: string }) {
  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={"mt-1 text-3xl font-semibold tabular-nums " + (valueClass ?? "text-foreground")}>{value}</p>
      <p className={"mt-1 h-4 text-xs " + (subClass ?? "text-muted-foreground")}>{sub}</p>
    </div>
  );
}

export function CappersStatCards({ stats, range }: { stats: OverviewStats; range: string }) {
  const d = stats.activeCappersDelta;
  const pct = stats.picksThisWeekPct;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        label="Active cappers"
        value={String(stats.activeCappers)}
        sub={d === null ? undefined : signed(d) + (range === "7d" ? " vs last week" : " vs prior period")}
        subClass={d === null ? undefined : d < 0 ? RED : GREEN}
      />
      <StatCard
        label="Picks this week"
        value={String(stats.picksThisWeek)}
        sub={pct === null ? undefined : signed(pct, "%") + " vs last week"}
        subClass={pct === null ? undefined : pct < 0 ? RED : GREEN}
      />
      <StatCard
        label="Avg ROI"
        value={signed(stats.avgRoi, "%")}
        valueClass={stats.avgRoi < 0 ? RED : GREEN}
        sub={stats.gradedPicks + " graded pick" + (stats.gradedPicks === 1 ? "" : "s")}
      />
      <StatCard label="Hot streaks" value={String(stats.hotStreaks)} sub={"on " + HOT_STREAK_MIN + "+ win streaks"} />
    </div>
  );
}

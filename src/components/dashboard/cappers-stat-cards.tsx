import type { ReactNode } from "react";
import { HOT_STREAK_MIN, type OverviewStats } from "@/server/data/cappers-page-aggregates";
import { ActivityIcon, FlameIcon, ListChecksIcon, PercentIcon, UsersIcon } from "@/components/dashboard/cappers-icons";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";

function signed(n: number, suffix = "") {
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n) + suffix;
}

function StatCard({
  label,
  icon,
  iconClass,
  value,
  valueClass,
  sub,
  subClass,
  className,
}: {
  label: string;
  icon: ReactNode;
  iconClass: string;
  value: string;
  valueClass?: string;
  sub?: string;
  subClass?: string;
  className?: string;
}) {
  return (
    <div className={"rounded-card border border-border bg-card p-4 sm:p-5 " + (className ?? "")}>
      <div className="flex items-center gap-2">
        <span className={"flex h-7 w-7 shrink-0 items-center justify-center rounded-lg " + iconClass}>{icon}</span>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      </div>
      <p className={"mt-2 text-3xl font-semibold tabular-nums " + (valueClass ?? "text-foreground")}>{value}</p>
      <p className={"mt-1 h-4 text-xs " + (subClass ?? "text-muted-foreground")}>{sub}</p>
    </div>
  );
}

export function CappersStatCards({ stats, capperCount, range }: { stats: OverviewStats; capperCount: number; range: string }) {
  const d = stats.activeCappersDelta;
  const pct = stats.picksThisWeekPct;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 min-[769px]:grid-cols-5">
      <StatCard label="Tracked cappers" icon={<UsersIcon />} iconClass="bg-brand-600/10 text-brand-600" value={String(capperCount)} />
      <StatCard
        // The number follows the time tabs, so the label only says "this week" on the 7-day tab.
        label={range === "7d" ? "Active this week" : "Active cappers"}
        icon={<ActivityIcon />}
        iconClass="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        value={String(stats.activeCappers)}
        sub={d === null ? undefined : signed(d) + (range === "7d" ? " vs last week" : " vs prior period")}
        subClass={d === null ? undefined : d < 0 ? RED : GREEN}
      />
      <StatCard
        label="Picks this week"
        icon={<ListChecksIcon />}
        iconClass="bg-sky-500/10 text-sky-600 dark:text-sky-400"
        value={String(stats.picksThisWeek)}
        sub={pct === null ? undefined : signed(pct, "%") + " vs last week"}
        subClass={pct === null ? undefined : pct < 0 ? RED : GREEN}
      />
      <StatCard
        label="Avg ROI"
        icon={<PercentIcon />}
        iconClass="bg-violet-500/10 text-violet-600 dark:text-violet-400"
        value={signed(stats.avgRoi, "%")}
        valueClass={stats.avgRoi < 0 ? RED : GREEN}
        sub={stats.gradedPicks + " graded pick" + (stats.gradedPicks === 1 ? "" : "s")}
      />
      <StatCard
        label="Hot streaks"
        icon={<FlameIcon />}
        iconClass="bg-orange-500/10 text-orange-500"
        value={String(stats.hotStreaks)}
        sub={"on " + HOT_STREAK_MIN + "+ win streaks"}
        className="col-span-2 min-[769px]:col-span-1"
      />
    </div>
  );
}

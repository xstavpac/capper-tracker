import type { OverviewStats } from "@/server/data/cappers-page-aggregates";
import { ActivityIcon, CalendarIcon, PercentIcon, TrendingUpIcon, UsersIcon } from "@/components/dashboard/cappers-icons";
import { GREEN, RED, StatCard, delta, signed } from "@/components/dashboard/stat-card";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
// Six tracks between the two- and five-across layouts, so the row reads 3 + 2 with no gap.
const TOP = "min-[1100px]:max-[1499px]:col-span-2";
const BOTTOM = "min-[1100px]:max-[1499px]:col-span-3";

export function CappersStatCards({ stats, capperCount }: { stats: OverviewStats; capperCount: number }) {
  const pct = stats.picksThisWeekPct;
  const w = stats.weekly;
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-1 min-[900px]:grid-cols-2 min-[1100px]:grid-cols-6 min-[1500px]:grid-cols-5">
      <StatCard
        label="Tracked cappers"
        icon={<UsersIcon className={ICON} />}
        iconClass="bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
        color="#2563EB"
        value={capperCount.toLocaleString("en-US")}
        {...delta(stats.newCappersThisMonth, stats.newCappersThisMonth + " this month")}
        series={w.tracked}
        className={TOP}
      />
      <StatCard
        // The value follows the time tabs; the delta is always this week against last week.
        label="Active cappers"
        icon={<ActivityIcon className={ICON} />}
        iconClass="bg-[#DCF7E6] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
        color="#16A34A"
        value={stats.activeCappers.toLocaleString("en-US")}
        {...delta(stats.activeCappersDelta, Math.abs(stats.activeCappersDelta) + " this week")}
        series={w.active}
        className={TOP}
      />
      <StatCard
        label="Picks this week"
        icon={<CalendarIcon className={ICON} />}
        iconClass="bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
        color="#2563EB"
        value={stats.picksThisWeek.toLocaleString("en-US")}
        {...(pct === null ? { sub: "no picks last week" } : delta(pct, Math.abs(pct) + "% vs last week"))}
        series={w.picks}
        className={TOP}
      />
      <StatCard
        label="Avg ROI"
        icon={<PercentIcon className={ICON} />}
        iconClass="bg-[#EDE2FF] text-violet-600 dark:bg-violet-500/15 dark:text-violet-400"
        color="#7C3AED"
        value={signed(stats.avgRoi, "%")}
        valueClass={stats.avgRoi < 0 ? RED : stats.avgRoi > 0 ? GREEN : undefined}
        sub={stats.gradedPicks.toLocaleString("en-US") + " graded pick" + (stats.gradedPicks === 1 ? "" : "s")}
        series={w.roi}
        className={BOTTOM}
      />
      <StatCard
        // The time tabs' pooled net units, next to the ROI it goes with; the sparkline is each week's own net.
        label="Net units"
        icon={<TrendingUpIcon className={ICON} />}
        iconClass="bg-[#DCF7E6] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
        color="#16A34A"
        value={Number.isFinite(stats.netUnits) ? (stats.netUnits > 0 ? "+" : stats.netUnits < 0 ? "−" : "") + Math.abs(stats.netUnits).toFixed(2) + "u" : String(stats.netUnits)}
        valueClass={stats.netUnits < 0 ? RED : stats.netUnits > 0 ? GREEN : undefined}
        sub={stats.record.wins + "–" + stats.record.losses + (stats.record.pushes > 0 ? "–" + stats.record.pushes : "") + " record"}
        series={w.net}
        className={BOTTOM}
      />
    </div>
  );
}

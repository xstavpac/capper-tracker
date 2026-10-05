import type { ReactNode } from "react";
import { HOT_STREAK_MIN, type OverviewStats } from "@/server/data/cappers-page-aggregates";
import { ActivityIcon, CalendarIcon, FlameIcon, PercentIcon, UsersIcon } from "@/components/dashboard/cappers-icons";

const GREEN = "text-[#15803D] dark:text-emerald-400";
const RED = "text-[#B91C1C] dark:text-red-400";
const MUTED = "text-[#5B6275] dark:text-muted-foreground";

const signed = (n: number, suffix = "") => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toLocaleString("en-US") + suffix;
// "↑ +12 this month" / "↓ −3 this week": arrow and color follow the sign; 0 is neutral.
const delta = (n: number, text: string) => ({ sub: (n > 0 ? "↑ +" : n < 0 ? "↓ −" : "") + text, subClass: n > 0 ? GREEN : n < 0 ? RED : MUTED });

// The card's trend: one point per week, oldest first, scaled to its own range, with a soft fill.
function Spark({ values, color }: { values: number[]; color: string }) {
  const W = 64;
  const H = 34;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => (i * step).toFixed(1) + "," + (max === min ? H / 2 : pad + (H - pad * 2) * (1 - (v - min) / span)).toFixed(1)).join(" ");
  return (
    <svg viewBox={"0 0 " + W + " " + H} preserveAspectRatio="none" className="h-[34px] w-16 min-w-0 shrink" aria-hidden>
      <polygon points={pts + " " + W + "," + H + " 0," + H} fill={color} fillOpacity={0.07} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function StatCard({
  label,
  icon,
  iconClass,
  color,
  value,
  valueClass,
  sub,
  subClass,
  series,
  className,
}: {
  label: string;
  icon: ReactNode;
  iconClass: string;
  // The sparkline's color.
  color: string;
  value: string;
  valueClass?: string;
  sub: string;
  subClass?: string;
  series: number[];
  className?: string;
}) {
  return (
    <div className={"flex items-center gap-3 rounded-2xl bg-white px-4 py-[13px] shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border dark:border-border dark:bg-card dark:shadow-none min-[1700px]:gap-3.5 " + (className ?? "")}>
      <span className={"flex h-10 w-10 shrink-0 items-center justify-center rounded-full " + iconClass}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={"truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] " + MUTED}>{label}</p>
        {/* The sparkline shares the value's row, so it gives way before the number does in a narrow card. */}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className={"whitespace-nowrap text-[22px] font-semibold leading-[1.15] tracking-[-0.02em] tabular-nums " + (valueClass ?? "text-foreground")}>{value}</p>
          <Spark values={series} color={color} />
        </div>
        <p className={"mt-0.5 text-[11.5px] font-medium leading-tight tabular-nums " + (subClass ?? MUTED)}>{sub}</p>
      </div>
    </div>
  );
}

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
        label="Hot streaks"
        icon={<FlameIcon className={ICON} />}
        iconClass="bg-[#FFE3CC] text-orange-500 dark:bg-orange-500/15"
        color="#F97316"
        value={String(stats.hotStreaks)}
        sub={"on " + HOT_STREAK_MIN + "+ win streaks"}
        series={w.hot}
        className={BOTTOM}
      />
    </div>
  );
}

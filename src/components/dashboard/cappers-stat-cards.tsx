import type { ReactNode } from "react";
import { HOT_STREAK_MIN, type OverviewStats } from "@/server/data/cappers-page-aggregates";
import { ActivityIcon, CalendarIcon, FlameIcon, PercentIcon, UsersIcon } from "@/components/dashboard/cappers-icons";

const GREEN = "text-emerald-700 dark:text-emerald-400";
const RED = "text-red-700 dark:text-red-400";
const MUTED = "text-muted-foreground";

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
      <polygon points={pts + " " + W + "," + H + " 0," + H} fill={color} fillOpacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
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
}) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-card p-3.5 shadow-soft min-[1700px]:gap-3.5 min-[1700px]:p-4">
      <span className={"flex h-11 w-11 shrink-0 items-center justify-center rounded-full min-[1700px]:h-[52px] min-[1700px]:w-[52px] " + iconClass}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-muted-foreground">{label}</p>
        {/* The sparkline shares the value's row, so it gives way before the number does in a narrow card. */}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className={"whitespace-nowrap text-2xl font-extrabold leading-[1.15] tracking-tight tabular-nums min-[1700px]:text-[26px] " + (valueClass ?? "text-foreground")}>{value}</p>
          <Spark values={series} color={color} />
        </div>
        <p className={"mt-0.5 text-[11.5px] font-bold leading-tight " + (subClass ?? MUTED)}>{sub}</p>
      </div>
    </div>
  );
}

const ICON = "h-6 w-6";

export function CappersStatCards({ stats, capperCount }: { stats: OverviewStats; capperCount: number }) {
  const pct = stats.picksThisWeekPct;
  const w = stats.weekly;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(210px,100%),1fr))] gap-3.5">
      <StatCard
        label="Tracked cappers"
        icon={<UsersIcon className={ICON} />}
        iconClass="bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
        color="#2F54EB"
        value={capperCount.toLocaleString("en-US")}
        {...delta(stats.newCappersThisMonth, stats.newCappersThisMonth + " this month")}
        series={w.tracked}
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
      />
      <StatCard
        label="Picks this week"
        icon={<CalendarIcon className={ICON} />}
        iconClass="bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
        color="#2F54EB"
        value={stats.picksThisWeek.toLocaleString("en-US")}
        {...(pct === null ? { sub: "no picks last week" } : delta(pct, Math.abs(pct) + "% vs last week"))}
        series={w.picks}
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
      />
      <StatCard
        label="Hot streaks"
        icon={<FlameIcon className={ICON} />}
        iconClass="bg-[#FFE3CC] text-orange-500 dark:bg-orange-500/15"
        color="#F97316"
        value={String(stats.hotStreaks)}
        sub={"on " + HOT_STREAK_MIN + "+ win streaks"}
        series={w.hot}
      />
    </div>
  );
}

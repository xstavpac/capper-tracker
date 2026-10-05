import type { getDashboardSummary } from "@/server/data/dashboard-summary";
import { STALE_PENDING_HOURS } from "@/server/data/dashboard-summary";
import { round2 } from "@/server/data/stats";
import { ClockIcon, ListChecksIcon, PercentIcon, TrendingUpIcon, TrophyIcon, UsersIcon } from "@/components/dashboard/cappers-icons";
import { GREEN, MUTED, RED, StatCard, delta } from "@/components/dashboard/stat-card";

type Summary = Awaited<ReturnType<typeof getDashboardSummary>>;

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
const BLUE = "bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400";
const GREEN_TILE = "bg-[#DCF7E6] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400";
const VIOLET_TILE = "bg-[#EDE2FF] text-violet-600 dark:bg-violet-500/15 dark:text-violet-400";
const AMBER_TILE = "bg-[#FFE9C7] text-amber-600 dark:bg-amber-500/15 dark:text-amber-400";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
// An all-time total as it stood at each week's end: today's total less what the later weeks added.
const walkBack = (total: number, perWeek: number[]) => perWeek.map((_, i) => total - sum(perWeek.slice(i + 1)));
const signed2 = (n: number, suffix: string) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2) + suffix;
const record = (w: number, l: number, p: number) => w + "–" + l + (p > 0 ? "–" + p : "");
const tone = (n: number) => (n > 0 ? GREEN : n < 0 ? RED : undefined);

// The dashboard's six numbers. Each sub line is this week (the rolling 7 days ending now) and each
// sparkline is the number itself at the end of each of the last 8 weeks. Pending has no history - a
// pick's earlier status is not kept - so it has no sparkline.
export function DashboardStatCards({ summary }: { summary: Summary }) {
  const { overall, trends } = summary;
  const w = trends.weekly;
  const last = w.posted.length - 1;
  const graded = overall.wins + overall.losses + overall.pushes;
  const gradedThisWeek = w.wins[last] + w.losses[last] + w.pushes[last];
  const NO_GRADED = "no graded picks this week";

  // Money: a WIN at odds 0 makes the all-time net units / ROI non-finite, and they then have no trend to draw.
  const finite = Number.isFinite(overall.netUnits) && Number.isFinite(overall.roi);
  const weekNet = w.unitsWon.map((won, i) => won - w.unitsLost[i]);
  const netAt = walkBack(overall.netUnits, weekNet);
  const riskedAt = walkBack(trends.unitsRisked, w.unitsRisked);
  const roiAt = netAt.map((net, i) => (riskedAt[i] > 0 ? round2((net / riskedAt[i]) * 100) : 0));
  // ROI's move over the week, in points; only when there was an ROI a week ago to move from.
  const roiMove = finite && gradedThisWeek > 0 && riskedAt[last - 1] > 0 ? round2(overall.roi - roiAt[last - 1]) : null;
  const netMove = round2(weekNet[last]);
  const weekDiff = w.wins[last] - w.losses[last];

  return (
    // auto-rows-fr: the Record card's second sub line makes it a line taller, and every row matches it.
    // Six across only from 2070px, where the cards reach their widest (the page stops growing at 1680px):
    // any narrower and a sub line ends in an ellipsis or a sparkline is squeezed out. Three across below.
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-1 min-[900px]:grid-cols-2 min-[1100px]:grid-cols-3 min-[2070px]:grid-cols-6">
      <StatCard
        label="Total picks"
        icon={<ListChecksIcon className={ICON} />}
        iconClass={BLUE}
        color="#2563EB"
        value={summary.totalPicks.toLocaleString("en-US")}
        {...delta(w.posted[last], w.posted[last].toLocaleString("en-US") + " this week")}
        series={walkBack(summary.totalPicks, w.posted)}
      />
      <StatCard
        label="Cappers tracked"
        icon={<UsersIcon className={ICON} />}
        iconClass={BLUE}
        color="#2563EB"
        value={trends.capperCount.toLocaleString("en-US")}
        {...delta(trends.newCappersThisMonth, trends.newCappersThisMonth + " this month")}
        series={w.tracked}
      />
      <StatCard
        label="Record"
        icon={<TrophyIcon className={ICON} />}
        iconClass={GREEN_TILE}
        color="#16A34A"
        // Wins and losses only, so the value stays short at any total. The pushes get a sub line of
        // their own above the week's record; each is one line and ends in an ellipsis rather than wrap.
        value={overall.wins + "–" + overall.losses}
        sub={
          <>
            {overall.pushes > 0 && <span className={"block truncate " + MUTED}>{overall.pushes.toLocaleString("en-US") + (overall.pushes === 1 ? " push" : " pushes")}</span>}
            <span className="block truncate">{gradedThisWeek > 0 ? record(w.wins[last], w.losses[last], w.pushes[last]) + " this week" : NO_GRADED}</span>
          </>
        }
        subClass={gradedThisWeek > 0 ? tone(weekDiff) : undefined}
        // Wins less losses: up when the week won more than it lost.
        series={walkBack(overall.wins - overall.losses, w.wins.map((wins, i) => wins - w.losses[i]))}
      />
      <StatCard
        label="ROI"
        icon={<PercentIcon className={ICON} />}
        iconClass={VIOLET_TILE}
        color="#7C3AED"
        value={signed2(overall.roi, "%")}
        valueClass={tone(overall.roi)}
        {...(roiMove === null ? { sub: graded.toLocaleString("en-US") + " graded pick" + (graded === 1 ? "" : "s") } : delta(roiMove, Math.abs(roiMove).toFixed(2) + " pts this week"))}
        series={finite ? roiAt : undefined}
      />
      <StatCard
        label="Net units"
        icon={<TrendingUpIcon className={ICON} />}
        iconClass={GREEN_TILE}
        color="#16A34A"
        value={signed2(overall.netUnits, "u")}
        valueClass={tone(overall.netUnits)}
        {...(gradedThisWeek > 0 ? delta(netMove, Math.abs(netMove).toFixed(2) + "u this week") : { sub: NO_GRADED })}
        series={finite ? netAt.map(round2) : undefined}
      />
      <StatCard
        label="Pending"
        icon={<ClockIcon className={ICON} />}
        iconClass={AMBER_TILE}
        color="#D97706"
        value={summary.pendingCount.toLocaleString("en-US")}
        sub={summary.stalePendingCount > 0 ? summary.stalePendingCount.toLocaleString("en-US") + " over " + STALE_PENDING_HOURS + " hours" : summary.pendingCount > 0 ? "none overdue" : "nothing to grade"}
        subClass={summary.stalePendingCount > 0 ? "text-amber-700 dark:text-amber-400" : MUTED}
        href="/picks/pending"
      />
    </div>
  );
}

import type { PicksSummary } from "@/server/data/picks-summary";
import { winRatePct } from "@/lib/picks-header";
import { ClockIcon, PercentIcon, TrendingDownIcon, TrendingUpIcon, TrophyIcon } from "@/components/dashboard/cappers-icons";
import { GREEN, RED, StatCard } from "@/components/dashboard/stat-card";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
const GREEN_TILE = "bg-[#DCF7E6] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400";
const RED_TILE = "bg-[#FFE0E0] text-[#DC2626] dark:bg-red-500/15 dark:text-red-400";
const VIOLET_TILE = "bg-[#EDE2FF] text-violet-600 dark:bg-violet-500/15 dark:text-violet-400";
const AMBER_TILE = "bg-[#FFE9C7] text-amber-600 dark:bg-amber-500/15 dark:text-amber-400";

const signed = (n: number, digits: number, suffix: string) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(digits) + suffix;
const tone = (n: number) => (n > 0 ? GREEN : n < 0 ? RED : undefined);

// The dashboard's stat cards (stat-card.tsx) for the current filter set: four across, 2x2 on a
// phone. `live` + `later` are the still-to-play picks (Live and not-started only - Grading and
// Awaiting-result picks are excluded). `series` is the cumulative units across the settled picks.
export function PicksSummaryStrip({
  summary,
  series,
  live,
  later,
}: {
  summary: PicksSummary;
  series: number[] | null;
  live: number;
  later: number;
}) {
  const settled = summary.wins + summary.losses + summary.pushes;
  const rate = winRatePct(summary.wins, summary.losses);
  const decided = settled > 0;
  const avgStake = decided ? summary.unitsRisked / settled : 0;
  const down = summary.netUnits < 0;
  return (
    <div className="grid auto-rows-fr grid-cols-2 gap-3.5 min-[1100px]:grid-cols-4">
      <StatCard
        compactMobile
        label="Record"
        icon={<TrophyIcon className={ICON} />}
        iconClass={GREEN_TILE}
        color="#16A34A"
        value={summary.wins + "–" + summary.losses + "–" + summary.pushes}
        sub={rate === null ? "No settled picks" : rate + "% win rate"}
      />
      <StatCard
        compactMobile
        label="Net units"
        icon={down ? <TrendingDownIcon className={ICON} /> : <TrendingUpIcon className={ICON} />}
        iconClass={down ? RED_TILE : GREEN_TILE}
        color={down ? "#DC2626" : "#16A34A"}
        value={signed(summary.netUnits, 2, "u")}
        valueClass={tone(summary.netUnits)}
        sub={decided ? avgStake.toFixed(2) + "u avg stake · " + settled + " settled" : "No settled picks"}
        series={series ?? undefined}
      />
      <StatCard
        compactMobile
        label="ROI"
        icon={<PercentIcon className={ICON} />}
        iconClass={VIOLET_TILE}
        color="#7C3AED"
        value={decided ? signed(summary.roi, 1, "%") : "–"}
        valueClass={decided ? tone(summary.roi) : undefined}
        sub={"on " + summary.unitsRisked.toFixed(2) + " units risked"}
      />
      <StatCard
        compactMobile
        label="Still to play"
        icon={<ClockIcon className={ICON} />}
        iconClass={AMBER_TILE}
        color="#D97706"
        value={String(live + later)}
        sub={
          <>
            <span className="text-red-500" aria-hidden="true">
              ●
            </span>{" "}
            {live + " live · " + later + " later"}
          </>
        }
      />
    </div>
  );
}

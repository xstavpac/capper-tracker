import type { PicksSummary } from "@/server/data/picks-summary";
import { winRatePct } from "@/lib/picks-header";
import { ClockIcon, CopyIcon, PercentIcon, TrendingDownIcon, TrendingUpIcon, TrophyIcon } from "@/components/dashboard/cappers-icons";
import type { UniquePicksResult } from "@/lib/unique-picks";
import { GREEN, RED, StatCard } from "@/components/dashboard/stat-card";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
const GREEN_TILE = "bg-[#DCF7E6] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400";
const RED_TILE = "bg-[#FFE0E0] text-[#DC2626] dark:bg-red-500/15 dark:text-red-400";
const VIOLET_TILE = "bg-[#EDE2FF] text-violet-600 dark:bg-violet-500/15 dark:text-violet-400";
const BLUE_TILE = "bg-[#E1ECFF] text-blue-600 dark:bg-blue-500/15 dark:text-blue-400";
const AMBER_TILE = "bg-[#FFE9C7] text-amber-600 dark:bg-amber-500/15 dark:text-amber-400";

const signed = (n: number, digits: number, suffix: string) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(digits) + suffix;
const tone = (n: number) => (n > 0 ? GREEN : n < 0 ? RED : undefined);

// The dashboard's stat cards (stat-card.tsx) for the current filter set: five across from 1100px,
// three from md, two on a phone (Still to play spans both there). `unique` counts each distinct bet
// once (lib/unique-picks.ts). `live` + `later` are the still-to-play picks (Live and not-started only - Grading and
// Awaiting-result picks are excluded). `series` is the cumulative units across the settled picks.
export function PicksSummaryStrip({
  summary,
  unique,
  series,
  live,
  later,
}: {
  summary: PicksSummary;
  unique: UniquePicksResult;
  series: number[] | null;
  live: number;
  later: number;
}) {
  const settled = summary.wins + summary.losses + summary.pushes;
  const rate = winRatePct(summary.wins, summary.losses);
  const uniqueRate = winRatePct(unique.wins, unique.losses);
  const decided = settled > 0;
  const avgStake = decided ? summary.unitsRisked / settled : 0;
  const down = summary.netUnits < 0;
  return (
    <div className="grid auto-rows-fr grid-cols-2 gap-3.5 md:grid-cols-3 min-[1100px]:grid-cols-5">
      <StatCard
        compactMobile
        label="Record"
        icon={<TrophyIcon className={ICON} />}
        iconClass={GREEN_TILE}
        color="#16A34A"
        value={summary.wins + "–" + summary.losses + "–" + summary.pushes}
        sub={rate === null ? "No settled picks" : rate + "% win rate · all picks"}
      />
      <StatCard
        compactMobile
        label="Unique picks"
        icon={<CopyIcon className={ICON} />}
        iconClass={BLUE_TILE}
        color="#2563EB"
        value={unique.wins + "–" + unique.losses + "–" + unique.pushes}
        sub={(uniqueRate === null ? "No settled picks" : uniqueRate + "% win rate") + " · " + unique.unique + " unique of " + unique.total}
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
        className="max-sm:col-span-2"
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

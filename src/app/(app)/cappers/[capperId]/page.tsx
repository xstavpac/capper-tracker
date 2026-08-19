import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getCapperById, getCappersWithPickCounts } from "@/server/data/cappers";
import { CapperEditPanel } from "@/components/dashboard/capper-edit-panel";
import { getPicksForCapper } from "@/server/data/picks";
import {
  computeStats,
  computeScorecard,
  computeCategoryBreakdown,
  computeBestOddsRange,
  computeConsistency,
  unitsWonOnBet,
  filterPicksByGradedWindow,
  chipSetForLeague,
  SCORECARD_WINDOWS,
  SCORECARD_WINDOW_LABELS,
  type ScorecardWindow,
} from "@/server/data/stats";
import { UnitsChart, type UnitsChartPoint } from "@/components/dashboard/units-chart";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { CapperScorecard } from "@/components/dashboard/capper-scorecard";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { StreakBadge } from "@/components/dashboard/capper-panels";
import { formatEastern, formatRelativeTime } from "@/lib/dates";

const SOURCE_LABELS: Record<string, string> = {
  TWITTER: "Twitter / X",
  DISCORD: "Discord",
  TELEGRAM: "Telegram",
  DUBCLUB: "DubClub",
  INSTAGRAM: "Instagram",
  FRIEND: "Friend",
  OTHER: "Other",
};

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const toneClass =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";
  return (
    <div className="rounded-card bg-card p-4 shadow-soft">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={"mt-1 whitespace-nowrap text-2xl font-semibold " + toneClass}>{value}</div>
    </div>
  );
}

// Same pill styling as the Cappers-page bet-type chips, for a consistent look
// across the app's secondary filter rows.
function chipClass(isActive: boolean) {
  return (
    "rounded-full px-3 py-1 text-xs font-medium " +
    (isActive
      ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
      : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

export default async function CapperDetailPage({
  params,
  searchParams,
}: {
  params: { capperId: string };
  searchParams: { window?: string };
}) {
  const user = await requireUser();
  const capper = await getCapperById(user.id, params.capperId);

  if (!capper) {
    notFound();
  }

  const window = SCORECARD_WINDOWS.includes(searchParams.window as ScorecardWindow)
    ? (searchParams.window as ScorecardWindow)
    : "ALL";

  const [picks, allCappers] = await Promise.all([
    getPicksForCapper(user.id, params.capperId),
    getCappersWithPickCounts(user.id),
  ]);
  const otherCappers = allCappers.filter((c) => c.id !== capper.id);
  // Record/ROI/Net units should reflect whichever window is selected, same as
  // the scorecard below - but currentStreak deliberately always comes from
  // the unfiltered, all-time computeStats call instead: a streak is a count
  // of consecutive results in true chronological order, and filtering the
  // input to a window would truncate a real ongoing streak into a smaller,
  // misleading number rather than produce a meaningful "windowed" streak.
  const stats = computeStats(filterPicksByGradedWindow(picks, window));
  const allTimeStats = computeStats(picks);
  const allTimeScorecard = computeScorecard(picks);
  const scorecard = computeScorecard(filterPicksByGradedWindow(picks, window));

  // F5 ML/NRFI only mean anything within MLB (see stats.ts's
  // getCategoryBreakdownForSport) - scope this capper's category breakdown
  // to their MLB picks specifically, alongside the bet-type scorecard above,
  // rather than mixing it into an all-sports view that has no home for them.
  const mlbPicks = picks.filter((p) => p.sport.name === "MLB");
  const mlbCategoryBreakdown = computeCategoryBreakdown(mlbPicks, chipSetForLeague("MLB"));

  const settled = picks.filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH");
  let running = 0;
  const chartData: UnitsChartPoint[] = settled.map((pick) => {
    if (pick.status === "WIN") {
      running += unitsWonOnBet(pick.units, pick.odds);
    } else if (pick.status === "LOSS") {
      running -= pick.units;
    }
    return {
      date: formatEastern(pick.gameTime, { month: "short", day: "numeric" }),
      cumulativeUnits: Math.round(running * 100) / 100,
    };
  });

  const recentPicks = [...picks].reverse().slice(0, 10);

  const trackedSinceMs = picks.length > 0 ? Math.min(...picks.map((p) => p.datePosted.getTime())) : null;
  const lastPickMs = picks.length > 0 ? Math.max(...picks.map((p) => p.datePosted.getTime())) : null;
  const bestOddsRange = computeBestOddsRange(picks);
  const consistency = computeConsistency(picks);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full text-base font-medium text-white"
            style={{ backgroundColor: capper.colorTag ?? "#3B82F6" }}
          >
            {capper.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold">{capper.name}</h1>
            <p className="text-sm text-muted-foreground">
              {capper.source === "OTHER" && capper.customSource
                ? capper.customSource
                : SOURCE_LABELS[capper.source]}
              {capper.sportSpecialization ? " - " + capper.sportSpecialization : ""}
            </p>
          </div>
        </div>
        <CapperEditPanel
          capperId={capper.id}
          currentName={capper.name}
          otherCappers={otherCappers}
          associatedPickCount={picks.length}
        />
      </div>

      {trackedSinceMs !== null && lastPickMs !== null && (
        <div className="mb-4 rounded-card bg-card p-5 shadow-soft">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Tracked since {formatEastern(new Date(trackedSinceMs), { month: "short", day: "numeric" })}
              {" · "}
              Last pick {formatRelativeTime(new Date(lastPickMs), Date.now())}
            </p>
            <StreakBadge streak={allTimeStats.currentStreak} />
          </div>
          <div className="mt-3 flex flex-wrap gap-8">
            <div>
              <div className="text-xs text-muted-foreground">Best odds range</div>
              <div className="mt-0.5 text-sm font-medium text-foreground">
                {bestOddsRange ? bestOddsRange.label : "Not enough data"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Consistency</div>
              <div
                className={
                  "mt-0.5 text-sm font-medium " +
                  (consistency?.label === "Steady"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : consistency?.label === "Volatile"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground")
                }
              >
                {consistency ? consistency.label : "Not enough data"}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Record" value={stats.wins + "-" + stats.losses + "-" + stats.pushes} />
        <StatCard
          label="ROI"
          value={(stats.roi >= 0 ? "+" : "") + stats.roi + "%"}
          tone={stats.roi >= 0 ? "up" : "down"}
        />
        <StatCard
          label="Net units"
          value={(stats.netUnits >= 0 ? "+" : "") + stats.netUnits + "u"}
          tone={stats.netUnits >= 0 ? "up" : "down"}
        />
        <StatCard
          label="Current streak"
          value={
            allTimeStats.currentStreak.type === "NONE"
              ? "-"
              : allTimeStats.currentStreak.count + " " + allTimeStats.currentStreak.type
          }
          tone={
            allTimeStats.currentStreak.type === "WIN"
              ? "up"
              : allTimeStats.currentStreak.type === "LOSS"
                ? "down"
                : undefined
          }
        />
      </div>

      {allTimeScorecard.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-muted-foreground">Record by bet type</div>
            <div className="flex flex-wrap gap-2">
              {SCORECARD_WINDOWS.map((w) => (
                <a key={w} href={"?window=" + w} className={chipClass(window === w)}>
                  {SCORECARD_WINDOW_LABELS[w]}
                </a>
              ))}
            </div>
          </div>
          {scorecard.length > 0 ? (
            <CapperScorecard buckets={scorecard} variant="grid" />
          ) : (
            <p className="rounded-card bg-card p-6 text-center text-sm text-muted-foreground shadow-soft">
              No graded picks in this window.
            </p>
          )}
        </div>
      )}

      {mlbCategoryBreakdown.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-muted-foreground">MLB record by category</div>
          <CategoryBreakdown items={mlbCategoryBreakdown} />
        </div>
      )}

      <div className="mt-4 rounded-card bg-card p-5 shadow-soft">
        <div className="mb-2 text-sm font-medium text-muted-foreground">Units over time</div>
        <UnitsChart data={chartData} />
      </div>

      <div className="mt-4 rounded-card bg-card shadow-soft">
        <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
          Recent picks
        </div>
        {recentPicks.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No picks logged for this capper yet.
          </p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {recentPicks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">
                    {pick.awayTeam} @ {pick.homeTeam}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {pick.betDetail || pick.betType} - {pick.odds > 0 ? "+" : ""}
                    {pick.odds} - {pick.units}u
                  </div>
                </div>
                <PickStatusButtons pickId={pick.id} status={pick.status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

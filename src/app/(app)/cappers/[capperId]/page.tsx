import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getCapperById } from "@/server/data/cappers";
import { getPicksForCapper } from "@/server/data/picks";
import {
  computeStats,
  computeScorecard,
  unitsWonOnBet,
  filterPicksByGradedWindow,
  SCORECARD_WINDOWS,
  SCORECARD_WINDOW_LABELS,
  type ScorecardWindow,
} from "@/server/data/stats";
import { UnitsChart, type UnitsChartPoint } from "@/components/dashboard/units-chart";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { CapperScorecard } from "@/components/dashboard/capper-scorecard";
import { formatEastern } from "@/lib/dates";

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
    tone === "up" ? "text-emerald-600" : tone === "down" ? "text-red-600" : "text-gray-900";
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={"mt-1 text-2xl font-semibold " + toneClass}>{value}</div>
    </div>
  );
}

// Same pill styling as the Cappers-page bet-type chips, for a consistent look
// across the app's secondary filter rows.
function chipClass(isActive: boolean) {
  return (
    "rounded-full px-3 py-1 text-xs font-medium " +
    (isActive ? "bg-gray-900 text-white" : "bg-white text-gray-500 shadow-soft hover:bg-gray-50")
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

  const picks = await getPicksForCapper(user.id, params.capperId);
  const stats = computeStats(picks);
  const allTimeScorecard = computeScorecard(picks);
  const scorecard = computeScorecard(filterPicksByGradedWindow(picks, window));

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

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full text-base font-medium text-white"
          style={{ backgroundColor: capper.colorTag ?? "#3B82F6" }}
        >
          {capper.name.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <h1 className="text-xl font-semibold">{capper.name}</h1>
          <p className="text-sm text-gray-500">
            {capper.source === "OTHER" && capper.customSource
              ? capper.customSource
              : SOURCE_LABELS[capper.source]}
            {capper.sportSpecialization ? " - " + capper.sportSpecialization : ""}
          </p>
        </div>
      </div>

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
            stats.currentStreak.type === "NONE"
              ? "-"
              : stats.currentStreak.count + " " + stats.currentStreak.type
          }
          tone={stats.currentStreak.type === "WIN" ? "up" : stats.currentStreak.type === "LOSS" ? "down" : undefined}
        />
      </div>

      {allTimeScorecard.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-gray-700">Record by bet type</div>
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
            <p className="rounded-card bg-white p-6 text-center text-sm text-gray-400 shadow-soft">
              No graded picks in this window.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 rounded-card bg-white p-5 shadow-soft">
        <div className="mb-2 text-sm font-medium text-gray-700">Units over time</div>
        <UnitsChart data={chartData} />
      </div>

      <div className="mt-4 rounded-card bg-white shadow-soft">
        <div className="border-b border-gray-100 px-5 py-3 text-sm font-medium text-gray-700">
          Recent picks
        </div>
        {recentPicks.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">
            No picks logged for this capper yet.
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {recentPicks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">
                    {pick.awayTeam} @ {pick.homeTeam}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500">
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

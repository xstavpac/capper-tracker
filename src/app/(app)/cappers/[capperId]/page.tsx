import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getCapperById, getCappersWithPickCounts } from "@/server/data/cappers";
import { CapperEditPanel } from "@/components/dashboard/capper-edit-panel";
import { getCapperDetailData } from "@/server/data/capper-detail";
import { formatPickLabel, betTypeLabel } from "@/lib/bet-line";
import { SCORECARD_WINDOWS, SCORECARD_WINDOW_LABELS, type ScorecardWindow } from "@/server/data/stats";
import { UnitsChart } from "@/components/dashboard/units-chart";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { MomentumPanel } from "@/components/dashboard/momentum-panel";
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

// Every link on this page can change exactly one of these three independent
// params (which bet-type-scorecard window, which sport's category section,
// which category-section window) while the other two must survive the
// navigation unchanged - centralized here so every Link builds its href the
// same way instead of each one re-assembling (and risking dropping) the
// params it isn't touching.
function pageHref(state: { window: ScorecardWindow; categorySport?: string; categoryWindow: ScorecardWindow }) {
  const params = new URLSearchParams();
  params.set("window", state.window);
  if (state.categorySport) params.set("categorySport", state.categorySport);
  params.set("categoryWindow", state.categoryWindow);
  return "?" + params.toString();
}

export default async function CapperDetailPage({
  params,
  searchParams,
}: {
  params: { capperId: string };
  searchParams: { window?: string; categorySport?: string; categoryWindow?: string };
}) {
  const user = await requireUser();
  const capper = await getCapperById(user.id, params.capperId);

  if (!capper) {
    notFound();
  }

  const window = SCORECARD_WINDOWS.includes(searchParams.window as ScorecardWindow)
    ? (searchParams.window as ScorecardWindow)
    : "ALL";
  // Fully independent of `window` above - its own searchParam, its own
  // default, never read or written by the bet-type scorecard's toggle. Scopes
  // the per-sport category section (summary strip, tiles, units chart) only.
  const categoryWindow = SCORECARD_WINDOWS.includes(searchParams.categoryWindow as ScorecardWindow)
    ? (searchParams.categoryWindow as ScorecardWindow)
    : "ALL";

  // ONE statement for everything below the header (getCapperDetailData): window totals, category
  // tiles, the sport tabs, the recent picks and a narrow decided-pick series that the existing
  // streak / momentum / consistency / odds-range / chart functions run over. The page no longer
  // loads the capper's pick history. The three params are independent (window scopes the bet-type
  // scorecard and hero, categoryWindow the per-sport section, categorySport which sport that is);
  // every one of them re-renders this server component, and none of it is cached (design doc Q8).
  const [detail, allCappers] = await Promise.all([
    getCapperDetailData(user.id, params.capperId, { window, categoryWindow, categorySport: searchParams.categorySport }),
    getCappersWithPickCounts(user.id),
  ]);
  const otherCappers = allCappers.filter((c) => c.id !== capper.id);
  // Record/ROI/Net units reflect whichever window is selected, same as the scorecard below - but
  // currentStreak deliberately always comes from the unfiltered, all-time series: a streak is a
  // count of consecutive results in true chronological order, and filtering the input to a window
  // would truncate a real ongoing streak into a smaller, misleading number.
  const {
    stats,
    currentStreak,
    momentum,
    allTimeUniversalBreakdown,
    universalBreakdown,
    chartData,
    sportTabs,
    selectedCategorySport,
    activeCategoryBreakdown,
    activeSportStats,
    activeSportChartData,
    recentPicks,
    recentPicksSport,
    trackedSinceMs,
    lastPickMs,
    bestOddsRange,
    consistency,
    associatedPickCount,
  } = detail;

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
          associatedPickCount={associatedPickCount}
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
            <StreakBadge streak={currentStreak} />
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
            currentStreak.type === "NONE"
              ? "-"
              : currentStreak.count + " " + currentStreak.type
          }
          tone={
            currentStreak.type === "WIN"
              ? "up"
              : currentStreak.type === "LOSS"
                ? "down"
                : undefined
          }
        />
      </div>

      <MomentumPanel breakdown={momentum} currentStreak={currentStreak} />

      {allTimeUniversalBreakdown.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-muted-foreground">Record by bet type (all sports)</div>
            <div className="flex flex-wrap gap-2">
              {SCORECARD_WINDOWS.map((w) => (
                <Link
                  key={w}
                  href={pageHref({ window: w, categorySport: selectedCategorySport, categoryWindow })}
                  scroll={false}
                  className={chipClass(window === w)}
                >
                  {SCORECARD_WINDOW_LABELS[w]}
                </Link>
              ))}
            </div>
          </div>
          {universalBreakdown.length > 0 ? (
            <CategoryBreakdown items={universalBreakdown} />
          ) : (
            <p className="rounded-card bg-card p-6 text-center text-sm text-muted-foreground shadow-soft">
              No graded picks in this window.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 rounded-card bg-card p-5 shadow-soft">
        <div className="mb-2 text-sm font-medium text-muted-foreground">Units over time</div>
        <UnitsChart data={chartData} />
      </div>

      {sportTabs.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-muted-foreground">{selectedCategorySport} record by category</div>
            {sportTabs.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {sportTabs.map((sportName) => (
                  <Link
                    key={sportName}
                    href={pageHref({ window, categorySport: sportName, categoryWindow })}
                    scroll={false}
                    className={chipClass(sportName === selectedCategorySport)}
                  >
                    {sportName}
                  </Link>
                ))}
              </div>
            )}
          </div>
          {/* This section's own window filter - fully independent of the bet-
              type scorecard's `window` above (separate searchParam, separate
              state); scopes the summary strip, category tiles, and units
              chart below, all three sourced from the same categoryWindow-
              filtered pick array so they can never disagree with each other. */}
          <div className="mb-4 flex flex-wrap gap-2">
            {SCORECARD_WINDOWS.map((w) => (
              <Link
                key={w}
                href={pageHref({ window, categorySport: selectedCategorySport, categoryWindow: w })}
                scroll={false}
                className={chipClass(categoryWindow === w)}
              >
                {SCORECARD_WINDOW_LABELS[w]}
              </Link>
            ))}
          </div>
          {activeSportStats && (
            <div className="mb-4 grid grid-cols-3 gap-4">
              <StatCard
                label={selectedCategorySport + " record"}
                value={activeSportStats.wins + "-" + activeSportStats.losses + "-" + activeSportStats.pushes}
              />
              <StatCard
                label="ROI"
                value={(activeSportStats.roi >= 0 ? "+" : "") + activeSportStats.roi + "%"}
                tone={activeSportStats.roi >= 0 ? "up" : "down"}
              />
              <StatCard
                label="Net units"
                value={(activeSportStats.netUnits >= 0 ? "+" : "") + activeSportStats.netUnits + "u"}
                tone={activeSportStats.netUnits >= 0 ? "up" : "down"}
              />
            </div>
          )}
          {activeCategoryBreakdown.length > 0 ? (
            <CategoryBreakdown items={activeCategoryBreakdown} />
          ) : (
            <p className="rounded-card bg-card p-6 text-center text-sm text-muted-foreground shadow-soft">
              No graded picks in this window.
            </p>
          )}
          <div className="mt-4 rounded-card bg-card p-4 shadow-soft">
            <div className="mb-2 text-xs text-muted-foreground">
              {selectedCategorySport} units over time — {SCORECARD_WINDOW_LABELS[categoryWindow]}
            </div>
            <UnitsChart data={activeSportChartData} compact />
          </div>
        </div>
      )}

      <div className="mt-4 rounded-card bg-card shadow-soft">
        <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
          {recentPicksSport ? "Recent " + recentPicksSport + " picks" : "Recent picks"}
        </div>
        {recentPicks.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            {recentPicksSport
              ? "No " + recentPicksSport + " picks logged for this capper yet."
              : "No picks logged for this capper yet."}
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
                    {formatPickLabel(pick.betDetail, pick.betType, pick.line) ?? betTypeLabel(pick.betType)} -{" "}
                    {pick.odds > 0 ? "+" : ""}
                    {pick.odds} - {pick.units}u - {formatEastern(pick.gameTime, { month: "short", day: "numeric" })}
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

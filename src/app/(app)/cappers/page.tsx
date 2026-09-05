import Link from "next/link";
import { requireUser } from "@/server/auth";
import {
  getPlanStatus,
  getCapperLeaderboardTable,
  getMostActiveThisWeek,
  getSportCategoryPanelData,
  getCappersWithPickCounts,
  findSuspectedDuplicateCappers,
  getFavoriteCappersSummary,
  type LeaderboardEntry,
  type FavoriteCappersSummary as FavoriteCappersSummaryData,
} from "@/server/data/cappers";
import { LIVE_SPORTS } from "@/server/data/odds";
import { PICK_CATEGORY_LABELS, SCORECARD_WINDOWS, type ScorecardWindow } from "@/server/data/stats";
import { CapperForm } from "@/components/dashboard/capper-form";
import { CappersLeaderboardTable } from "@/components/dashboard/cappers-leaderboard-table";
import { FavoriteCappersSummary } from "@/components/dashboard/favorite-cappers-summary";
import { BestAtPanel, type BestAtEntry } from "@/components/dashboard/best-at-panel";
import { MostActivePanel } from "@/components/dashboard/most-active-panel";
import { MergeCappersPanel } from "@/components/dashboard/merge-cappers-panel";

const LEAGUES = LIVE_SPORTS.map((s) => s.label);

// "Best at..." needs one concrete sport to compute a category set for
// (chipSetForLeague) - MLB by default (richest category set: F5 ML/NRFI
// alongside the universal ones), or whichever league pill is active.
const DEFAULT_BEST_AT_SPORT = "MLB";

function pillClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-brand-600 text-white" : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

function buildHref(league: string | undefined) {
  return league ? "/cappers?league=" + encodeURIComponent(league) : "/cappers";
}

export default async function CappersPage({
  searchParams,
}: {
  searchParams: { league?: string };
}) {
  const user = await requireUser();

  const league = LEAGUES.includes(searchParams.league ?? "") ? searchParams.league : undefined;
  const bestAtSport = league ?? DEFAULT_BEST_AT_SPORT;

  const [planStatus, entriesByWindowList, favoriteSummaryByWindowList, mostActive, categoryPanel, cappersWithCounts, suspectedDuplicates] =
    await Promise.all([
      getPlanStatus(user.id),
      // All 5 SCORECARD_WINDOWS fetched up front, same "toggle is instant, no
      // reload" UX the leaderboard already had for its old 2-option This-week/
      // All-time toggle - see CappersLeaderboardTable, which just picks which
      // of these 5 already-fetched arrays to display.
      Promise.all(SCORECARD_WINDOWS.map((w) => getCapperLeaderboardTable(user.id, w, { sportName: league }))),
      // Not league-filtered, unlike the leaderboard above - the Favorites
      // summary pools every favorited capper's picks across all sports, same
      // "collective record across all of them together" scope regardless of
      // which league pill happens to be active.
      Promise.all(SCORECARD_WINDOWS.map((w) => getFavoriteCappersSummary(user.id, w))),
      getMostActiveThisWeek(user.id, { sportName: league }),
      getSportCategoryPanelData(user.id, bestAtSport),
      getCappersWithPickCounts(user.id),
      findSuspectedDuplicateCappers(user.id),
    ]);

  const entriesByWindow = Object.fromEntries(
    SCORECARD_WINDOWS.map((w, i) => [w, entriesByWindowList[i]])
  ) as Record<ScorecardWindow, LeaderboardEntry[]>;

  // Every window either has a summary or none do - a favorite/unfavorite only
  // flips at pick-import-independent times, so there's no scenario where one
  // window has favorites and another doesn't. Using window 0 (TODAY) as the
  // "does the user have any favorites at all" check is safe on that basis.
  const hasFavorites = favoriteSummaryByWindowList[0] !== null;
  const favoriteSummaryByWindow = hasFavorites
    ? (Object.fromEntries(
        SCORECARD_WINDOWS.map((w, i) => [w, favoriteSummaryByWindowList[i]])
      ) as Record<ScorecardWindow, FavoriteCappersSummaryData>)
    : null;

  const bestAtEntries: BestAtEntry[] = categoryPanel.breakdown
    .map((item) => {
      const top = categoryPanel.leaderboards[item.key]?.[0];
      if (!top) return null;
      return { category: item.key, label: PICK_CATEGORY_LABELS[item.key], capperId: top.capperId, capperName: top.name, winPct: top.winPct };
    })
    .filter((e): e is BestAtEntry => e !== null);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Cappers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {planStatus.capperCount + " capper" + (planStatus.capperCount === 1 ? "" : "s")}
          </p>
        </div>
        <CapperForm atLimit={false} />
      </div>

      {favoriteSummaryByWindow && <FavoriteCappersSummary summaryByWindow={favoriteSummaryByWindow} />}

      {suspectedDuplicates.length > 0 && (
        <div className="mb-6">
          <MergeCappersPanel cappers={cappersWithCounts} suspected={suspectedDuplicates} />
        </div>
      )}

      {/* Link with scroll={false}, not a raw <a>: a plain anchor is a full
          browser navigation (the App Router never sees it) and browsers reset
          scroll to top on any full navigation, so filtering from partway down
          the page jumped back to the top. This is the same fix already made
          for the capper detail page's tab row in commit fbc82b0 - a soft
          client navigation that swaps the filtered data in place with the
          scroll position untouched. */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Link href={buildHref(undefined)} scroll={false} className={pillClass(!league)}>
          All leagues
        </Link>
        {LEAGUES.map((l) => (
          <Link key={l} href={buildHref(l)} scroll={false} className={pillClass(league === l)}>
            {l}
          </Link>
        ))}
      </div>

      {planStatus.capperCount === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No cappers yet - add the first person or channel you follow for picks.</p>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <CappersLeaderboardTable entriesByWindow={entriesByWindow} />
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <BestAtPanel entries={bestAtEntries} />
            <MostActivePanel entries={mostActive} />
          </div>
        </>
      )}
    </div>
  );
}

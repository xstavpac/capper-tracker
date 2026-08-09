import { requireUser } from "@/server/auth";
import { getPlanStatus, getCapperLeaderboardTable, getMostActiveThisWeek, getSportCategoryPanelData } from "@/server/data/cappers";
import { LIVE_SPORTS } from "@/server/data/odds";
import { PICK_CATEGORY_LABELS } from "@/server/data/stats";
import { CapperForm } from "@/components/dashboard/capper-form";
import { CappersLeaderboardTable } from "@/components/dashboard/cappers-leaderboard-table";
import { BestAtPanel, type BestAtEntry } from "@/components/dashboard/best-at-panel";
import { MostActivePanel } from "@/components/dashboard/most-active-panel";

const LEAGUES = LIVE_SPORTS.map((s) => s.label);

// "Best at..." needs one concrete sport to compute a category set for
// (chipSetForLeague) - MLB by default (richest category set: F5 ML/NRFI
// alongside the universal ones), or whichever league pill is active.
const DEFAULT_BEST_AT_SPORT = "MLB";

function pillClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-brand-600 text-white" : "bg-white text-gray-600 shadow-soft hover:bg-gray-50")
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

  const [planStatus, weekEntries, allTimeEntries, mostActive, categoryPanel] = await Promise.all([
    getPlanStatus(user.id),
    getCapperLeaderboardTable(user.id, "LAST_7", { sportName: league }),
    getCapperLeaderboardTable(user.id, "ALL", { sportName: league }),
    getMostActiveThisWeek(user.id, { sportName: league }),
    getSportCategoryPanelData(user.id, bestAtSport),
  ]);

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
          <p className="mt-1 text-sm text-gray-500">
            {planStatus.capperCount + " capper" + (planStatus.capperCount === 1 ? "" : "s")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            title="Coming soon"
            className="cursor-not-allowed rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-400"
          >
            Compare two
          </button>
          <CapperForm atLimit={false} />
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <a href={buildHref(undefined)} className={pillClass(!league)}>
          All leagues
        </a>
        {LEAGUES.map((l) => (
          <a key={l} href={buildHref(l)} className={pillClass(league === l)}>
            {l}
          </a>
        ))}
      </div>

      {planStatus.capperCount === 0 ? (
        <div className="rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">No cappers yet - add the first person or channel you follow for picks.</p>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <CappersLeaderboardTable weekEntries={weekEntries} allTimeEntries={allTimeEntries} />
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

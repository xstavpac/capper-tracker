import { requireUser } from "@/server/auth";
import { getPlanStatus, getCappersWithPickCounts, findSuspectedDuplicateCappers, type LeaderboardEntry } from "@/server/data/cappers";
import {
  getMostActiveThisWeek,
  getCapperLeaderboardTable,
  getFavoriteCappersSummary,
} from "@/server/data/pick-aggregates-cappers-adapter";
import { getCapperSparklines, getCappersOverview } from "@/server/data/cappers-page-aggregates";
import { LIVE_SPORTS } from "@/server/data/odds";
import { PAGE_SIZE, parseCappersParams, type CappersSortKey } from "@/lib/cappers-page-params";
import { CapperForm } from "@/components/dashboard/capper-form";
import { MergeCappersPanel } from "@/components/dashboard/merge-cappers-panel";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { CappersStatCards } from "@/components/dashboard/cappers-stat-cards";
import { MostActivePanel } from "@/components/dashboard/most-active-panel";
import { TopCappers } from "@/components/dashboard/top-cappers";
import { CappersLeaderboardCard } from "@/components/dashboard/cappers-leaderboard-card";

const LEAGUES = LIVE_SPORTS.map((s) => s.label);
const TOP_CAPPERS_COUNT = 4;

const decided = (e: LeaderboardEntry) => e.stats.wins + e.stats.losses + e.stats.pushes;

const SORTERS: Record<CappersSortKey, (a: LeaderboardEntry, b: LeaderboardEntry) => number> = {
  roi: (a, b) => b.stats.roi - a.stats.roi,
  win: (a, b) => b.stats.winPct - a.stats.winPct,
  units: (a, b) => b.stats.netUnits - a.stats.netUnits,
  record: (a, b) => b.stats.wins - b.stats.losses - (a.stats.wins - a.stats.losses) || b.stats.wins - a.stats.wins,
};

function rank(entries: LeaderboardEntry[], sort: CappersSortKey) {
  // Ties fall back to units, then name, so the order (and the pages) never shuffle.
  return [...entries].sort(
    (a, b) => SORTERS[sort](a, b) || b.stats.netUnits - a.stats.netUnits || a.name.localeCompare(b.name) || (a.capperId < b.capperId ? -1 : 1)
  );
}

export default async function CappersPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const user = await requireUser();
  const params = parseCappersParams(searchParams, LEAGUES);
  const { window } = params;

  const allLeaguesPromise = getCapperLeaderboardTable(user.id, window);
  const [planStatus, allLeagues, leagueEntries, overview, mostActive, sparklines, favSummary, cappersWithCounts, suspectedDuplicates] =
    await Promise.all([
      getPlanStatus(user.id),
      allLeaguesPromise,
      params.league ? getCapperLeaderboardTable(user.id, window, { sportName: params.league }) : allLeaguesPromise,
      getCappersOverview(user.id, window),
      getMostActiveThisWeek(user.id),
      getCapperSparklines(user.id),
      params.fav ? getFavoriteCappersSummary(user.id, window) : Promise.resolve(null),
      getCappersWithPickCounts(user.id),
      findSuspectedDuplicateCappers(user.id),
    ]);

  // Same minimum-picks rule as the leaderboard below, but never zero: a capper with
  // no decided picks has no ROI to rank.
  const topCappers = rank(allLeagues.filter((e) => decided(e) >= Math.max(params.min, 1)), "roi").slice(0, TOP_CAPPERS_COUNT);

  const q = params.q.trim().toLowerCase();
  const filtered = rank(
    leagueEntries.filter((e) => decided(e) >= params.min && (!params.fav || e.isFavorite) && (!q || e.name.toLowerCase().includes(q))),
    params.sort
  );
  const lastPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(params.page, lastPage);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Cappers</h1>
          <p className="mt-1 text-xs text-muted-foreground">{planStatus.capperCount + " tracked capper" + (planStatus.capperCount === 1 ? "" : "s")}</p>
        </div>
        <CapperForm atLimit={false} />
      </div>

      {suspectedDuplicates.length > 0 && <MergeCappersPanel cappers={cappersWithCounts} suspected={suspectedDuplicates} />}

      {planStatus.capperCount === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No cappers yet - add the first person or channel you follow for picks.</p>
        </div>
      ) : (
        <>
          <CappersTimeTabs params={params} />
          <CappersStatCards stats={overview} range={params.range} />
          <MostActivePanel entries={mostActive} />
          <TopCappers entries={topCappers} sparklines={sparklines} />
          <CappersLeaderboardCard
            rows={rows}
            total={filtered.length}
            params={{ ...params, page }}
            leagues={LEAGUES}
            sparklines={sparklines}
            favSummary={favSummary}
          />
        </>
      )}
    </div>
  );
}

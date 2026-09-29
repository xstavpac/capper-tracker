import { requireUser } from "@/server/auth";
import { getCappersWithPickCounts, findSuspectedDuplicateCappers } from "@/server/data/cappers";
import { getCappersPageData } from "@/server/data/cappers-page-aggregates";
import { LIVE_SPORTS } from "@/server/data/odds";
import { parseCappersParams } from "@/lib/cappers-page-params";
import { CapperForm } from "@/components/dashboard/capper-form";
import { MergeCappersPanel } from "@/components/dashboard/merge-cappers-panel";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { CappersStatCards } from "@/components/dashboard/cappers-stat-cards";
import { CapperPanel } from "@/components/dashboard/capper-panel";
import { FlameIcon, SnowflakeIcon, TrendingUpIcon, UsersIcon, ActivityIcon } from "@/components/dashboard/cappers-icons";
import { TopCappers } from "@/components/dashboard/top-cappers";
import { CappersLeaderboardCard } from "@/components/dashboard/cappers-leaderboard-card";

const LEAGUES = LIVE_SPORTS.map((s) => s.label);

export default async function CappersPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const user = await requireUser();
  const params = parseCappersParams(searchParams, LEAGUES);

  // One database statement for everything on the page (see cappers-page-aggregates.ts): the
  // database filters, ranks and paginates, and returns only what is drawn.
  const data = await getCappersPageData({
    userId: user.id,
    window: params.window,
    league: params.league,
    min: params.min,
    sort: params.sort,
    fav: params.fav,
    q: params.q,
    page: params.page,
  });

  // The merge panel is conditional, so the roster-with-counts fetch only happens when there is
  // something to merge.
  const suspectedDuplicates = await findSuspectedDuplicateCappers(user.id);
  const cappersWithCounts = suspectedDuplicates.length > 0 ? await getCappersWithPickCounts(user.id) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2.5 text-xl font-semibold">
          <UsersIcon className="h-6 w-6 text-brand-600" />
          Cappers
        </h1>
        <CapperForm atLimit={false} />
      </div>

      {suspectedDuplicates.length > 0 && <MergeCappersPanel cappers={cappersWithCounts} suspected={suspectedDuplicates} />}

      {data.capperCount === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No cappers yet - add the first person or channel you follow for picks.</p>
        </div>
      ) : (
        <>
          <CappersTimeTabs params={params} />
          <CappersStatCards stats={data.overview} capperCount={data.capperCount} range={params.range} />
          <div className="grid grid-cols-1 items-stretch gap-4 min-[769px]:grid-cols-2 sm:gap-6">
            <CapperPanel panel="active" icon={<ActivityIcon />} initial={data.mostActive} />
            <CapperPanel panel="hottest" icon={<FlameIcon />} initial={data.hottest} />
            <CapperPanel panel="winners" icon={<TrendingUpIcon />} initial={data.winners} />
            <CapperPanel panel="coldest" icon={<SnowflakeIcon />} initial={data.coldest} />
          </div>
          <TopCappers entries={data.top} sparklines={data.sparklines} />
          <CappersLeaderboardCard
            rows={data.rows}
            total={data.total}
            params={{ ...params, page: data.page }}
            leagues={LEAGUES}
            sparklines={data.sparklines}
            favSummary={data.favSummary}
          />
        </>
      )}
    </div>
  );
}

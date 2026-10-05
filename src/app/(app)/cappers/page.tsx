import { requireUser } from "@/server/auth";
import { getCappersWithPickCounts, findSuspectedDuplicateCappers } from "@/server/data/cappers";
import { getCappersPageData } from "@/server/data/cappers-page-aggregates";
import { LIVE_SPORTS } from "@/server/data/odds";
import { parseCappersParams } from "@/lib/cappers-page-params";
import { CapperForm } from "@/components/dashboard/capper-form";
import { MergeCappersPanel } from "@/components/dashboard/merge-cappers-panel";
import { CappersHeader } from "@/components/dashboard/cappers-header";
import { CappersStatCards } from "@/components/dashboard/cappers-stat-cards";
import { CapperPanel, FormPanel } from "@/components/dashboard/capper-panel";
import { TopCappers } from "@/components/dashboard/top-cappers";
import { CappersLeaderboardCard } from "@/components/dashboard/cappers-leaderboard-card";

const LEAGUES = LIVE_SPORTS.map((s) => s.label);
// The Add capper button as it sits in the dark banner.
const ADD_BUTTON = "h-9 shrink-0 rounded-lg bg-brand-600 px-3.5 text-[13px] font-medium text-white transition hover:bg-brand-700";

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
    <div className="mx-auto max-w-[1280px] space-y-3 tabular-nums">
      <CappersHeader params={params} controls={data.capperCount > 0}>
        <CapperForm atLimit={false} triggerClassName={ADD_BUTTON + (data.capperCount > 0 ? "" : " ml-auto")} />
      </CappersHeader>
      {suspectedDuplicates.length > 0 && <MergeCappersPanel cappers={cappersWithCounts} suspected={suspectedDuplicates} />}

      {data.capperCount === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No cappers yet - add the first person or channel you follow for picks.</p>
        </div>
      ) : (
        <>
          <CappersStatCards stats={data.overview} capperCount={data.capperCount} />
          {/* Three across on a wide screen (Most Active | Rising Fast | Hot Hand, then Most Consistent |
              Biggest Winners | Coldest), fewer as the width shrinks, one per row on a phone. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-stretch gap-3">
            <CapperPanel panel="active" initial={data.mostActive} weekPct={data.overview.picksThisWeekPct} />
            <FormPanel panel="rising" rows={data.rising} />
            <CapperPanel panel="hottest" initial={data.hottest} />
            <FormPanel panel="consistent" rows={data.consistent} />
            <CapperPanel panel="winners" initial={data.winners} />
            <CapperPanel panel="coldest" initial={data.coldest} />
          </div>
          <div className="space-y-6 pt-2.5">
            <TopCappers entries={data.top} sparklines={data.topSparklines} />
            <CappersLeaderboardCard
              rows={data.rows}
              total={data.total}
              params={{ ...params, page: data.page }}
              leagues={LEAGUES}
              sparklines={data.sparklines}
              favSummary={data.favSummary}
            />
          </div>
        </>
      )}
    </div>
  );
}

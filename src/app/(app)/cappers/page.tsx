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
import { ThemedPage } from "@/components/dashboard/themed-page";

const LEAGUES = LIVE_SPORTS.map((s) => s.label);
// The Add capper button as it sits in the dark banner.
const ADD_BUTTON = "h-10 shrink-0 rounded-[10px] bg-brand-600 px-[18px] text-[13px] font-medium text-white transition hover:bg-brand-700";

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
    <ThemedPage>
      <CappersHeader params={params} controls={data.capperCount > 0}>
        {data.capperCount > 0 ? (
          // On a phone the Add control is in the leaderboard card instead. sm:contents: from `sm` up
          // the wrapper is not a box, so the button (or the open form) sits in the banner as before.
          <div className="hidden sm:contents">
            <CapperForm atLimit={false} triggerClassName={ADD_BUTTON} />
          </div>
        ) : (
          <CapperForm atLimit={false} triggerClassName={ADD_BUTTON + " ml-auto"} />
        )}
      </CappersHeader>
      {suspectedDuplicates.length > 0 && <MergeCappersPanel cappers={cappersWithCounts} suspected={suspectedDuplicates} />}

      {data.capperCount === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No cappers yet - add the first person or channel you follow for picks.</p>
        </div>
      ) : (
        <>
          <CappersStatCards stats={data.overview} capperCount={data.capperCount} />
          {/* The track-record panels. Three across from a ~1500px screen; from ~1100px Most Active and
              Most Consistent sit side by side with Biggest Winners full width under them; one per row
              below that. (Hot Hand, Coldest and Rising Fast are on /dashboard.) */}
          <div className="grid grid-cols-1 items-stretch gap-3.5 min-[1100px]:grid-cols-2 min-[1500px]:grid-cols-3">
            <CapperPanel panel="active" initial={data.mostActive} weekPct={data.overview.picksThisWeekPct} />
            <FormPanel panel="consistent" rows={data.consistent} />
            <div className="min-[1100px]:max-[1499px]:col-span-2">
              <CapperPanel panel="winners" initial={data.winners} />
            </div>
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
    </ThemedPage>
  );
}

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
import { Plus_Jakarta_Sans } from "next/font/google";

// This page's own typeface, applied to its wrapper only (self-hosted by next/font at build time).
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", fallback: ["system-ui", "sans-serif"] });
// The page's soft neutral backdrop, painted over the shared layout's content padding (p-4 / md:p-8)
// rather than changing that layout, and at least as tall as that content area (the viewport less the
// ticker and the layout gutter) so a short page is not half white. The top is only pulled up when
// nothing sits above the page. Its own gutter is the same on every side: 24px, 32px from 1536px.
// The content fills that area; its max-width only stops it stretching further on an ultrawide screen.
const BACKDROP = "-mx-4 -mb-4 bg-[#F5F6FA] px-4 pb-4 pt-4 first:-mt-4 dark:bg-transparent md:-mx-8 md:-mb-8 md:min-h-[calc(100vh-68px)] md:rounded-[11px] md:px-6 md:pb-6 md:pt-6 md:first:-mt-8 min-[1536px]:px-8 min-[1536px]:pb-8 min-[1536px]:pt-8";

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
    <div className={jakarta.className + " " + BACKDROP}>
      <div className="mx-auto max-w-[1680px] space-y-3.5">
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
          {/* Three across from a ~1500px screen (Most Active | Rising Fast | Hot Hand, then Most Consistent |
              Biggest Winners | Coldest), two across from ~1100px, one per row below that. */}
          <div className="grid grid-cols-1 items-stretch gap-3.5 min-[1100px]:grid-cols-2 min-[1500px]:grid-cols-3">
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
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getCapperById, getCappersWithPickCounts } from "@/server/data/cappers";
import { CapperEditPanel } from "@/components/dashboard/capper-edit-panel";
import { CAPPER_RECENT_PAGE_SIZE, clampRecentLimit, getCapperPageData } from "@/server/data/capper-detail";
import { SCORECARD_WINDOWS, SCORECARD_WINDOW_LABELS, type ScorecardWindow } from "@/server/data/stats";
import { CapperHero } from "@/components/dashboard/capper-hero";
import { CapperUnitsChart } from "@/components/dashboard/capper-units-chart";
import { MarketTile } from "@/components/dashboard/market-tile";
import { RecentPickRow } from "@/components/dashboard/recent-pick-row";
import { leagueColorVars } from "@/lib/league-colors";
import { formatSignedUnits, unitsExtremes } from "@/lib/units-extremes";

const ALL_SPORTS_LABEL = "All Sports";

// The time control's own short labels; the chart's subtitle keeps the app's full ones.
const RANGE_LABELS: Record<ScorecardWindow, string> = {
  TODAY: "Today",
  YESTERDAY: "Yesterday",
  LAST_7: "7D",
  LAST_30: "30D",
  LAST_60: "60D",
  ALL: "All time",
};

// The soft backdrop, painted over the shared layout's content padding (p-4 / md:p-8) the way
// /cappers and /dashboard do it (themed-page.tsx), without their typeface.
const BACKDROP = "-mx-4 -mb-4 bg-[#F3F5FA] px-4 pb-4 pt-4 first:-mt-4 dark:bg-transparent md:-mx-8 md:-mb-8 md:min-h-[calc(100vh-68px)] md:rounded-[11px] md:px-6 md:pb-6 md:pt-6 md:first:-mt-8";
const CARD = "border border-[#E5E9F2] bg-white dark:border-border dark:bg-card";
const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

// The avatar's text: the first character of every word ("Picks 4 Dayz" -> "P4D"), or a short
// one-word name whole ("P4D"); a long single word falls back to its first two letters.
function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0].length <= 4 ? words[0] : words[0].slice(0, 2)).toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function ChartStat({ label, value, tone, large }: { label: string; value: number; tone: "up" | "down"; large?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B] dark:text-muted-foreground">{label}</div>
      <div
        className={
          "font-extrabold leading-tight tabular-nums " +
          (large ? "text-[26px] " : "text-lg ") +
          (tone === "up" ? "text-[#059669] dark:text-emerald-400" : "text-[#DC2626] dark:text-red-400")
        }
      >
        {formatSignedUnits(value, 1)}
      </div>
    </div>
  );
}

// The Performance section's whole state. Every link changes one of these and must carry the
// others - centralized here so no Link re-assembles (and risks dropping) the params it isn't
// touching. Defaults are left out of the URL.
type PageState = { sport: string | null; window: ScorecardWindow; recent: number };
function pageHref(state: PageState) {
  const params = new URLSearchParams();
  if (state.sport) params.set("sport", state.sport);
  if (state.window !== "ALL") params.set("window", state.window);
  if (state.recent > CAPPER_RECENT_PAGE_SIZE) params.set("recent", String(state.recent));
  const query = params.toString();
  return query ? "?" + query : "?";
}

export default async function CapperDetailPage({
  params,
  searchParams,
}: {
  params: { capperId: string };
  searchParams: { sport?: string; window?: string; recent?: string };
}) {
  const user = await requireUser();
  const capper = await getCapperById(user.id, params.capperId);

  if (!capper) {
    notFound();
  }

  const window = SCORECARD_WINDOWS.includes(searchParams.window as ScorecardWindow)
    ? (searchParams.window as ScorecardWindow)
    : "ALL";
  const recent = clampRecentLimit(Number(searchParams.recent));

  // ONE statement for everything below the top row (getCapperPageData). The sport + time selection
  // scopes the banner's record, the chart, the tiles and the recent picks; the streak and the
  // momentum card are always all sports, all time. Nothing is cached - every tab re-renders this
  // server component.
  const [detail, allCappers] = await Promise.all([
    getCapperPageData(user.id, params.capperId, { sport: searchParams.sport, window, recentLimit: recent }),
    getCappersWithPickCounts(user.id),
  ]);
  const otherCappers = allCappers.filter((c) => c.id !== capper.id);
  const {
    currentStreak,
    momentum,
    sports,
    selectedSport,
    summary,
    chartData,
    tiles,
    bestMarket,
    recentPicks,
    hasMoreRecent,
    trackedSinceMs,
    lastPickMs,
    associatedPickCount,
    pendingPickCount,
  } = detail;

  // A ?sport= this capper has no pick in: All Sports, on a clean URL.
  if (searchParams.sport !== undefined && selectedSport === null) {
    redirect("/cappers/" + capper.id + pageHref({ sport: null, window, recent: CAPPER_RECENT_PAGE_SIZE }).replace(/\?$/, ""));
  }

  const sportLabel = selectedSport ?? ALL_SPORTS_LABEL;
  const extremes = unitsExtremes(chartData.map((d) => d.cumulativeUnits));
  const nowUnits = chartData.length > 0 ? chartData[chartData.length - 1].cumulativeUnits : 0;

  return (
    <div className={BACKDROP}>
      <div className="mx-auto max-w-[1120px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Breadcrumb" className="min-w-0 text-[13px] font-semibold text-[#64748B] dark:text-muted-foreground">
            <Link href="/cappers" className="hover:underline">
              Cappers
            </Link>
            <span aria-hidden> / </span>
            <span className="text-[#0F172A] dark:text-foreground">{capper.name}</span>
          </nav>
          <CapperEditPanel
            capperId={capper.id}
            currentName={capper.name}
            otherCappers={otherCappers}
            associatedPickCount={associatedPickCount}
          />
        </div>

        <CapperHero
          name={capper.name}
          initials={avatarInitials(capper.name)}
          color={capper.colorTag ?? "#3B82F6"}
          summary={summary}
          currentStreak={currentStreak}
          momentum={momentum}
          bestMarket={bestMarket}
          sports={sports}
          trackedSinceMs={trackedSinceMs}
          lastPickMs={lastPickMs}
          pickCount={associatedPickCount}
          pendingCount={pendingPickCount}
          nowMs={Date.now()}
        />

        {/* The ONE filter bar: the banner's record and everything below read this sport + time selection.
            scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top. */}
        <div className={"flex flex-wrap items-center justify-between gap-2 rounded-2xl p-2.5 " + CARD}>
          <nav aria-label="Sport" className="flex min-w-0 flex-wrap gap-1">
            {[null, ...sports].map((s) => {
              const active = s === selectedSport;
              return (
                <Link
                  key={s ?? "ALL"}
                  href={pageHref({ sport: s, window, recent: CAPPER_RECENT_PAGE_SIZE })}
                  scroll={false}
                  aria-current={active ? "page" : undefined}
                  className={
                    "flex h-10 flex-none items-center gap-2 whitespace-nowrap rounded-[10px] px-3.5 text-[13px] font-bold transition-colors " +
                    (active ? "bg-[#0B1736] text-white dark:bg-white dark:text-[#0B1736]" : "text-[#475569] hover:bg-[#F1F4F9] dark:text-muted-foreground dark:hover:bg-white/[0.06]")
                  }
                >
                  <span
                    aria-hidden
                    className={"h-2 w-2 rounded-sm " + (active ? "bg-white dark:bg-[#0B1736]" : "bg-[var(--league)] dark:bg-[var(--league-dark)]")}
                    style={leagueColorVars(s ?? "")}
                  />
                  {s ?? ALL_SPORTS_LABEL}
                </Link>
              );
            })}
          </nav>
          <nav aria-label="Time range" className={"flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-[#F1F4F9] p-1 dark:bg-white/[0.06] " + NO_SCROLLBAR}>
            {SCORECARD_WINDOWS.map((w) => {
              const active = w === window;
              return (
                <Link
                  key={w}
                  href={pageHref({ sport: selectedSport, window: w, recent: CAPPER_RECENT_PAGE_SIZE })}
                  scroll={false}
                  aria-current={active ? "page" : undefined}
                  aria-label={SCORECARD_WINDOW_LABELS[w]}
                  className={
                    "flex h-8 flex-none items-center whitespace-nowrap rounded-[9px] px-3 text-[13px] font-bold transition-colors " +
                    (active
                      ? "bg-white text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.12)] dark:bg-white/[0.14] dark:text-foreground dark:shadow-none"
                      : "text-[#64748B] hover:text-[#0F172A] dark:text-muted-foreground dark:hover:text-foreground")
                  }
                >
                  {RANGE_LABELS[w]}
                </Link>
              );
            })}
          </nav>
        </div>

        <section className={"rounded-[20px] p-4 sm:p-6 " + CARD}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div>
              <h2 className="text-lg font-extrabold text-foreground">Units over time</h2>
              <p className="text-[13px] text-[#64748B] dark:text-muted-foreground">
                {sportLabel} · {SCORECARD_WINDOW_LABELS[window]}
              </p>
            </div>
            {extremes && (
              <div className="flex items-end gap-5 sm:gap-7">
                <ChartStat label="Peak" value={chartData[extremes.peak].cumulativeUnits} tone="up" />
                <ChartStat label="Low" value={chartData[extremes.low].cumulativeUnits} tone="down" />
                <ChartStat label="Now" value={nowUnits} tone={nowUnits >= 0 ? "up" : "down"} large />
              </div>
            )}
          </div>
          <CapperUnitsChart data={chartData} />
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
            <h2 className="text-lg font-extrabold text-foreground">Market breakdown</h2>
            <p className="text-[13px] text-[#64748B] dark:text-muted-foreground">
              {selectedSport ? selectedSport + " markets" : "Core 6 · pick a league for its own market tiles"}
            </p>
          </div>
          {tiles.length > 0 ? (
            <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
              {tiles.map((item) => (
                <MarketTile key={item.key} item={item} />
              ))}
            </div>
          ) : (
            <p className={"rounded-[18px] p-6 text-center text-sm text-muted-foreground " + CARD}>No graded picks in this window.</p>
          )}
        </section>

        <section className={"overflow-hidden rounded-[20px] " + CARD}>
          <div className="flex items-center justify-between gap-3 border-b border-[#E5E9F2] px-4 py-4 dark:border-border sm:px-6">
            <h2 className="text-lg font-extrabold text-foreground">{selectedSport ? "Recent " + selectedSport + " picks" : "Recent picks"}</h2>
            {hasMoreRecent && (
              <Link
                href={pageHref({ sport: selectedSport, window, recent: recent + CAPPER_RECENT_PAGE_SIZE })}
                scroll={false}
                className="flex-none text-[13px] font-bold text-brand-600 hover:underline dark:text-brand-400"
              >
                Show more →
              </Link>
            )}
          </div>
          {recentPicks.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No recent {selectedSport ? selectedSport + " " : ""}picks in this range</p>
          ) : (
            <div className="divide-y divide-[#EEF1F6] dark:divide-border">
              {recentPicks.map((pick) => (
                <RecentPickRow key={pick.id} pick={pick} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getCapperById, getCappersWithPickCounts } from "@/server/data/cappers";
import { CapperEditPanel } from "@/components/dashboard/capper-edit-panel";
import { CAPPER_RECENT_PAGE_SIZE, clampRecentLimit, getCapperPageData } from "@/server/data/capper-detail";
import { SCORECARD_WINDOWS, SCORECARD_WINDOW_LABELS, type ScorecardWindow } from "@/server/data/stats";
import { CapperHero } from "@/components/dashboard/capper-hero";
import { CapperUnitsChart } from "@/components/dashboard/capper-units-chart";
import { CATEGORY_GRID, CategoryCard } from "@/components/dashboard/category-card";
import { ListIcon, TargetIcon, TrendingUpIcon } from "@/components/dashboard/cappers-icons";
import { Message, PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { RecentPickRow } from "@/components/dashboard/recent-pick-row";
import { MUTED } from "@/components/dashboard/stat-card";
import { ThemedPage } from "@/components/dashboard/themed-page";
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

const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
// The panels' header icon, sized as on /cappers and /live.
const PANEL_ICON = "h-[17px] w-[17px] stroke-[2.2]";

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
    <div className="flex items-baseline gap-1.5">
      <span className={"text-[11px] font-semibold uppercase tracking-[0.07em] " + MUTED}>{label}</span>
      <span
        className={
          "font-semibold leading-none tabular-nums " +
          (large ? "text-xl " : "text-base ") +
          (tone === "up" ? "text-[#059669] dark:text-emerald-400" : "text-[#DC2626] dark:text-red-400")
        }
      >
        {formatSignedUnits(value, 1)}
      </span>
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
  const filterLabel = sportLabel + " · " + SCORECARD_WINDOW_LABELS[window];
  const chartStats = extremes && (
    <>
      <ChartStat label="Peak" value={chartData[extremes.peak].cumulativeUnits} tone="up" />
      <ChartStat label="Low" value={chartData[extremes.low].cumulativeUnits} tone="down" />
      <ChartStat label="Now" value={nowUnits} tone={nowUnits >= 0 ? "up" : "down"} large />
    </>
  );

  return (
    // The typeface and backdrop of /cappers, /dashboard and /live; the content keeps its own narrower column.
    <ThemedPage>
      <div className="mx-auto max-w-[1120px] space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Breadcrumb" className="min-w-0 text-[13px] font-medium text-[#64748B] dark:text-muted-foreground">
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
          trackedSinceMs={trackedSinceMs}
          lastPickMs={lastPickMs}
          pickCount={associatedPickCount}
          pendingCount={pendingPickCount}
          nowMs={Date.now()}
        />

        {/* The ONE filter bar: the banner's record and everything below read this sport + time selection.
            scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top. */}
        <div className={"flex flex-wrap items-center justify-between gap-2 rounded-[18px] border p-2 " + TINTS.neutral.card}>
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
                    "flex h-8 flex-none items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors " +
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
          <nav aria-label="Time range" className={"flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-[#F1F4F9] p-0.5 dark:bg-white/[0.06] " + NO_SCROLLBAR}>
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
                    "flex h-7 flex-none items-center whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-colors " +
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

        {/* As on /cappers: 14px between the blocks above, 24px between the panels. */}
        <div className="space-y-6 pt-2.5">
          {/* The peak / low / now figures sit in the header from `sm` up; on a phone, under it. */}
          <PanelShell
            theme={{ ...TINTS.neutral, title: "Units over time", subtitle: filterLabel, icon: <TrendingUpIcon className={PANEL_ICON} /> }}
            control={chartStats && <div className="flex flex-none items-baseline gap-4 max-sm:hidden">{chartStats}</div>}
            footer={undefined}
          >
            {chartStats && <div className="mb-1 flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1 sm:hidden">{chartStats}</div>}
            <CapperUnitsChart data={chartData} />
          </PanelShell>

          {/* The same tiles, in the same grid, as /live's "record by category" panel. */}
          <PanelShell
            theme={{ ...TINTS.neutral, title: "Market breakdown", subtitle: filterLabel, icon: <TargetIcon className={PANEL_ICON} /> }}
            control={
              <p className={"flex-none text-xs font-medium max-sm:hidden " + TINTS.neutral.subtitleClass}>
                {selectedSport ? selectedSport + " markets" : "Core 6 · pick a league for its own market tiles"}
              </p>
            }
            footer={undefined}
          >
            {tiles.length > 0 ? (
              <div className={CATEGORY_GRID}>
                {tiles.map((item) => (
                  <CategoryCard key={item.key} label={item.label} wins={item.wins} losses={item.losses} pushes={item.pushes} winPct={item.winPct} graded={item.count} tinted />
                ))}
              </div>
            ) : (
              <Message>No graded picks in this window.</Message>
            )}
          </PanelShell>

          <PanelShell
            theme={{
              ...TINTS.neutral,
              title: selectedSport ? "Recent " + selectedSport + " picks" : "Recent picks",
              subtitle: filterLabel,
              icon: <ListIcon className={PANEL_ICON} />,
            }}
            control={
              hasMoreRecent && (
                <Link
                  href={pageHref({ sport: selectedSport, window, recent: recent + CAPPER_RECENT_PAGE_SIZE })}
                  scroll={false}
                  className="flex-none text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  Show more →
                </Link>
              )
            }
            footer={undefined}
          >
            {recentPicks.length === 0 ? (
              <Message>No recent {selectedSport ? selectedSport + " " : ""}picks in this range</Message>
            ) : (
              <div className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {recentPicks.map((pick) => (
                  <RecentPickRow key={pick.id} pick={pick} />
                ))}
              </div>
            )}
          </PanelShell>
        </div>
      </div>
    </ThemedPage>
  );
}

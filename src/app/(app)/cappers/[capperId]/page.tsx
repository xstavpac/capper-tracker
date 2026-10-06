import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getCapperById, getCappersWithPickCounts } from "@/server/data/cappers";
import { CapperEditPanel } from "@/components/dashboard/capper-edit-panel";
import { CAPPER_RECENT_PAGE_SIZE, clampRecentLimit, getCapperPageData } from "@/server/data/capper-detail";
import { formatPickLabel, betTypeLabel } from "@/lib/bet-line";
import { SCORECARD_WINDOWS, SCORECARD_WINDOW_LABELS, type ScorecardWindow } from "@/server/data/stats";
import { UnitsChart } from "@/components/dashboard/units-chart";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { MomentumPanel } from "@/components/dashboard/momentum-panel";
import { ChipRow } from "@/components/dashboard/chip-row";
import { StreakBadge } from "@/components/dashboard/capper-panels";
import { formatEastern, formatRelativeTime } from "@/lib/dates";

const ALL_SPORTS_LABEL = "All Sports";

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

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const toneClass =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";
  return (
    <div className="min-w-0 rounded-card bg-card p-3 shadow-soft sm:p-4">
      <div className="text-xs text-muted-foreground sm:text-sm">{label}</div>
      <div className={"mt-1 whitespace-nowrap text-lg font-semibold sm:text-2xl " + toneClass}>{value}</div>
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

  // ONE statement for everything below the header (getCapperPageData). The sport + time selection
  // scopes the whole Performance section (summary, chart, tiles, recent picks); the streak and
  // momentum above it are always all sports, all time. Nothing is cached - every chip re-renders
  // this server component.
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
    recentPicks,
    hasMoreRecent,
    trackedSinceMs,
    lastPickMs,
    associatedPickCount,
  } = detail;

  // A ?sport= this capper has no pick in: All Sports, on a clean URL.
  if (searchParams.sport !== undefined && selectedSport === null) {
    redirect("/cappers/" + capper.id + pageHref({ sport: null, window, recent: CAPPER_RECENT_PAGE_SIZE }).replace(/\?$/, ""));
  }

  const initials = avatarInitials(capper.name);
  const sportLabel = selectedSport ?? ALL_SPORTS_LABEL;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={
              "flex h-12 w-12 flex-none items-center justify-center rounded-full font-medium text-white " +
              (initials.length > 3 ? "text-xs" : initials.length > 2 ? "text-sm" : "text-base")
            }
            style={{ backgroundColor: capper.colorTag ?? "#3B82F6" }}
          >
            {initials}
          </div>
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold leading-tight">{capper.name}</h1>
            {trackedSinceMs !== null && lastPickMs !== null && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                Tracked since {formatEastern(new Date(trackedSinceMs), { month: "short", day: "numeric" })}
                {" · "}
                {associatedPickCount} {associatedPickCount === 1 ? "pick" : "picks"}
                {" · "}
                Last pick {formatRelativeTime(new Date(lastPickMs), Date.now())}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StreakBadge streak={currentStreak} />
          <CapperEditPanel
            capperId={capper.id}
            currentName={capper.name}
            otherCappers={otherCappers}
            associatedPickCount={associatedPickCount}
          />
        </div>
      </div>

      <MomentumPanel breakdown={momentum} currentStreak={currentStreak} />

      <div className="mt-6">
        <div className="mb-2 text-sm font-medium text-muted-foreground">Performance</div>
        {/* The ONE filter bar: everything below it reads this sport + time selection. */}
        <div className="flex flex-col gap-2">
          <ChipRow
            label="Sport"
            chips={[null, ...sports].map((s) => ({
              key: s ?? "ALL",
              label: s ?? ALL_SPORTS_LABEL,
              href: pageHref({ sport: s, window, recent: CAPPER_RECENT_PAGE_SIZE }),
              active: s === selectedSport,
            }))}
          />
          <ChipRow
            label="Time range"
            chips={SCORECARD_WINDOWS.map((w) => ({
              key: w,
              label: SCORECARD_WINDOW_LABELS[w],
              href: pageHref({ sport: selectedSport, window: w, recent: CAPPER_RECENT_PAGE_SIZE }),
              active: w === window,
            }))}
          />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-4">
          <StatCard label="Record" value={summary.wins + "-" + summary.losses + "-" + summary.pushes} />
          <StatCard
            label="ROI"
            value={(summary.roi >= 0 ? "+" : "") + summary.roi + "%"}
            tone={summary.roi >= 0 ? "up" : "down"}
          />
          <StatCard
            label="Net units"
            value={(summary.netUnits >= 0 ? "+" : "") + summary.netUnits + "u"}
            tone={summary.netUnits >= 0 ? "up" : "down"}
          />
        </div>

        <div className="mt-4 rounded-card bg-card p-5 shadow-soft">
          <div className="mb-2 text-sm font-medium text-muted-foreground">
            Units over time ({sportLabel} · {SCORECARD_WINDOW_LABELS[window]})
          </div>
          <UnitsChart data={chartData} perPick />
        </div>

        <div className="mt-4">
          {tiles.length > 0 ? (
            <CategoryBreakdown items={tiles} />
          ) : (
            <p className="rounded-card bg-card p-6 text-center text-sm text-muted-foreground shadow-soft">
              No graded picks in this window.
            </p>
          )}
        </div>

        <div className="mt-4 rounded-card bg-card shadow-soft">
          <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
            {selectedSport ? "Recent " + selectedSport + " picks" : "Recent picks"}
          </div>
          {recentPicks.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {window !== "ALL"
                ? "No " + (selectedSport ? selectedSport + " " : "") + "picks in this window."
                : selectedSport
                  ? "No " + selectedSport + " picks logged for this capper yet."
                  : "No picks logged for this capper yet."}
            </p>
          ) : (
            <div className="divide-y divide-border-subtle">
              {recentPicks.map((pick) => (
                <div key={pick.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="min-w-0">
                        {pick.awayTeam} @ {pick.homeTeam}
                      </span>
                      {!selectedSport && (
                        <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {pick.sport}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {[
                        formatPickLabel(pick.betDetail, pick.betType, pick.line) ?? betTypeLabel(pick.betType),
                        (pick.odds > 0 ? "+" : "") + pick.odds,
                        pick.units + "u",
                        formatEastern(pick.gameTime, { month: "short", day: "numeric" }),
                      ].join(" · ")}
                    </div>
                  </div>
                  <PickStatusButtons pickId={pick.id} status={pick.status} />
                </div>
              ))}
            </div>
          )}
          {hasMoreRecent && (
            <div className="border-t border-border-subtle px-5 py-3 text-center">
              <Link
                href={pageHref({ sport: selectedSport, window, recent: recent + CAPPER_RECENT_PAGE_SIZE })}
                scroll={false}
                className="rounded-full bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-soft hover:bg-muted"
              >
                Show more
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

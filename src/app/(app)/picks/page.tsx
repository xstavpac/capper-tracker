import { requireUser } from "@/server/auth";
import { getFilteredPicksForUser, getSportsWithLeagues, getPickPlanStatus } from "@/server/data/picks";
import { getCappersForUser } from "@/server/data/cappers";
import { persistFinalScores, gradePendingPicks, regradeFuzzyMatchedPicks } from "@/server/data/grading";
import { getParlaysForUser } from "@/server/data/parlays";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { PickForm } from "@/components/dashboard/pick-form";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { ParlayForm } from "@/components/dashboard/parlay-form";
import { LegStatusButtons } from "@/components/dashboard/leg-status-buttons";
import { DropCatalogLink } from "@/components/dashboard/drop-catalog-button";
import { favoriteOrUnderdog, nrfiSide } from "@/lib/bet-line";
import { formatEastern } from "@/lib/dates";
import { TIER_LABELS } from "@/lib/entitlements";
import type { BetType, PickStatus, Period } from "@prisma/client";

const STATUS_OPTIONS = ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"];

type BetTypeFilterKey =
  | "SPREAD"
  | "F5_SPREAD"
  | "MONEYLINE"
  | "F5_MONEYLINE"
  | "TOTAL"
  | "F5_TOTAL"
  | "PLAYER_PROP"
  | "NRFI"
  | "YRFI";

const BET_TYPE_FILTER_OPTIONS: { value: BetTypeFilterKey; label: string }[] = [
  { value: "SPREAD", label: "Spread" },
  { value: "F5_SPREAD", label: "F5 Spread" },
  { value: "MONEYLINE", label: "Moneyline" },
  { value: "F5_MONEYLINE", label: "F5 Moneyline" },
  { value: "TOTAL", label: "Total" },
  { value: "F5_TOTAL", label: "F5 Total" },
  { value: "PLAYER_PROP", label: "Player Prop" },
  { value: "NRFI", label: "NRFI" },
  { value: "YRFI", label: "YRFI" },
];

// Coarser and sport-agnostic than stats.ts's pickCategory - that classifier
// splits favorite/dog and over/under (this page's separate "Favorite +
// underdog" dropdown already covers the first, and there's no over/under
// equivalent), and deliberately scopes its F5 categories to MLB only so
// cross-sport leaderboards never blend an MLB capper's F5 record with
// another sport's first-half record. Neither restriction belongs here - this
// is a flat "what kind of bet is this" filter over every sport's picks, so a
// real NFL first-half moneyline or total pick needs to show up under F5
// Moneyline/F5 Total same as MLB's, not fall through pickCategory's MLB-only
// carve-out and disappear from every option. Reuses nrfiSide (the same
// betDetail-derived NRFI/YRFI split stats.ts and grading.ts use) so this
// filter can never disagree with how those picks actually graded.
function betTypeFilterCategory(pick: { betType: BetType; period: Period; betDetail: string | null }): BetTypeFilterKey | null {
  if (pick.betType === "NRFI") {
    return nrfiSide(pick.betDetail) === "YES_RUN" ? "YRFI" : "NRFI";
  }
  if (pick.period === "FIRST_HALF") {
    if (pick.betType === "MONEYLINE") return "F5_MONEYLINE";
    if (pick.betType === "SPREAD") return "F5_SPREAD";
    if (pick.betType === "TOTAL") return "F5_TOTAL";
    return null;
  }
  if (pick.betType === "SPREAD") return "SPREAD";
  if (pick.betType === "MONEYLINE") return "MONEYLINE";
  if (pick.betType === "TOTAL") return "TOTAL";
  if (pick.betType === "PLAYER_PROP") return "PLAYER_PROP";
  return null;
}

export default async function PicksPage({
  searchParams,
}: {
  searchParams: {
    capperId?: string;
    sportId?: string;
    status?: string;
    betType?: string;
    favoriteDog?: string;
  };
}) {
  const user = await requireUser();

  // Each sport's own persist-then-grade sequence is independent of the
  // others, so run them in parallel - with 3+ sports now (was just MLB),
  // doing this sequentially made every Picks page load wait on the sum of
  // every sport's fetch time instead of just the slowest one.
  await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (sportKey) => {
      const sportName = LIVE_SPORTS.find((s) => s.key === sportKey)?.label;
      if (!sportName) return;
      try {
        await persistFinalScores(sportKey);
        await gradePendingPicks(user.id, sportName, sportKey);
        await regradeFuzzyMatchedPicks(user.id, sportName, sportKey);
      } catch {
        // Live score sources are best-effort - don't block the page on a fetch failure.
      }
    })
  );

  const favoriteDog = (searchParams.favoriteDog as "FAVORITE" | "UNDERDOG") || undefined;
  const betTypeFilter = (searchParams.betType as BetTypeFilterKey) || undefined;

  const filters = {
    capperId: searchParams.capperId || undefined,
    sportId: searchParams.sportId || undefined,
    status: (searchParams.status as PickStatus) || undefined,
  };

  const [allPicks, cappers, sports, planStatus, parlays] = await Promise.all([
    getFilteredPicksForUser(user.id, filters),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getPickPlanStatus(user.id),
    getParlaysForUser(user.id),
  ]);

  // Bet type and favorite/underdog are both derived (betDetail text for
  // NRFI/YRFI, odds/line sign for favorite/dog), not stored columns, so both
  // are filtered here rather than in the DB query.
  const picks = allPicks
    .filter((p) => !betTypeFilter || betTypeFilterCategory(p) === betTypeFilter)
    .filter((p) => !favoriteDog || favoriteOrUnderdog(p) === favoriteDog);

  const hasActiveFilters = Object.values(filters).some(Boolean) || Boolean(favoriteDog) || Boolean(betTypeFilter);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Picks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {planStatus.unlimited
              ? planStatus.pickCount + " pick" + (planStatus.pickCount === 1 ? "" : "s") + " (" + TIER_LABELS[planStatus.tier] + " plan)"
              : planStatus.pickCount + " of " + planStatus.pickLimit + " picks (Free plan)"}
            {hasActiveFilters ? " - " + picks.length + " match filters" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DropCatalogLink href="/picks/import" />
          <ParlayForm cappers={cappers} sports={sports} />
          <PickForm cappers={cappers} sports={sports} atLimit={planStatus.atLimit} />
        </div>
      </div>

      <form
        method="get"
        className="mb-4 grid grid-cols-2 gap-2 rounded-card bg-card p-3 shadow-soft sm:flex sm:flex-wrap sm:items-center"
      >
        <select
          name="capperId"
          defaultValue={filters.capperId ?? ""}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto"
        >
          <option value="">All cappers</option>
          {cappers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          name="sportId"
          defaultValue={filters.sportId ?? ""}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto"
        >
          <option value="">All sports</option>
          {sports.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          name="betType"
          defaultValue={betTypeFilter ?? ""}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto"
        >
          <option value="">All bet types</option>
          {BET_TYPE_FILTER_OPTIONS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>

        <select
          name="status"
          defaultValue={filters.status ?? ""}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto"
        >
          <option value="">All results</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          name="favoriteDog"
          defaultValue={favoriteDog ?? ""}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto"
        >
          <option value="">Favorite + underdog</option>
          <option value="FAVORITE">Favorite</option>
          <option value="UNDERDOG">Underdog</option>
        </select>

        <div className="col-span-2 flex items-center gap-3 sm:col-span-1 sm:contents">
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Filter
          </button>

          {hasActiveFilters && (
            <a href="/picks" className="text-sm text-muted-foreground hover:text-foreground">
              Clear
            </a>
          )}
        </div>
      </form>

      {picks.length === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters
              ? "No picks match these filters."
              : "No picks logged yet - log your first pick above."}
          </p>
        </div>
      ) : (
        <div className="rounded-card bg-card shadow-soft">
          <div className="divide-y divide-border-subtle">
            {picks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">
                    {pick.awayTeam} @ {pick.homeTeam}
                    {pick.period === "FIRST_HALF" && (
                      <span className="ml-2 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:bg-purple-500/15 dark:text-purple-400">
                        F5
                      </span>
                    )}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {formatEastern(pick.gameTime, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {pick.capper.name} - {pick.betDetail || pick.betType} - {pick.odds > 0 ? "+" : ""}
                    {pick.odds} - {pick.units}u
                  </div>
                </div>
                <PickStatusButtons pickId={pick.id} status={pick.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {parlays.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Parlays</h2>
          <div className="space-y-3">
            {parlays.map((parlay) => {
              const statusColor =
                parlay.status === "WIN"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : parlay.status === "LOSS"
                    ? "text-red-600 dark:text-red-400"
                    : parlay.status === "PENDING"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground";
              return (
                <div key={parlay.id} className="rounded-card bg-card shadow-soft">
                  <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
                    <div className="text-sm font-medium">
                      {parlay.capper.name} - {parlay.legs.length}-leg parlay - {parlay.units}u
                    </div>
                    <span className={"text-sm font-medium " + statusColor}>{parlay.status}</span>
                  </div>
                  <div className="divide-y divide-border-subtle">
                    {parlay.legs.map((leg) => (
                      <div key={leg.id} className="flex items-center justify-between px-5 py-2.5">
                        <div>
                          <div className="text-xs font-medium text-foreground">
                            {leg.awayTeam} @ {leg.homeTeam}
                            {leg.period === "FIRST_HALF" && (
                              <span className="ml-2 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:bg-purple-500/15 dark:text-purple-400">
                                F5
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {leg.betDetail || leg.betType} - {leg.odds > 0 ? "+" : ""}
                            {leg.odds}
                          </div>
                        </div>
                        <LegStatusButtons legId={leg.id} status={leg.status} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

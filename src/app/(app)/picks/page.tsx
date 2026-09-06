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
import { RowDeleteButton } from "@/components/dashboard/row-delete-button";
import { deletePickAction } from "@/server/actions/picks";
import { deleteParlayAction } from "@/server/actions/parlays";
import { DropCatalogLink } from "@/components/dashboard/drop-catalog-button";
import { formatEastern, easternDateKey, easternDayStart } from "@/lib/dates";
import { TIER_LABELS } from "@/lib/entitlements";
import { chipSetForLeague, type PickCategoryKey } from "@/server/data/stats";
import { DateRangeFilter } from "@/components/picks/date-range-filter";
import { SportBetTypeFilter } from "@/components/picks/sport-bet-type-filter";
import { betTypeFilterCategory, BET_TYPE_FILTER_OPTIONS, type BetTypeFilterKey } from "@/lib/bet-type-filter";
import { formatPickLabel } from "@/lib/bet-line";
import type { PickStatus } from "@prisma/client";

const STATUS_OPTIONS = ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"];

// Two different sports' vocabulary for the same "first half of the game"
// period (schema.prisma's Period.FIRST_HALF comment: `"F5" in baseball
// terms, first half elsewhere`) - split into two lists (rather than the one
// combined list this used to be) so a label can be chosen per sport, not
// just a single yes/no "does this sport have first-half categories at all".
// MLB is the only chip set with the F5_* keys; NFL/NCAAF are the only chip
// sets with FIRST_HALF_ML/OVER/UNDER (see MLB_CHIP_SET/NFL_CHIP_SET's own
// comments in stats.ts) - KBO_CHIP_SET has neither, so KBO never reaches
// either branch and (same as before this split) gets no F5/1H options at
// all, not "F5" by virtue of also being a baseball-family sport.
const F5_INNINGS_CATEGORY_KEYS: PickCategoryKey[] = ["F5_ML", "F5_SPREAD_MINUS", "F5_SPREAD_PLUS", "F5_OVER", "F5_UNDER"];
const FIRST_HALF_PERIOD_CATEGORY_KEYS: PickCategoryKey[] = ["FIRST_HALF_ML", "FIRST_HALF_OVER", "FIRST_HALF_UNDER"];
const FIRST_HALF_CATEGORY_KEYS: PickCategoryKey[] = [...F5_INNINGS_CATEGORY_KEYS, ...FIRST_HALF_PERIOD_CATEGORY_KEYS];

// Reuses chipSetForLeague (stats.ts) - the same per-sport category mapping
// that already drives the Sharp Money page and capper detail tiles - as the
// single source of truth for which bet types are relevant to a sport, rather
// than a second, hand-maintained per-sport list. Spread/Moneyline/Total are
// unconditional since every chip set (MLB_CHIP_SET, NFL_CHIP_SET,
// DEFAULT_CHIP_SET, ...) includes their underlying FAV_ML/DOG_ML/
// SPREAD_MINUS/SPREAD_PLUS/OVER/UNDER categories.
function betTypeOptionsForSport(sportName: string | undefined): Set<BetTypeFilterKey> {
  const always: BetTypeFilterKey[] = ["SPREAD", "MONEYLINE", "TOTAL"];
  if (!sportName) return new Set(BET_TYPE_FILTER_OPTIONS.map((o) => o.value));

  const chipSet = chipSetForLeague(sportName);
  const has = (keys: PickCategoryKey[]) => keys.some((k) => chipSet.includes(k));

  const options = [...always];
  if (has(FIRST_HALF_CATEGORY_KEYS)) options.push("F5_SPREAD", "F5_MONEYLINE", "F5_TOTAL");
  if (chipSet.includes("TEAM_TOTAL")) options.push("TEAM_TOTAL");
  if (chipSet.includes("TD_PROP")) options.push("PLAYER_PROP");
  if (has(["NRFI", "YRFI"])) options.push("NRFI", "YRFI");
  return new Set(options);
}

// "F5" (baseball's first-5-innings term) is only correct for MLB - a
// football sport's first-half picks share the same F5_SPREAD/F5_MONEYLINE/
// F5_TOTAL filter KEYS (see betTypeFilterCategory below, which buckets any
// sport's period===FIRST_HALF pick the same way) but must never be LABELED
// "F5" anywhere on this page - the bet-type dropdown options below AND the
// per-row "FIRST_HALF" period badge (both the pick rows and the parlay leg
// rows) both call this, always passing a specific pick/leg's own real
// sport.name rather than the page's `sportId` filter, so a row's badge is
// always correct for that ROW's sport even when the sport filter itself is
// "All sports" and rows from multiple sports are mixed together on the page.
// The one caller that passes `undefined` (the dropdown, when no sportId
// filter is selected) keeps the original "F5" label there - that case isn't
// scoped to one sport's vocabulary, and every sport that actually has
// first-half data reaches this from MLB or NFL/NCAAF (never both at once),
// so there's no real ambiguity being papered over.
function firstHalfLabelPrefix(sportName: string | undefined): "F5" | "1H" {
  if (!sportName) return "F5";
  const chipSet = chipSetForLeague(sportName);
  return chipSet.some((k) => F5_INNINGS_CATEGORY_KEYS.includes(k)) ? "F5" : "1H";
}

// Short badge text for a pick's period, or null for a plain full-game pick.
// FIRST_HALF keeps the sport-aware F5/1H split; the rest are the standard
// quarter / hockey-period / 2nd-half shorthands.
const PERIOD_BADGE: Record<string, string> = {
  SECOND_HALF: "2H",
  FIRST_QUARTER: "Q1",
  SECOND_QUARTER: "Q2",
  THIRD_QUARTER: "Q3",
  FOURTH_QUARTER: "Q4",
  FIRST_PERIOD: "P1",
  SECOND_PERIOD: "P2",
  THIRD_PERIOD: "P3",
};
function periodBadgeLabel(period: string, sportName: string | undefined): string | null {
  if (period === "FIRST_HALF") return firstHalfLabelPrefix(sportName);
  return PERIOD_BADGE[period] ?? null;
}

const FIRST_HALF_BET_TYPE_KEYS: BetTypeFilterKey[] = ["F5_SPREAD", "F5_MONEYLINE", "F5_TOTAL"];

// Combines betTypeOptionsForSport (which options are relevant) with
// firstHalfLabelPrefix (what to call the first-half ones) into the final
// {value, label}[] a <select> renders for one sport - factored out since
// SportBetTypeFilter's live client-side update needs this computed for
// EVERY sport up front (see optionsBySportId below), not just whichever one
// happens to be selected server-side at render time.
function computeVisibleBetTypeOptions(sportName: string | undefined): { value: BetTypeFilterKey; label: string }[] {
  const relevant = betTypeOptionsForSport(sportName);
  const prefix = firstHalfLabelPrefix(sportName);
  return BET_TYPE_FILTER_OPTIONS.filter((o) => relevant.has(o.value)).map((o) =>
    FIRST_HALF_BET_TYPE_KEYS.includes(o.value) ? { ...o, label: o.label.replace(/^F5\b/, prefix) } : o
  );
}

// betTypeFilterCategory now lives in lib/bet-type-filter.ts, reused as-is by
// the capper comparison tool - see that file's own comment for why it's a
// deliberately different (coarser, cross-sport) classification than
// stats.ts's pickCategory.

// Resolves the page's three date searchParams (`date` for single-day mode,
// `startDate`/`endDate` for range mode) down to one definite Eastern-
// calendar-day range - defaulting to TODAY when none of the three are
// present, so a plain /picks load (including "Clear") always queries just
// today's picks rather than the entire history. Range mode wins whenever
// either range param is present (even alone - the missing side falls back to
// the one that IS given, so a single-sided link/bookmark still resolves to a
// real one-day range rather than an unbounded query), and a reversed
// start/end pair is swapped rather than silently returning zero rows.
function resolveDateFilter(searchParams: { date?: string; startDate?: string; endDate?: string }): {
  startDateKey: string;
  endDateKey: string;
  isRange: boolean;
} {
  const isRange = Boolean(searchParams.startDate || searchParams.endDate);
  if (!isRange) {
    const dateKey = searchParams.date || easternDateKey(new Date());
    return { startDateKey: dateKey, endDateKey: dateKey, isRange: false };
  }

  let startDateKey = searchParams.startDate || searchParams.endDate!;
  let endDateKey = searchParams.endDate || searchParams.startDate!;
  if (startDateKey > endDateKey) {
    [startDateKey, endDateKey] = [endDateKey, startDateKey];
  }
  return { startDateKey, endDateKey, isRange: true };
}

export default async function PicksPage({
  searchParams,
}: {
  searchParams: {
    capperId?: string;
    sportId?: string;
    status?: string;
    betType?: string;
    date?: string;
    startDate?: string;
    endDate?: string;
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

  const betTypeFilter = (searchParams.betType as BetTypeFilterKey) || undefined;
  const { startDateKey, endDateKey, isRange } = resolveDateFilter(searchParams);

  const filters = {
    capperId: searchParams.capperId || undefined,
    sportId: searchParams.sportId || undefined,
    status: (searchParams.status as PickStatus) || undefined,
    startDateKey,
    endDateKey,
  };

  const [allPicks, cappers, sports, planStatus, parlays] = await Promise.all([
    getFilteredPicksForUser(user.id, filters),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getPickPlanStatus(user.id),
    getParlaysForUser(user.id),
  ]);

  // Bet type is derived (betDetail text for NRFI/YRFI), not a stored column,
  // so it's filtered here rather than in the DB query.
  const picks = allPicks.filter((p) => !betTypeFilter || betTypeFilterCategory(p) === betTypeFilter);

  // Precomputed for every sport (plus "" for "All sports") so
  // SportBetTypeFilter can update the bet-type options live, client-side, as
  // soon as the sport selection changes - no full page reload required.
  const optionsBySportId: Record<string, { value: BetTypeFilterKey; label: string }[]> = {
    "": computeVisibleBetTypeOptions(undefined),
  };
  for (const s of sports) {
    optionsBySportId[s.id] = computeVisibleBetTypeOptions(s.name);
  }

  // Deliberately excludes startDateKey/endDateKey - those are always set
  // (defaulting to today), so including them here would make this true on
  // every load and permanently show "Clear"/the match-count line even with
  // no filter the user actually chose. `dateFilterActive` below tracks the
  // date scope separately, since it's "active" only once the user has
  // navigated away from the implicit today default.
  const otherFiltersActive =
    Boolean(filters.capperId) || Boolean(filters.sportId) || Boolean(filters.status) || Boolean(betTypeFilter);
  const dateFilterActive = Boolean(searchParams.date) || isRange;
  const hasActiveFilters = otherFiltersActive || dateFilterActive;

  const dateRangeLabel = isRange
    ? formatEastern(easternDayStart(startDateKey), { month: "short", day: "numeric" }) +
      " - " +
      formatEastern(easternDayStart(endDateKey), { month: "short", day: "numeric", year: "numeric" })
    : formatEastern(easternDayStart(startDateKey), { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Picks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {picks.length + " pick" + (picks.length === 1 ? "" : "s") + " - " + dateRangeLabel}
            {otherFiltersActive ? " (filtered)" : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {planStatus.unlimited
              ? TIER_LABELS[planStatus.tier] + " plan"
              : planStatus.pickCount + " of " + planStatus.pickLimit + " picks logged (Free plan)"}
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
        <DateRangeFilter
          initialDate={startDateKey}
          initialStartDate={startDateKey}
          initialEndDate={endDateKey}
          initialIsRange={isRange}
        />

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

        <SportBetTypeFilter
          sports={sports}
          optionsBySportId={optionsBySportId}
          initialSportId={filters.sportId ?? ""}
          initialBetType={betTypeFilter ?? ""}
        />

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
                    {periodBadgeLabel(pick.period, pick.sport.name) && (
                      <span className="ml-2 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:bg-purple-500/15 dark:text-purple-400">
                        {periodBadgeLabel(pick.period, pick.sport.name)}
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
                    {pick.capper.name} - {formatPickLabel(pick.betDetail, pick.betType, pick.line) ?? pick.betType} -{" "}
                    {pick.odds > 0 ? "+" : ""}
                    {pick.odds} - {pick.units}u
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <PickStatusButtons pickId={pick.id} status={pick.status} />
                  <RowDeleteButton onConfirm={deletePickAction.bind(null, pick.id)} itemLabel="pick" />
                </div>
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
                    <div className="flex items-center gap-2">
                      <span className={"text-sm font-medium " + statusColor}>{parlay.status}</span>
                      <RowDeleteButton onConfirm={deleteParlayAction.bind(null, parlay.id)} itemLabel="parlay" />
                    </div>
                  </div>
                  <div className="divide-y divide-border-subtle">
                    {parlay.legs.map((leg) => (
                      <div key={leg.id} className="flex items-center justify-between px-5 py-2.5">
                        <div>
                          <div className="text-xs font-medium text-foreground">
                            {leg.awayTeam} @ {leg.homeTeam}
                            {periodBadgeLabel(leg.period, leg.sport.name) && (
                              <span className="ml-2 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:bg-purple-500/15 dark:text-purple-400">
                                {periodBadgeLabel(leg.period, leg.sport.name)}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {formatPickLabel(leg.betDetail, leg.betType, leg.line) ?? leg.betType} -{" "}
                            {leg.odds > 0 ? "+" : ""}
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

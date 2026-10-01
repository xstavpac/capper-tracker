import { requireUser } from "@/server/auth";
import { getFilteredPicksForUser, getSportsWithLeagues } from "@/server/data/picks";
import {
  getPicksSummary,
  summarizeLoadedPicks,
  getCapperAllTimeRecords,
  getFinalScoresForPicks,
  getFeedStatusesForPicks,
} from "@/server/data/picks-summary";
import { getCappersForUser } from "@/server/data/cappers";
import { gradeUserPagePicks } from "@/server/data/page-grading";
import { getParlaysForUser } from "@/server/data/parlays";
import { LegStatusButtons } from "@/components/dashboard/leg-status-buttons";
import { RowDeleteButton } from "@/components/dashboard/row-delete-button";
import { deleteParlayAction } from "@/server/actions/parlays";
import { formatEastern, easternDateKey, easternDayStart } from "@/lib/dates";
import { chipSetForLeague, type PickCategoryKey } from "@/server/data/stats";
import { PicksFilterBar } from "@/components/picks/picks-filter-bar";
import { PickLedger, type LedgerRow } from "@/components/picks/pick-ledger";
import { PicksSummaryStrip, TopColdestStrip } from "@/components/picks/picks-summary-strip";
import { DateNavigator } from "@/components/picks/date-navigator";
import { cumulativeUnitsSeries, sportChipLayout, topAndColdest, type HeaderPick } from "@/lib/picks-header";
import {
  betTypeFilterCategory,
  firstHalfLabelPrefixForChipSet,
  visibleBetTypeOptionsForChipSet,
  type BetTypeFilterKey,
} from "@/lib/bet-type-filter";
import {
  buildPickLabel,
  marketTag,
  splitIntoSections,
  pickPhase,
  consensusHints,
  capperInitials,
  formatOdds,
  winUnits,
  type LedgerPickInput,
  type PickPhase,
} from "@/lib/pick-display";
import { formatPickLabel } from "@/lib/bet-line";
import type { PickStatus } from "@prisma/client";
import { ImageBanner } from "@/components/ui/ImageBanner";
import picksBanner from "../../../../public/banners/picks.png";

// betTypeOptionsForChipSet/firstHalfLabelPrefixForChipSet/
// visibleBetTypeOptionsForChipSet now live in lib/bet-type-filter.ts (moved
// there so the sport-gating decision - not just the pick classification - is
// covered by a real, executable test; that file can't call chipSetForLeague
// itself and stay client-safe, so it takes an already-resolved chip set
// instead of a sportName). The two thin wrappers below just do that
// resolution. `undefined` (no sportId filter selected) resolves to `null` -
// every option is relevant then, and the first-half label stays "F5".
function chipSetForSport(sportName: string | undefined): PickCategoryKey[] | null {
  return sportName ? chipSetForLeague(sportName) : null;
}

function firstHalfLabelPrefix(sportName: string | undefined): "F5" | "1H" {
  return firstHalfLabelPrefixForChipSet(chipSetForSport(sportName));
}

// Short badge text for a leg's period (parlay legs below still use this), or
// null for a plain full-game pick. FIRST_HALF keeps the sport-aware F5/1H
// split; the rest are the standard quarter / hockey-period / 2nd-half
// shorthands.
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

// Thin resolution wrapper - the filter bar's live client-side update needs
// this computed for EVERY sport up front (see optionsBySportId below), not
// just whichever one happens to be selected server-side at render time.
function computeVisibleBetTypeOptions(sportName: string | undefined): { value: BetTypeFilterKey; label: string }[] {
  return visibleBetTypeOptionsForChipSet(chipSetForSport(sportName));
}

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

function fmtUnits(n: number): string {
  return String(Math.round(n * 100) / 100);
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

  // Grades this user's due pending picks before render - only sports where they
  // have one, with the score persist throttled fleet-wide (see page-grading.ts).
  await gradeUserPagePicks(user.id);

  const betTypeFilter = (searchParams.betType as BetTypeFilterKey) || undefined;
  const { startDateKey, endDateKey, isRange } = resolveDateFilter(searchParams);

  const sportIdFilter = searchParams.sportId || undefined;
  const filters = {
    capperId: searchParams.capperId || undefined,
    sportId: sportIdFilter,
    status: (searchParams.status as PickStatus) || undefined,
    startDateKey,
    endDateKey,
  };

  const [allPicks, cappers, sports, parlays, sqlSummary] = await Promise.all([
    // The sport chip is applied in JS below (not in this query) so the sport
    // chips' counts can reflect every sport under the other active filters.
    getFilteredPicksForUser(user.id, { ...filters, sportId: undefined }),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getParlaysForUser(user.id, {
      capperId: filters.capperId,
      startDateKey: filters.startDateKey,
      endDateKey: filters.endDateKey,
    }),
    // Bet type is derived in JS, so with that chip on the summary is computed
    // from the already-loaded rows instead (see summarizeLoadedPicks).
    betTypeFilter ? Promise.resolve(null) : getPicksSummary(user.id, filters),
  ]);

  // Bet type is derived (betDetail text for NRFI/YRFI), not a stored column,
  // so it's filtered here rather than in the DB query.
  const sportScopedPicks = allPicks.filter((p) => !betTypeFilter || betTypeFilterCategory(p) === betTypeFilter);
  const picks = sportIdFilter ? sportScopedPicks.filter((p) => p.sportId === sportIdFilter) : sportScopedPicks;
  const summary = sqlSummary ?? summarizeLoadedPicks(picks);

  const now = new Date();
  const loadedCapperIds = Array.from(new Set(picks.map((p) => p.capperId)));
  const [capperRecords, finalScores] = await Promise.all([
    getCapperAllTimeRecords(user.id, loadedCapperIds),
    getFinalScoresForPicks(
      picks.map((p) => ({
        id: p.id,
        sportName: p.sport.name,
        status: p.status,
        gameTime: p.gameTime,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        betDetail: p.betDetail,
        gameNumber: p.gameNumber,
      })),
      now
    ),
  ]);

  // Live status only for started, ungraded picks with no final result yet.
  const feedStatuses = await getFeedStatusesForPicks(
    picks
      .filter((p) => p.status === "PENDING" && !finalScores.has(p.id))
      .map((p) => ({ id: p.id, sportName: p.sport.name, homeTeam: p.homeTeam, awayTeam: p.awayTeam, gameTime: p.gameTime })),
    now
  );

  // Precomputed for every sport (plus "" for "All sports") so the filter bar
  // can update the bet-type options live, client-side, as soon as the sport
  // selection changes - no full page reload required.
  const optionsBySportId: Record<string, { value: BetTypeFilterKey; label: string }[]> = {
    "": computeVisibleBetTypeOptions(undefined),
  };
  for (const s of sports) {
    optionsBySportId[s.id] = computeVisibleBetTypeOptions(s.name);
  }

  const sportChips = sportChipLayout(
    sportScopedPicks.map((p) => ({ sportId: p.sportId, sportName: p.sport.name })),
    sportIdFilter ?? null
  );
  const headerPicks: HeaderPick[] = picks.map((p) => ({
    capperId: p.capperId,
    capperName: p.capper.name,
    sportId: p.sportId,
    sportName: p.sport.name,
    status: p.status,
    units: p.units,
    odds: p.odds,
    gameTime: p.gameTime,
    gradedAt: p.gradedAt,
  }));
  const otherFiltersActive =
    Boolean(filters.capperId) || Boolean(filters.sportId) || Boolean(filters.status) || Boolean(betTypeFilter);
  const dateFilterActive = Boolean(searchParams.date) || isRange;
  const hasActiveFilters = otherFiltersActive || dateFilterActive;

  const todayKey = easternDateKey(now);
  const dayFmt = (key: string, opts: Intl.DateTimeFormatOptions) => formatEastern(easternDayStart(key), opts);

  const subtitleDate = isRange
    ? dayFmt(startDateKey, { month: "short", day: "numeric" }) +
      " - " +
      dayFmt(endDateKey, { month: "short", day: "numeric", year: "numeric" })
    : dayFmt(startDateKey, { weekday: "long", month: "short", day: "numeric" });

  const dateChipLabel = isRange
    ? dayFmt(startDateKey, { month: "short", day: "numeric" }) + " - " + dayFmt(endDateKey, { month: "short", day: "numeric" })
    : startDateKey === todayKey
      ? "Today"
      : dayFmt(startDateKey, { month: "short", day: "numeric" });
  // "Default" means the chip reads Today with nothing to clear.
  const dateIsDefault = !isRange && startDateKey === todayKey;

  const ledgerPicks: (LedgerPickInput & { source: (typeof picks)[number]; phase: PickPhase })[] = picks.map((p) => ({
    id: p.id,
    capperId: p.capperId,
    sportName: p.sport.name,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    betType: p.betType,
    betDetail: p.betDetail,
    line: p.line,
    period: p.period,
    pickedSide: p.pickedSide,
    odds: p.odds,
    status: p.status,
    gameTime: p.gameTime,
    phase: pickPhase({
      status: p.status,
      gameTime: p.gameTime,
      now,
      hasFinalResult: finalScores.has(p.id),
      feedStatus: feedStatuses.get(p.id)?.status ?? null,
    }),
    source: p,
  }));
  const hints = consensusHints(ledgerPicks);
  const livePicks = ledgerPicks.filter((p) => p.phase === "live").length;
  const laterPicks = ledgerPicks.filter((p) => p.phase === "pending").length;
  const topCold = topAndColdest(headerPicks, Boolean(filters.capperId));

  const sections = splitIntoSections(ledgerPicks).map((section) => ({
    key: section.key,
    rows: section.picks.map((lp): LedgerRow => {
      const p = lp.source;
      const rec = capperRecords.get(p.capperId);
      const score = finalScores.get(p.id);
      const liveScore = feedStatuses.get(p.id)?.score ?? null;
      const decidedUnits =
        p.status === "WIN"
          ? "+" + fmtUnits(winUnits(p.units, p.odds)) + "u"
          : p.status === "LOSS"
            ? "-" + fmtUnits(p.units) + "u"
            : null;
      return {
        id: p.id,
        sportName: p.sport.name,
        gameTimeIso: p.gameTime.toISOString(),
        label: buildPickLabel(lp),
        tag: marketTag({ betType: p.betType, period: p.period, sportName: p.sport.name, betDetail: p.betDetail }),
        capperName: p.capper.name,
        capperInitials: capperInitials(p.capper.name),
        capperRecord: rec ? rec.wins + "-" + rec.losses : null,
        matchup: score
          ? p.awayTeam + " " + score.away + " @ " + p.homeTeam + " " + score.home + " (Final)"
          : p.awayTeam + " @ " + p.homeTeam,
        oddsText: formatOdds(p.odds),
        unitsText: fmtUnits(p.units) + "u",
        phase: lp.phase,
        currentStatus: p.status,
        liveScore: liveScore ? liveScore.away + "-" + liveScore.home : null,
        resultUnitsText: decidedUnits,
        consensus: hints.get(p.id) ?? null,
      };
    }),
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <ImageBanner src={picksBanner} title="Picks" priority />
      <div className="mb-5">
        <DateNavigator
          dateKey={startDateKey}
          label={subtitleDate}
          isRange={isRange}
          countText={picks.length + " pick" + (picks.length === 1 ? "" : "s")}
        />
      </div>

      <PicksSummaryStrip
        summary={summary}
        series={cumulativeUnitsSeries(headerPicks)}
        live={livePicks}
        later={laterPicks}
      />
      {topCold && (
        <TopColdestStrip
          top={topCold.top}
          coldest={topCold.coldest}
          topLabel={!isRange && startDateKey === todayKey ? "Top today" : "Top"}
        />
      )}

      <PicksFilterBar
        cappers={cappers.map((c) => ({ value: c.id, label: c.name }))}
        sportChips={sportChips}
        betTypeOptionsBySportId={optionsBySportId}
        todayKey={todayKey}
        dateLabel={dateChipLabel}
        dateIsDefault={dateIsDefault}
        dateStart={startDateKey}
        dateEnd={endDateKey}
        isRange={isRange}
      />

      {picks.length === 0 ? (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters
              ? "No picks match these filters."
              : "No picks for this day yet."}
          </p>
        </div>
      ) : (
        <PickLedger sections={sections} showDate={isRange} />
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

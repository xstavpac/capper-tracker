// Zone Model: an admin-only bucketed delta calibration tool, across seven
// independent dimensions - none blended into a combined score. Every
// dimension is computed by reusing an already-tracked BettingView data
// source, applied to each team's history AS IT STOOD ON THAT GAME'S OWN
// DATE (point-in-time - see dayBefore() below):
//
//   ML Delta         = favorite's history win% AS a favorite
//                       - underdog's history win% AS an underdog
//   Total Delta      = this matchup's combined history over-rate
//                       - combined history under-rate
//   Run Diff Delta   = home team's season run differential (as of that date)
//                       - away team's
//   ERA Delta        = away team's season ERA (as of that date) - home team's
//                       (sign-flipped: lower ERA is better, so positive still
//                       means the HOME team has the edge)
//   WHIP Delta       = away team's season WHIP - home team's (same sign-flip)
//   OPS Delta        = home team's season OPS - away team's
//   Batting Avg Delta = home team's season batting average - away team's
//
// ML/Total reuse team-tendencies.ts's computeTendencyRates directly (not
// reimplemented) against TeamTendencySnapshot. The five team-stat dimensions
// reuse the raw fields already captured on TeamStatSnapshot
// (stat-snapshots.ts's captureTeamStatSnapshots) - same daily-snapshot
// shape, same point-in-time mechanism, no separate calculation invented.
//
// Point-in-time, not current/cumulative: every dimension reads its snapshot
// table via findLatestAtOrBefore, the exact same "as of" mechanism
// resolver.ts's resolveTeamTendency/resolveTeamStat and Charts'
// historical-variables.ts already use for these tables - not a new lookup
// convention. `asOf` is pinned to the instant just before the game's own
// Eastern calendar day starts (dayBefore()), so the snapshot used is
// strictly BEFORE that day - the game's own result (and anything else from
// that same day) can never leak into the rate used to bucket it. A game
// with no snapshot yet as of its date (the team's history hadn't started
// accumulating, or snapshotting itself hadn't started yet) is skipped
// entirely for that dimension, never defaulted to any rate. This was a real
// bug once (see git history on this file) - every dimension added here
// follows the same discipline from the start.
//
// Consequence worth knowing: TeamTendencySnapshot only exists from
// 2026-08-10 onward and TeamStatSnapshot has its own (possibly different)
// start date - any game before a dimension's own snapshot history began has
// no prior-day snapshot to look up and is excluded from that dimension.
//
// Each game is bucketed TWICE per dimension - once from each side's point of
// view. The two sides are Favorite/Underdog (ML), Over/Under (Total), or
// Home/Away (the five team-stat dimensions). Side A's signed delta picks its
// bucket and side A's own W/L is recorded there; side B's delta is side A's
// negated, so side B lands in the mirror bucket with side B's own W/L. Every
// bucket therefore carries TWO independent records (sideA, sideB), each built
// from a DIFFERENT set of games - neither is ever inverted to imply the
// other. That is what lets a negative-delta bucket show the underdog's real
// record in that zone rather than the favorite's record relabelled.
//
// Buckets are reported independently: a record is never averaged, smoothed,
// or blended with a neighbor; there is no minimum-sample floor (a 1-0 shows
// as 1-0); and a bucket with zero games on BOTH sides is still returned (not
// dropped) so the caller can render an explicit empty state. No dimension's
// numbers are ever blended into any other dimension's.
//
// Bucket SCALE differs by dimension on purpose: ML/Total deltas are
// percentage points (0-100 scale, reusing decay-delta.ts's proven 10-tier
// scheme verbatim - see ZONE_MODEL_BUCKETS/bucketForDelta, both untouched
// by this file's later additions). The five team-stat dimensions are NOT
// rates - reusing that same 0-100-point scale for e.g. an ERA delta
// (typically 0.00-2.50) would dump nearly every game into a single tier.
// Each stat dimension instead gets its own tier width, chosen from typical
// MLB team-to-team spread for that stat (see STAT_METRICS), through the
// SAME 10-tier symmetric shape and the SAME boundary-ownership convention
// (near-zero edge inclusive, far-from-zero edge exclusive, 0 itself
// tie-broken to the non-negative tier) - see buildMetricBuckets.
import { prisma } from "@/lib/prisma";
import { computeTendencyRates, moneylinePrice, totalLine as totalLineOf } from "@/server/data/team-tendencies";
import { actualFavWon } from "@/server/data/model-engine/decay-delta-outcome";
import { deriveWentOver } from "@/server/data/model-engine/decay-delta-predictions";
import { findLatestAtOrBefore, dayBefore } from "@/server/data/providers/snapshot-utils";
import type { OddsGame } from "@/server/data/odds";

// ---------------------------------------------------------------------------
// Shared bucket/result shapes
// ---------------------------------------------------------------------------

export type BucketDescriptor = { id: string; label: string };

// One side's real W-L within one bucket. winPct is null (never 0) when that
// side has no games in the bucket, so the caller can tell "0% record" apart
// from "no games".
export type ZoneSideRecord = {
  games: number;
  wins: number;
  losses: number;
  winPct: number | null;
};

// A bucket holds two of these. Each graded game is bucketed once per side
// (by that side's own signed delta), so sideA and sideB cover different sets
// of games and can diverge freely - e.g. sideA 1-0 while sideB 3-2 in the
// same bucket. sideALabel / sideBLabel on the dimension name the two sides.
export type ZoneModelBucketResult = {
  bucket: BucketDescriptor;
  sideA: ZoneSideRecord;
  sideB: ZoneSideRecord;
};

export type ZoneDimensionKey = "ml" | "total" | "run_diff" | "era" | "whip" | "ops" | "batting_avg";

export type ZoneModelDimensionReport = {
  key: ZoneDimensionKey;
  label: string;
  description: string;
  sideALabel: string;
  sideBLabel: string;
  buckets: ZoneModelBucketResult[];
  gamesConsidered: number;
};

export type ZoneModelReport = {
  sportKey: string;
  dimensions: ZoneModelDimensionReport[];
};

// ---------------------------------------------------------------------------
// ML Delta / Total Delta - unchanged from the original implementation
// ---------------------------------------------------------------------------

export type ZoneModelBucket = {
  id: string;
  label: string;
  // Both inclusive; null means unbounded in that direction. A delta d
  // belongs to this bucket iff (min === null || d >= min) && (max === null
  // || d <= max).
  min: number | null;
  max: number | null;
};

// Ten decade-wide, percentage-point tiers - same boundary scheme
// decay-delta.ts's bucket_decay_delta already established and proved
// exhaustive/non-overlapping (see decay-delta-bucket-boundary-test.ts):
// lower-inclusive/upper-exclusive throughout (expressed here as an
// inclusive [min, max] with max shifted in by 1), except delta === 0 is
// assigned to "0 to 10" by convention rather than "0 to -10". Reusing this
// exact scheme (not inventing a new one) for the same reason
// computeTendencyRates itself is reused - it's already a proven, tested
// convention in this codebase.
export const ZONE_MODEL_BUCKETS: ZoneModelBucket[] = [
  { id: "ge_40", label: "40+", min: 40, max: null },
  { id: "30_to_40", label: "30 to 40", min: 30, max: 39 },
  { id: "20_to_30", label: "20 to 30", min: 20, max: 29 },
  { id: "10_to_20", label: "10 to 20", min: 10, max: 19 },
  { id: "0_to_10", label: "0 to 10", min: 0, max: 9 },
  { id: "0_to_neg10", label: "0 to -10", min: -9, max: -1 },
  { id: "neg10_to_neg20", label: "-10 to -20", min: -19, max: -10 },
  { id: "neg20_to_neg30", label: "-20 to -30", min: -29, max: -20 },
  { id: "neg30_to_neg40", label: "-30 to -40", min: -39, max: -30 },
  { id: "le_neg40", label: "-40 or less", min: null, max: -40 },
];

// The ten buckets above are exhaustive over the integers (proven by
// decay-delta-bucket-boundary-test.ts's equivalent scheme) - every delta
// matches exactly one. `delta` here is always an integer: both rates are
// rounded to a whole percent BEFORE subtracting (see pct() below), matching
// decay-delta.ts's own round-before-subtract convention so this scheme's
// half-open-via-integer-offset boundaries are well-defined.
export function bucketForDelta(delta: number): ZoneModelBucket {
  for (const bucket of ZONE_MODEL_BUCKETS) {
    const aboveMin = bucket.min === null || delta >= bucket.min;
    const belowMax = bucket.max === null || delta <= bucket.max;
    if (aboveMin && belowMax) return bucket;
  }
  // Unreachable: min=40/max=null and min=null/max=-40 cover everything
  // outside the eight closed buckets in between, which themselves tile
  // [-39, 39] with no gap.
  throw new Error(`Zone Model: delta ${delta} matched no bucket - this should be impossible`);
}

type TendencyCounts = {
  favWins: number;
  favLosses: number;
  favPushes: number;
  dogWins: number;
  dogLosses: number;
  dogPushes: number;
  overCount: number;
  underCount: number;
  totalPushCount: number;
};

// The subset of TeamTendencySnapshot findLatestAtOrBefore needs (a
// snapshotDate string) plus the raw counts computeTendencyRates itself
// needs - matches what `prisma.teamTendencySnapshot.findMany` returns.
type TendencySnapshotRow = TendencyCounts & { teamName: string; snapshotDate: string };

// Combines two teams' raw totals-side counts into one synthetic matchup
// counts row, so their COMBINED over/under history can be run back through
// computeTendencyRates for a single per-game rate - summing raw counts
// first, then computing the rate once, never averaging two already-computed
// percentages. fav/dog fields are zeroed: combining two different teams'
// favorite-role and underdog-role counts has no coherent meaning for a
// totals-side number, and this combined row's favWinPct/dogWinPct output is
// never read.
function combinedTotalsCounts(a: TendencyCounts, b: TendencyCounts): TendencyCounts {
  return {
    favWins: 0,
    favLosses: 0,
    favPushes: 0,
    dogWins: 0,
    dogLosses: 0,
    dogPushes: 0,
    overCount: a.overCount + b.overCount,
    underCount: a.underCount + b.underCount,
    totalPushCount: a.totalPushCount + b.totalPushCount,
  };
}

// round(rate * 100) on EACH side before subtracting - matches
// decay-delta.ts's calc_fav_pct/calc_dog_pct convention exactly (see that
// fixture's own comment), which is what keeps this bucket scheme's
// integer-boundary math well-defined.
function pct(rate: number): number {
  return Math.round(rate * 100);
}

// ---------------------------------------------------------------------------
// The five team-stat dimensions (Run Diff, ERA, WHIP, OPS, Batting Avg)
// ---------------------------------------------------------------------------

export type MetricBucket = {
  id: string;
  label: string;
  min: number | null;
  minInclusive: boolean;
  max: number | null;
  maxInclusive: boolean;
};

// Neither tier boundaries (k * tierWidth, e.g. 3 * 0.05) nor a subtracted
// delta (e.g. 1.25 - 1.10) land on an exact binary double for a decimal
// tier width - both can come out a hair off the "true" decimal value
// (0.14999999999999997 instead of 0.15), which silently pushed boundary-
// exact values into the wrong bucket before this existed (caught by
// zone-model-acceptance-test.ts's boundary-exact fixture values). Rounding
// every value that reaches bucket matching or display to the SAME decimal
// precision (via toFixed, not a manual multiply/round) forces both sides
// of a real boundary onto the identical double, so an exact match compares
// exactly again.
function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function matchesMetricBucket(value: number, bucket: MetricBucket): boolean {
  const aboveMin = bucket.min === null || (bucket.minInclusive ? value >= bucket.min : value > bucket.min);
  const belowMax = bucket.max === null || (bucket.maxInclusive ? value <= bucket.max : value < bucket.max);
  return aboveMin && belowMax;
}

export function bucketForMetricValue(value: number, buckets: MetricBucket[]): MetricBucket {
  const found = buckets.find((b) => matchesMetricBucket(value, b));
  if (!found) throw new Error(`Zone Model: value ${value} matched no metric bucket - this should be impossible`);
  return found;
}

// Baseball convention: OPS/batting average drop the leading zero (".750",
// not "0.750"). Applied consistently to both bucket labels and per-game
// display values so a tile's range and a game's own delta always read the
// same way.
function formatMetricValue(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return fixed.replace(/^(-?)0\./, "$1.");
}

// Ten tiers at multiples of `tierWidth`, mirroring ZONE_MODEL_BUCKETS'
// exact boundary-ownership convention (near-zero edge inclusive, far-from-
// zero edge exclusive, 0 itself tie-broken to the non-negative tier) but
// expressed with explicit inclusive/exclusive flags instead of the integer
// -1 offset trick ZONE_MODEL_BUCKETS uses - that trick exists only because
// decay-delta's shared model-engine range primitive has no exclusive-bound
// concept; these tiers aren't constrained by that primitive, so they use
// real (non-integer) boundaries directly. Verified equivalent to
// ZONE_MODEL_BUCKETS' own ownership rule in zone-model-acceptance-test.ts.
function buildMetricBuckets(tierWidth: number, decimals: number): MetricBucket[] {
  // Rounded once here (see roundTo's own comment) - every boundary below is
  // built from these, not raw `k * tierWidth` multiplication.
  const w1 = roundTo(1 * tierWidth, decimals);
  const w2 = roundTo(2 * tierWidth, decimals);
  const w3 = roundTo(3 * tierWidth, decimals);
  const w4 = roundTo(4 * tierWidth, decimals);
  const label = (n: number) => formatMetricValue(n, decimals);
  return [
    { id: "ge_4w", label: `${label(w4)}+`, min: w4, minInclusive: true, max: null, maxInclusive: false },
    { id: "3w_4w", label: `${label(w3)} to ${label(w4)}`, min: w3, minInclusive: true, max: w4, maxInclusive: false },
    { id: "2w_3w", label: `${label(w2)} to ${label(w3)}`, min: w2, minInclusive: true, max: w3, maxInclusive: false },
    { id: "1w_2w", label: `${label(w1)} to ${label(w2)}`, min: w1, minInclusive: true, max: w2, maxInclusive: false },
    { id: "0_1w", label: `0 to ${label(w1)}`, min: 0, minInclusive: true, max: w1, maxInclusive: false },
    { id: "0_neg1w", label: `0 to -${label(w1)}`, min: -w1, minInclusive: false, max: 0, maxInclusive: false },
    { id: "neg1w_neg2w", label: `-${label(w1)} to -${label(w2)}`, min: -w2, minInclusive: false, max: -w1, maxInclusive: true },
    { id: "neg2w_neg3w", label: `-${label(w2)} to -${label(w3)}`, min: -w3, minInclusive: false, max: -w2, maxInclusive: true },
    { id: "neg3w_neg4w", label: `-${label(w3)} to -${label(w4)}`, min: -w4, minInclusive: false, max: -w3, maxInclusive: true },
    { id: "le_neg4w", label: `-${label(w4)} or less`, min: null, minInclusive: false, max: -w4, maxInclusive: true },
  ];
}

type TeamStatRow = {
  teamName: string;
  snapshotDate: string;
  era: number;
  whip: number;
  runDifferential: number;
  ops: number;
  battingAvg: number;
};

type StatMetricConfig = {
  key: Exclude<ZoneDimensionKey, "ml" | "total">;
  label: string;
  description: string;
  qualifierLabel: string; // e.g. "ERA Edge" - the click-through parenthetical
  tierWidth: number;
  decimals: number;
  higherIsBetter: boolean;
  extractValue: (row: TeamStatRow) => number;
  buckets: MetricBucket[];
};

// Tier widths chosen from typical MLB team-to-team spread for each stat, so
// the ten tiers actually spread games out rather than collapsing almost
// everything into tier 1 (which reusing the percentage-point scale would
// do - none of these are 0-100 rates). Flagged in the PR for a look at the
// real distribution once there's enough graded-game history to judge it.
const STAT_METRICS: StatMetricConfig[] = [
  {
    key: "run_diff",
    label: "Run Differential Delta",
    description: "How much better a team's season run differential was than its opponent's, as of the day before the game. Home and away are each bucketed by their own edge; both records are shown.",
    qualifierLabel: "Run Diff Edge",
    tierWidth: 10,
    decimals: 0,
    higherIsBetter: true,
    extractValue: (r) => r.runDifferential,
    buckets: buildMetricBuckets(10, 0),
  },
  {
    key: "era",
    label: "ERA Delta",
    description: "How much better a team's season ERA was than its opponent's (lower ERA is better), as of the day before the game. Home and away are each bucketed by their own edge; both records are shown.",
    qualifierLabel: "ERA Edge",
    tierWidth: 0.25,
    decimals: 2,
    higherIsBetter: false,
    extractValue: (r) => r.era,
    buckets: buildMetricBuckets(0.25, 2),
  },
  {
    key: "whip",
    label: "WHIP Delta",
    description: "How much better a team's season WHIP was than its opponent's (lower WHIP is better), as of the day before the game. Home and away are each bucketed by their own edge; both records are shown.",
    qualifierLabel: "WHIP Edge",
    tierWidth: 0.05,
    decimals: 2,
    higherIsBetter: false,
    extractValue: (r) => r.whip,
    buckets: buildMetricBuckets(0.05, 2),
  },
  {
    key: "ops",
    label: "OPS Delta",
    description: "How much better a team's season OPS was than its opponent's, as of the day before the game. Home and away are each bucketed by their own edge; both records are shown.",
    qualifierLabel: "OPS Edge",
    tierWidth: 0.02,
    decimals: 3,
    higherIsBetter: true,
    extractValue: (r) => r.ops,
    buckets: buildMetricBuckets(0.02, 3),
  },
  {
    key: "batting_avg",
    label: "Batting Average Delta",
    description: "How much better a team's season batting average was than its opponent's, as of the day before the game. Home and away are each bucketed by their own edge; both records are shown.",
    qualifierLabel: "AVG Edge",
    tierWidth: 0.01,
    decimals: 3,
    higherIsBetter: true,
    extractValue: (r) => r.battingAvg,
    buckets: buildMetricBuckets(0.01, 3),
  },
];

// Positive means "home team has the edge" for every stat, regardless of
// whether a higher or lower raw value is better - ERA/WHIP are sign-flipped
// here so every dimension shares the same "positive = home" convention the
// bucket tie-break (0 goes to the non-negative tier) already assumes.
function statDelta(metric: StatMetricConfig, homeRow: TeamStatRow, awayRow: TeamStatRow): number {
  const home = metric.extractValue(homeRow);
  const away = metric.extractValue(awayRow);
  const raw = metric.higherIsBetter ? home - away : away - home;
  return roundTo(raw, metric.decimals);
}

// ---------------------------------------------------------------------------
// Historical calibration (point-in-time)
// ---------------------------------------------------------------------------

type SideCount = { games: number; wins: number; losses: number };
type BucketCount = { a: SideCount; b: SideCount };

function emptyBucketCounts(bucketIds: string[]): Map<string, BucketCount> {
  const map = new Map<string, BucketCount>();
  for (const id of bucketIds) {
    map.set(id, { a: { games: 0, wins: 0, losses: 0 }, b: { games: 0, wins: 0, losses: 0 } });
  }
  return map;
}

// Record one side of one game. `bucketId` is the bucket THAT side's own
// signed delta falls in (side-B callers pass the negated delta's bucket),
// and `won` is that side's own outcome. Called once per side per game, so a
// bucket's a/b tallies are always independent game sets.
function recordSide(counts: Map<string, BucketCount>, bucketId: string, side: "a" | "b", won: boolean) {
  const entry = counts.get(bucketId)![side];
  entry.games++;
  if (won) entry.wins++;
  else entry.losses++;
}

function toSideRecord(c: SideCount): ZoneSideRecord {
  return {
    games: c.games,
    wins: c.wins,
    losses: c.losses,
    winPct: c.games > 0 ? (c.wins / c.games) * 100 : null,
  };
}

function finalizeDimension(
  key: ZoneDimensionKey,
  label: string,
  description: string,
  sideALabel: string,
  sideBLabel: string,
  bucketDescriptors: BucketDescriptor[],
  counts: Map<string, BucketCount>,
  gamesConsidered: number
): ZoneModelDimensionReport {
  return {
    key,
    label,
    description,
    sideALabel,
    sideBLabel,
    gamesConsidered,
    buckets: bucketDescriptors.map((bucket) => {
      const c = counts.get(bucket.id)!;
      return { bucket, sideA: toSideRecord(c.a), sideB: toSideRecord(c.b) };
    }),
  };
}

// Computes all seven bucket reports fresh from GameResult + the relevant
// snapshot tables on every call - no separate stored/frozen table, so every
// dimension improves automatically as more games grade and more daily
// snapshots accumulate.
export async function computeZoneModel(sportKey: string): Promise<ZoneModelReport> {
  const [games, tendencySnapshotRows, statSnapshotRows] = await Promise.all([
    // No favTeam/totalLine filter here (unlike the original ML/Total-only
    // version): the five team-stat dimensions need only a decided score and
    // both teams' point-in-time stat history, independent of odds data
    // availability. Each dimension below applies its own precondition.
    prisma.gameResult.findMany({
      where: { sportKey },
      select: { id: true, homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, favTeam: true, totalLine: true, gameDate: true },
    }),
    prisma.teamTendencySnapshot.findMany({ where: { sportKey }, orderBy: { snapshotDate: "asc" } }) as Promise<TendencySnapshotRow[]>,
    prisma.teamStatSnapshot.findMany({ where: { sportKey }, orderBy: { snapshotDate: "asc" } }) as Promise<TeamStatRow[]>,
  ]);

  const tendencyByTeam = new Map<string, TendencySnapshotRow[]>();
  for (const row of tendencySnapshotRows) {
    let list = tendencyByTeam.get(row.teamName);
    if (!list) { list = []; tendencyByTeam.set(row.teamName, list); }
    list.push(row);
  }
  const statByTeam = new Map<string, TeamStatRow[]>();
  for (const row of statSnapshotRows) {
    let list = statByTeam.get(row.teamName);
    if (!list) { list = []; statByTeam.set(row.teamName, list); }
    list.push(row);
  }
  const tendencyAsOf = (teamName: string, asOf: Date) => findLatestAtOrBefore(tendencyByTeam.get(teamName) ?? [], asOf);
  const statAsOf = (teamName: string, asOf: Date) => findLatestAtOrBefore(statByTeam.get(teamName) ?? [], asOf);

  const mlCounts = emptyBucketCounts(ZONE_MODEL_BUCKETS.map((b) => b.id));
  const totalCounts = emptyBucketCounts(ZONE_MODEL_BUCKETS.map((b) => b.id));
  let mlGames = 0;
  let totalGames = 0;

  const statCounts = new Map(STAT_METRICS.map((m) => [m.key, emptyBucketCounts(m.buckets.map((b) => b.id))]));
  const statGamesConsidered = new Map(STAT_METRICS.map((m) => [m.key, 0]));

  for (const game of games) {
    const asOf = dayBefore(game.gameDate);

    if (game.favTeam !== null) {
      const dogTeam = game.favTeam === game.homeTeam ? game.awayTeam : game.homeTeam;
      const favRow = tendencyAsOf(game.favTeam, asOf);
      const dogRow = tendencyAsOf(dogTeam, asOf);
      const favWon = actualFavWon({
        id: game.id, favTeam: game.favTeam, homeTeam: game.homeTeam, awayTeam: game.awayTeam,
        homeScore: game.homeScore, awayScore: game.awayScore, gameDate: game.gameDate,
      });

      if (favRow && dogRow && favWon !== null) {
        const favWinPct = computeTendencyRates(favRow).favWinPct;
        const dogWinPct = computeTendencyRates(dogRow).dogWinPct;
        if (favWinPct !== null && dogWinPct !== null) {
          // The favorite's delta is its fav-role win% minus the dog's
          // dog-role win%; the underdog's own delta is exactly the negation.
          // The ML outcome is complementary (favWon <=> the dog lost), so
          // each side's real W/L lands in its own bucket.
          const favDelta = pct(favWinPct) - pct(dogWinPct);
          recordSide(mlCounts, bucketForDelta(favDelta).id, "a", favWon);
          recordSide(mlCounts, bucketForDelta(-favDelta).id, "b", !favWon);
          mlGames++;
        }
      }
    }

    if (game.totalLine !== null) {
      const homeRow = tendencyAsOf(game.homeTeam, asOf);
      const awayRow = tendencyAsOf(game.awayTeam, asOf);
      const wentOver = deriveWentOver({ homeScore: game.homeScore, awayScore: game.awayScore, totalLine: game.totalLine });

      if (homeRow && awayRow && wentOver !== null) {
        const combinedRates = computeTendencyRates(combinedTotalsCounts(homeRow, awayRow));
        if (combinedRates.overRate !== null && combinedRates.underRate !== null) {
          // Same two-sided treatment: the over's delta is over-rate minus
          // under-rate, the under's is the negation, and the outcome is
          // complementary (wentOver <=> the under lost).
          const overDelta = pct(combinedRates.overRate) - pct(combinedRates.underRate);
          recordSide(totalCounts, bucketForDelta(overDelta).id, "a", wentOver);
          recordSide(totalCounts, bucketForDelta(-overDelta).id, "b", !wentOver);
          totalGames++;
        }
      }
    }

    // The five team-stat dimensions share one precondition: a decided score
    // (no tie - MLB has none in practice, but guarded the same way
    // actualFavWon guards ties elsewhere) and both teams having a
    // point-in-time stat row as of the day before this game.
    if (game.homeScore === game.awayScore) continue;
    const homeWon = game.homeScore > game.awayScore;
    const homeStatRow = statAsOf(game.homeTeam, asOf);
    const awayStatRow = statAsOf(game.awayTeam, asOf);
    if (!homeStatRow || !awayStatRow) continue;

    for (const metric of STAT_METRICS) {
      // statDelta is home-minus-away (sign-flipped for ERA/WHIP so positive
      // always means "this side is better on this stat"); the away side's
      // delta is the negation. Each side is bucketed by its own delta, and
      // the game outcome is complementary (no MLB ties - guarded above).
      const homeDelta = statDelta(metric, homeStatRow, awayStatRow);
      const counts = statCounts.get(metric.key)!;
      recordSide(counts, bucketForMetricValue(homeDelta, metric.buckets).id, "a", homeWon);
      recordSide(counts, bucketForMetricValue(-homeDelta, metric.buckets).id, "b", !homeWon);
      statGamesConsidered.set(metric.key, statGamesConsidered.get(metric.key)! + 1);
    }
  }

  const dimensions: ZoneModelDimensionReport[] = [
    finalizeDimension(
      "ml",
      "ML Delta",
      "Favorite's history win% as a favorite minus the underdog's history win% as an underdog. Favorite and underdog are each bucketed by their own version of that delta; every range shows both real records, from different games, neither inverted from the other.",
      "Favorite",
      "Underdog",
      ZONE_MODEL_BUCKETS,
      mlCounts,
      mlGames
    ),
    finalizeDimension(
      "total",
      "Total Delta",
      "This matchup's combined history over-rate minus under-rate. The over and the under are each bucketed by their own version of that delta; every range shows both real records.",
      "Over",
      "Under",
      ZONE_MODEL_BUCKETS,
      totalCounts,
      totalGames
    ),
    ...STAT_METRICS.map((metric) =>
      finalizeDimension(
        metric.key,
        metric.label,
        metric.description,
        "Home",
        "Away",
        metric.buckets,
        statCounts.get(metric.key)!,
        statGamesConsidered.get(metric.key)!
      )
    ),
  ];

  return { sportKey, dimensions };
}

// ---------------------------------------------------------------------------
// Pending games - TODAY's current data, no point-in-time restriction
// (deliberately different from the historical calibration above: a game
// that hasn't happened yet has no look-ahead concern, so this reads each
// team's CURRENT TeamTendency row directly and the MOST RECENT
// TeamStatSnapshot row via the same findLatestAtOrBefore helper called with
// `asOf = now`, rather than day-before).
// ---------------------------------------------------------------------------

export type PendingZoneGame = {
  awayTeam: string;
  homeTeam: string;
  commenceTime: string;
  deltaDisplay: string;
  qualifyingSide: string;
  qualifierLabel: string;
};

export type PendingZoneDimension = {
  key: ZoneDimensionKey;
  gamesByBucket: Record<string, PendingZoneGame[]>;
};

export type PendingZoneReport = {
  sportKey: string;
  dimensions: PendingZoneDimension[];
};

function pushPending(
  map: Map<ZoneDimensionKey, Map<string, PendingZoneGame[]>>,
  key: ZoneDimensionKey,
  bucketId: string,
  game: PendingZoneGame
) {
  let byBucket = map.get(key);
  if (!byBucket) { byBucket = new Map(); map.set(key, byBucket); }
  let list = byBucket.get(bucketId);
  if (!list) { list = []; byBucket.set(bucketId, list); }
  list.push(game);
}

export async function computePendingZoneGames(sportKey: string): Promise<PendingZoneReport> {
  // Reused directly from decay-delta-predictions.ts's persistPregameDecayDeltaGames:
  // latest OddsSnapshot for the sport, filtered to games that haven't started.
  const snapshot = await prisma.oddsSnapshot.findFirst({ where: { sportKey }, orderBy: { fetchDate: "desc" } });
  const now = new Date();

  const result: Map<ZoneDimensionKey, Map<string, PendingZoneGame[]>> = new Map();
  const allKeys: ZoneDimensionKey[] = ["ml", "total", ...STAT_METRICS.map((m) => m.key)];
  for (const key of allKeys) result.set(key, new Map());

  if (!snapshot) {
    return { sportKey, dimensions: allKeys.map((key) => ({ key, gamesByBucket: {} })) };
  }

  const games = (snapshot.data as unknown as OddsGame[]).filter((g) => new Date(g.commenceTime) > now);

  const [tendencyRows, statSnapshotRows] = await Promise.all([
    prisma.teamTendency.findMany({ where: { sportKey } }) as Promise<(TendencyCounts & { teamName: string })[]>,
    prisma.teamStatSnapshot.findMany({ where: { sportKey }, orderBy: { snapshotDate: "asc" } }) as Promise<TeamStatRow[]>,
  ]);
  const tendencyByTeam = new Map(tendencyRows.map((r) => [r.teamName, r]));
  const statByTeam = new Map<string, TeamStatRow[]>();
  for (const row of statSnapshotRows) {
    let list = statByTeam.get(row.teamName);
    if (!list) { list = []; statByTeam.set(row.teamName, list); }
    list.push(row);
  }
  const currentStat = (teamName: string) => findLatestAtOrBefore(statByTeam.get(teamName) ?? [], now);

  for (const g of games) {
    const homePrice = moneylinePrice(g, g.homeTeam);
    const awayPrice = moneylinePrice(g, g.awayTeam);
    const favTeam = homePrice !== null && awayPrice !== null && homePrice !== awayPrice
      ? (homePrice < awayPrice ? g.homeTeam : g.awayTeam)
      : null;
    const line = totalLineOf(g);

    if (favTeam !== null) {
      const dogTeam = favTeam === g.homeTeam ? g.awayTeam : g.homeTeam;
      const favRow = tendencyByTeam.get(favTeam);
      const dogRow = tendencyByTeam.get(dogTeam);
      if (favRow && dogRow) {
        const favWinPct = computeTendencyRates(favRow).favWinPct;
        const dogWinPct = computeTendencyRates(dogRow).dogWinPct;
        if (favWinPct !== null && dogWinPct !== null) {
          const delta = pct(favWinPct) - pct(dogWinPct);
          const bucket = bucketForDelta(delta);
          pushPending(result, "ml", bucket.id, {
            awayTeam: g.awayTeam, homeTeam: g.homeTeam, commenceTime: g.commenceTime,
            deltaDisplay: String(delta), qualifyingSide: favTeam, qualifierLabel: "Fav ML",
          });
        }
      }
    }

    if (line !== null) {
      const homeRow = tendencyByTeam.get(g.homeTeam);
      const awayRow = tendencyByTeam.get(g.awayTeam);
      if (homeRow && awayRow) {
        const combinedRates = computeTendencyRates(combinedTotalsCounts(homeRow, awayRow));
        if (combinedRates.overRate !== null && combinedRates.underRate !== null) {
          const delta = pct(combinedRates.overRate) - pct(combinedRates.underRate);
          const bucket = bucketForDelta(delta);
          pushPending(result, "total", bucket.id, {
            awayTeam: g.awayTeam, homeTeam: g.homeTeam, commenceTime: g.commenceTime,
            deltaDisplay: String(delta), qualifyingSide: delta >= 0 ? "Over" : "Under", qualifierLabel: "Total",
          });
        }
      }
    }

    const homeStatRow = currentStat(g.homeTeam);
    const awayStatRow = currentStat(g.awayTeam);
    if (homeStatRow && awayStatRow) {
      for (const metric of STAT_METRICS) {
        const delta = statDelta(metric, homeStatRow, awayStatRow);
        const bucket = bucketForMetricValue(delta, metric.buckets);
        const qualifyingSide = delta >= 0 ? g.homeTeam : g.awayTeam;
        pushPending(result, metric.key, bucket.id, {
          awayTeam: g.awayTeam, homeTeam: g.homeTeam, commenceTime: g.commenceTime,
          deltaDisplay: formatMetricValue(delta, metric.decimals), qualifyingSide, qualifierLabel: metric.qualifierLabel,
        });
      }
    }
  }

  return {
    sportKey,
    dimensions: allKeys.map((key) => ({
      key,
      gamesByBucket: Object.fromEntries(result.get(key) ?? new Map()),
    })),
  };
}

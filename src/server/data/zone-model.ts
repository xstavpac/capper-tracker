// Zone Model: an admin-only bucketed delta calibration tool. For every
// graded historical game, computes two independent deltas from REAL,
// already-tracked BettingView data - team-tendencies.ts's TeamTendency
// table, via its own computeTendencyRates (reused directly, not
// reimplemented):
//
//   ML Delta    = (favorite team's history win% AS a favorite)
//                 - (underdog team's history win% AS an underdog)
//   Total Delta = (this matchup's combined history over-rate)
//                 - (this matchup's combined history under-rate)
//
// Each game is bucketed by its delta into one of ten ranges (see
// ZONE_MODEL_BUCKETS) and contributes a win/loss to that bucket - "win"
// meaning the side the delta's sign favors held (the favorite for ML, the
// over for Total), so every bucket's W-L record answers the same question
// regardless of whether its delta is positive or negative. Buckets are
// reported independently: a bucket's win% is never averaged, smoothed, or
// blended with its neighbors, and a bucket with zero games is still
// returned (not dropped) so the caller can render it as an explicit empty
// state.
//
// Deliberate scope, not a bug: this uses each team's CURRENT, all-time-to-
// date TeamTendency row for every historical game, exactly as
// computeTendencyRates already exposes it - not a point-in-time snapshot
// as-of that game's own date. A team's rate for a given game therefore
// includes that same game's own result (and every game after it). This is
// a real methodological difference from the separate, leak-free
// decay-delta-predictions.ts system (which deliberately asOf-bounds its
// model-engine computation to avoid exactly this look-ahead). Zone Model
// trades that rigor for simplicity and a direct, literal reuse of
// computeTendencyRates - it answers "how did games land in each bucket of
// today's all-time tendency numbers", not "would this have been
// predictable in real time". See the PR description for the full tradeoff.
import { prisma } from "@/lib/prisma";
import { computeTendencyRates, type TeamTendencyRates } from "@/server/data/team-tendencies";
import { actualFavWon } from "@/server/data/model-engine/decay-delta-outcome";
import { deriveWentOver } from "@/server/data/model-engine/decay-delta-predictions";

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
// rounded to a whole percent BEFORE subtracting (see mlDelta/totalDelta
// below), matching decay-delta.ts's own round-before-subtract convention so
// this scheme's half-open-via-integer-offset boundaries are well-defined.
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

export type ZoneModelBucketResult = {
  bucket: ZoneModelBucket;
  games: number;
  wins: number;
  losses: number;
  winPct: number | null;
};

export type ZoneModelReport = {
  sportKey: string;
  ml: ZoneModelBucketResult[];
  total: ZoneModelBucketResult[];
  mlGamesConsidered: number;
  totalGamesConsidered: number;
};

function emptyBucketResults(): Map<string, { games: number; wins: number; losses: number }> {
  const map = new Map<string, { games: number; wins: number; losses: number }>();
  for (const bucket of ZONE_MODEL_BUCKETS) map.set(bucket.id, { games: 0, wins: 0, losses: 0 });
  return map;
}

function finalizeBucketResults(
  counts: Map<string, { games: number; wins: number; losses: number }>
): ZoneModelBucketResult[] {
  return ZONE_MODEL_BUCKETS.map((bucket) => {
    const c = counts.get(bucket.id)!;
    return {
      bucket,
      games: c.games,
      wins: c.wins,
      losses: c.losses,
      winPct: c.games > 0 ? (c.wins / c.games) * 100 : null,
    };
  });
}

// Computes both bucket reports fresh from GameResult + TeamTendency on every
// call - no separate stored/frozen table, so it improves automatically as
// more games grade, mirroring getDecayDeltaBucketWinRates' own "live query,
// not a snapshot" approach.
export async function computeZoneModel(sportKey: string): Promise<ZoneModelReport> {
  const [games, tendencyRows] = await Promise.all([
    prisma.gameResult.findMany({
      where: { sportKey, OR: [{ favTeam: { not: null } }, { totalLine: { not: null } }] },
      select: {
        id: true,
        homeTeam: true,
        awayTeam: true,
        homeScore: true,
        awayScore: true,
        favTeam: true,
        totalLine: true,
        gameDate: true,
      },
    }),
    prisma.teamTendency.findMany({ where: { sportKey } }),
  ]);

  const ratesByTeam = new Map<string, TeamTendencyRates>();
  const countsByTeam = new Map<string, TendencyCounts>();
  for (const row of tendencyRows) {
    countsByTeam.set(row.teamName, row);
    ratesByTeam.set(row.teamName, computeTendencyRates(row));
  }

  const mlCounts = emptyBucketResults();
  const totalCounts = emptyBucketResults();
  let mlGamesConsidered = 0;
  let totalGamesConsidered = 0;

  for (const game of games) {
    if (game.favTeam !== null) {
      const dogTeam = game.favTeam === game.homeTeam ? game.awayTeam : game.homeTeam;
      const favRates = ratesByTeam.get(game.favTeam);
      const dogRates = ratesByTeam.get(dogTeam);
      const favWon = actualFavWon({
        id: game.id,
        favTeam: game.favTeam,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        gameDate: game.gameDate,
      });

      if (favRates?.favWinPct !== null && favRates?.favWinPct !== undefined &&
          dogRates?.dogWinPct !== null && dogRates?.dogWinPct !== undefined &&
          favWon !== null) {
        const delta = pct(favRates.favWinPct) - pct(dogRates.dogWinPct);
        const bucket = bucketForDelta(delta);
        const entry = mlCounts.get(bucket.id)!;
        entry.games++;
        if (favWon) entry.wins++;
        else entry.losses++;
        mlGamesConsidered++;
      }
    }

    if (game.totalLine !== null) {
      const homeCounts = countsByTeam.get(game.homeTeam);
      const awayCounts = countsByTeam.get(game.awayTeam);
      const wentOver = deriveWentOver({ homeScore: game.homeScore, awayScore: game.awayScore, totalLine: game.totalLine });

      if (homeCounts && awayCounts && wentOver !== null) {
        const combinedRates = computeTendencyRates(combinedTotalsCounts(homeCounts, awayCounts));
        if (combinedRates.overRate !== null && combinedRates.underRate !== null) {
          const delta = pct(combinedRates.overRate) - pct(combinedRates.underRate);
          const bucket = bucketForDelta(delta);
          const entry = totalCounts.get(bucket.id)!;
          entry.games++;
          if (wentOver) entry.wins++;
          else entry.losses++;
          totalGamesConsidered++;
        }
      }
    }
  }

  return {
    sportKey,
    ml: finalizeBucketResults(mlCounts),
    total: finalizeBucketResults(totalCounts),
    mlGamesConsidered,
    totalGamesConsidered,
  };
}

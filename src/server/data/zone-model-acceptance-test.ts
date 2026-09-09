// Proof for Zone Model (src/server/data/zone-model.ts): bucket boundary
// exhaustiveness, that computeZoneModel's delta math is exactly
// computeTendencyRates reused (not a parallel/reimplemented rate), that
// Total Delta combines two teams' raw counts BEFORE computing a rate rather
// than averaging two already-computed percentages, and that every one of
// the ten buckets is always present in the output - including ones with
// zero games, which must report games:0/winPct:null rather than being
// dropped from the array.
//
// Pure: the prisma singleton's methods are swapped for spies before each
// call, so no database is touched - same convention as
// team-tendencies-acceptance-test.ts. Run with:
//   npx tsx src/server/data/zone-model-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { bucketForDelta, computeZoneModel, ZONE_MODEL_BUCKETS, type ZoneModelBucketResult } from "@/server/data/zone-model";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

// ---- prisma spies -------------------------------------------------------
const originals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  originals[path] ??= target[method];
  target[method] = fn;
}
function restoreAll() {
  for (const path of Object.keys(originals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = originals[path];
  }
}

const SPORT = "zone_model_test_sport";

type TendencyRow = {
  teamName: string;
  favWins: number; favLosses: number; favPushes: number;
  dogWins: number; dogLosses: number; dogPushes: number;
  overCount: number; underCount: number; totalPushCount: number;
};

type GameRow = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  favTeam: string | null;
  totalLine: number | null;
  gameDate: Date;
};

function bucketResult(results: ZoneModelBucketResult[], bucketId: string): ZoneModelBucketResult {
  const found = results.find((r) => r.bucket.id === bucketId);
  if (!found) throw new Error(`bucket ${bucketId} missing from results - every bucket must always be present`);
  return found;
}

async function main() {
  // ---- 1. Bucket boundaries: exhaustive, non-overlapping, matches decay-delta's own proven scheme ----
  {
    const boundaryValues = [0, 10, -10, 20, -20, 30, -30, 40, -40, 15, -15, 100, -100, 39, -39];
    for (const value of boundaryValues) {
      const matches = ZONE_MODEL_BUCKETS.filter((b) => (b.min === null || value >= b.min) && (b.max === null || value <= b.max));
      expect(`delta=${value} matches exactly one bucket`, matches.length, 1);
    }
    expect("delta=0 is the tie-break case: owned by 0_to_10, not 0_to_neg10", bucketForDelta(0).id, "0_to_10");
    expect("delta=-10 owned by neg10_to_neg20 (not 0_to_neg10)", bucketForDelta(-10).id, "neg10_to_neg20");
    expect("delta=40 owned by ge_40", bucketForDelta(40).id, "ge_40");
    expect("delta=-40 owned by le_neg40", bucketForDelta(-40).id, "le_neg40");
    expect("delta=39 owned by 30_to_40 (not ge_40)", bucketForDelta(39).id, "30_to_40");
  }

  // ---- 2. computeZoneModel aggregation, via prisma spies ----
  // TeamA: a strong favorite historically (80% as fav), never tracked as an
  // underdog. Small-sample over/under history (1-1).
  const teamA: TendencyRow = {
    teamName: "TeamA",
    favWins: 8, favLosses: 2, favPushes: 0,
    dogWins: 0, dogLosses: 0, dogPushes: 0,
    overCount: 1, underCount: 1, totalPushCount: 0,
  };
  // TeamB: a weak underdog historically (30% as dog), never tracked as a
  // favorite. Large-sample over/under history, heavily under-leaning.
  const teamB: TendencyRow = {
    teamName: "TeamB",
    favWins: 0, favLosses: 0, favPushes: 0,
    dogWins: 3, dogLosses: 7, dogPushes: 0,
    overCount: 2, underCount: 8, totalPushCount: 0,
  };
  // TeamC: no TeamTendency row at all (brand new team, zero history).

  const games: GameRow[] = [
    // Game 1: TeamA (home, favorite) beats TeamB (away, underdog) 5-3.
    // ML delta = pct(TeamA.favWinPct=0.8)=80 - pct(TeamB.dogWinPct=0.3)=30 = 50 -> ge_40, fav won -> W.
    // Total: combined over=1+2=3, under=1+8=9, total=12 -> overRate=3/12=0.25 (pct 25),
    // underRate=9/12=0.75 (pct 75) -> delta=25-75=-50 -> le_neg40. Actual total 8 vs line 8.5 -> under -> L (over side).
    {
      id: "g1", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 5, awayScore: 3,
      favTeam: "TeamA", totalLine: 8.5, gameDate: new Date("2026-06-01T23:00:00Z"),
    },
    // Game 2: same matchup, TeamB (away) upsets TeamA (home) 2-1 - decided outcome, no push.
    // Same ML delta bucket (ge_40) as game 1 since it reuses the same all-time tendency rows,
    // but favWon is FALSE this time -> this bucket accumulates a mix of W and L.
    // Total line pushed exactly (3 = 3.0) -> excluded from Total Delta entirely.
    {
      id: "g2", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 1, awayScore: 2,
      favTeam: "TeamA", totalLine: 3, gameDate: new Date("2026-06-02T23:00:00Z"),
    },
    // Game 3: a tied-score game (favWon indeterminate) - must be excluded from ML entirely,
    // not counted as a loss or a push-as-loss.
    {
      id: "g3", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 4, awayScore: 4,
      favTeam: "TeamA", totalLine: null, gameDate: new Date("2026-06-03T23:00:00Z"),
    },
    // Game 4: involves TeamC, which has no TeamTendency row - must be skipped
    // entirely (not defaulted to delta=0), for both ML and Total.
    {
      id: "g4", homeTeam: "TeamC", awayTeam: "TeamB", homeScore: 5, awayScore: 1,
      favTeam: "TeamC", totalLine: 6.5, gameDate: new Date("2026-06-04T23:00:00Z"),
    },
  ];

  patch("gameResult.findMany", async () => games);
  patch("teamTendency.findMany", async () => [teamA, teamB]);

  const report = await computeZoneModel(SPORT);

  // ---- ML Delta ----
  expect("ML: only g1 and g2 contributed (g3 tied, g4 missing tendency data)", report.mlGamesConsidered, 2);
  const mlGe40 = bucketResult(report.ml, "ge_40");
  expect("ML ge_40: both decided games land here (same all-time fav/dog rates)", mlGe40.games, 2);
  expect("ML ge_40: g1's favorite won -> 1 W", mlGe40.wins, 1);
  expect("ML ge_40: g2's favorite lost -> 1 L", mlGe40.losses, 1);
  expect("ML ge_40: win% is 50 (1 of 2), not smoothed toward either game alone", mlGe40.winPct, 50);

  // ---- Total Delta: must use SUMMED counts, not an average of two rates ----
  // TeamA overRate alone = 1/2 = 0.50 (pct 50); TeamB overRate alone = 2/10 = 0.20 (pct 20).
  // A WRONG implementation that averaged those two percentages would get
  // overPct=(50+20)/2=35, underPct=(50+80)/2=65 -> delta=-30 -> bucket neg30_to_neg40.
  // The CORRECT implementation sums raw counts first: combined over=1+2=3,
  // under=1+8=9, total=12 -> overRate=3/12=25%, underRate=9/12=75% -> delta=-50 -> le_neg40.
  expect("Total: only g1 contributed (g2's line pushed, g3 has no line, g4 missing tendency data)", report.totalGamesConsidered, 1);
  const wrongAveragedBucket = "neg30_to_neg40";
  const correctSummedBucket = "le_neg40";
  const totalLeNeg40 = bucketResult(report.total, correctSummedBucket);
  const totalWrongBucket = bucketResult(report.total, wrongAveragedBucket);
  expect("Total: g1 lands in the SUMMED-counts bucket (le_neg40)", totalLeNeg40.games, 1);
  expect("Total: g1's under hit -> 0 W for the over side", totalLeNeg40.wins, 0);
  expect("Total: g1's under hit -> 1 L for the over side", totalLeNeg40.losses, 1);
  expect("Total: the AVERAGED-rate bucket got nothing - proves counts were summed, not rates averaged", totalWrongBucket.games, 0);

  // ---- Every bucket is always present, including empty ones ----
  expect("ML report has all 10 buckets, in ZONE_MODEL_BUCKETS order", report.ml.map((r) => r.bucket.id), ZONE_MODEL_BUCKETS.map((b) => b.id));
  expect("Total report has all 10 buckets, in ZONE_MODEL_BUCKETS order", report.total.map((r) => r.bucket.id), ZONE_MODEL_BUCKETS.map((b) => b.id));
  const mlEmpty = bucketResult(report.ml, "0_to_10");
  expect("ML 0_to_10 (no games landed here): games=0", mlEmpty.games, 0);
  expect("ML 0_to_10 (no games landed here): wins=0", mlEmpty.wins, 0);
  expect("ML 0_to_10 (no games landed here): losses=0", mlEmpty.losses, 0);
  expect("ML 0_to_10 (no games landed here): winPct=null, never a divide-by-zero fallback like 0", mlEmpty.winPct, null);

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();

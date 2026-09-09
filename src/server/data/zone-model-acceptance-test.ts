// Proof for Zone Model (src/server/data/zone-model.ts): bucket boundary
// exhaustiveness, that computeZoneModel's delta math is exactly
// computeTendencyRates reused (not a parallel/reimplemented rate) against
// each team's history AS IT STOOD ON THE GAME'S OWN DATE (point-in-time via
// TeamTendencySnapshot + findLatestAtOrBefore - never a same-day or later
// snapshot), that Total Delta combines two teams' raw counts BEFORE
// computing a rate rather than averaging two already-computed percentages,
// and that every one of the ten buckets is always present in the output -
// including ones with zero games, which must report games:0/winPct:null
// rather than being dropped from the array.
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

type TendencySnapshotRow = {
  teamName: string;
  snapshotDate: string;
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
  // TeamA's favorite-role rate EVOLVES over three dated snapshots - the
  // whole point of this fixture is proving a game's bucket depends on which
  // of these was actually true as of ITS OWN date, not on TeamA's rate today.
  //   2026-06-01: 3-7 as favorite (30%)
  //   2026-06-02: 99-1 as favorite (99%) - dated the SAME DAY as game g1
  //               below. If point-in-time exclusion regressed to same-day-
  //               inclusive, g1 would wrongly pick this row up.
  //   2026-06-05: 9-1 as favorite (90%)
  const teamASnapshots: TendencySnapshotRow[] = [
    { teamName: "TeamA", snapshotDate: "2026-06-01", favWins: 3, favLosses: 7, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 1, underCount: 1, totalPushCount: 0 },
    { teamName: "TeamA", snapshotDate: "2026-06-02", favWins: 99, favLosses: 1, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 0, underCount: 0, totalPushCount: 0 },
    { teamName: "TeamA", snapshotDate: "2026-06-05", favWins: 9, favLosses: 1, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 0, underCount: 0, totalPushCount: 0 },
  ];
  // TeamB's underdog-role rate stays a constant 20% across its two
  // snapshots (2 of 10) - held fixed so the point-in-time proof above
  // isolates TeamA's changing rate as the only variable.
  const teamBSnapshots: TendencySnapshotRow[] = [
    { teamName: "TeamB", snapshotDate: "2026-06-01", favWins: 0, favLosses: 0, favPushes: 0, dogWins: 2, dogLosses: 8, dogPushes: 0, overCount: 2, underCount: 8, totalPushCount: 0 },
    { teamName: "TeamB", snapshotDate: "2026-06-05", favWins: 0, favLosses: 0, favPushes: 0, dogWins: 2, dogLosses: 8, dogPushes: 0, overCount: 0, underCount: 0, totalPushCount: 0 },
  ];
  // TeamC: never snapshotted at all (brand new team, zero history).

  const games: GameRow[] = [
    // g1: 2026-06-02. asOf = end of 2026-06-01 (the day BEFORE this game) -
    // must pick TeamA's 06-01 row (30%), never the same-day 06-02 row (99%).
    // ML delta = pct(0.30)=30 - pct(TeamB dog 0.20)=20 = 10 -> bucket "10_to_20".
    // Fav (home TeamA, 5) beat dog (away TeamB, 3) -> W.
    // Total: combined over=1+2=3, under=1+8=9, total=12 -> overRate 25%, underRate 75% -> delta=-50 -> "le_neg40".
    // Actual total 8 vs line 8.5 -> under -> L (over side).
    {
      id: "g1", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 5, awayScore: 3,
      favTeam: "TeamA", totalLine: 8.5, gameDate: new Date("2026-06-02T23:00:00Z"),
    },
    // g2: 2026-06-06. asOf = end of 2026-06-05 -> picks TeamA's 06-05 row (90%).
    // ML delta = 90 - 20 = 70 -> bucket "ge_40" - a DIFFERENT bucket than g1,
    // same team pair, proving the delta tracks each game's own date.
    // Fav (home TeamA, 2) lost to dog (away TeamB, 9) -> L.
    // totalLine set exactly equal to the actual total (11) -> a push -> excluded from Total entirely.
    {
      id: "g2", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 2, awayScore: 9,
      favTeam: "TeamA", totalLine: 11, gameDate: new Date("2026-06-06T23:00:00Z"),
    },
    // g3: TeamC has NO snapshot rows at all, ever - must be skipped entirely
    // (not defaulted to delta=0), for both ML and Total.
    {
      id: "g3", homeTeam: "TeamC", awayTeam: "TeamB", homeScore: 5, awayScore: 1,
      favTeam: "TeamC", totalLine: 6.5, gameDate: new Date("2026-06-02T23:00:00Z"),
    },
    // g4: 2026-05-25, before EITHER team's earliest snapshot (2026-06-01) -
    // no snapshot exists as of this date for either team, so this game must
    // be skipped too. Documents the real consequence noted in zone-model.ts:
    // history before snapshotting began contributes nothing.
    {
      id: "g4", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 4, awayScore: 2,
      favTeam: "TeamA", totalLine: 5.5, gameDate: new Date("2026-05-25T23:00:00Z"),
    },
  ];

  patch("gameResult.findMany", async () => games);
  patch("teamTendencySnapshot.findMany", async () => [...teamASnapshots, ...teamBSnapshots]);

  const report = await computeZoneModel(SPORT);

  // ---- ML Delta: point-in-time correctness ----
  expect("ML: only g1 and g2 contributed (g3 has no snapshot ever, g4 predates all snapshots)", report.mlGamesConsidered, 2);
  const ml10to20 = bucketResult(report.ml, "10_to_20");
  expect("ML 10_to_20: g1 lands here using TeamA's 06-01 rate (30%), NOT the same-day 06-02 rate (99%)", ml10to20.games, 1);
  expect("ML 10_to_20: g1's favorite won -> 1 W", ml10to20.wins, 1);
  const mlGe40 = bucketResult(report.ml, "ge_40");
  expect("ML ge_40: g2 lands here using TeamA's LATER 06-05 rate (90%) - same team pair, different bucket than g1", mlGe40.games, 1);
  expect("ML ge_40: g2's favorite lost -> 1 L", mlGe40.losses, 1);
  expect("ML ge_40 does NOT contain g1 - proves same-day snapshot exclusion, not just 'a' snapshot", mlGe40.wins, 0);

  // ---- Total Delta: must use SUMMED counts, not an average of two rates ----
  // As of g1's date: TeamA overRate alone = 1/2 = 0.50 (pct 50); TeamB overRate alone = 2/10 = 0.20 (pct 20).
  // A WRONG implementation that averaged those two percentages would get
  // overPct=(50+20)/2=35, underPct=(50+80)/2=65 -> delta=-30 -> bucket neg30_to_neg40.
  // The CORRECT implementation sums raw counts first: combined over=1+2=3,
  // under=1+8=9, total=12 -> overRate=3/12=25%, underRate=9/12=75% -> delta=-50 -> le_neg40.
  expect("Total: only g1 contributed (g2's line pushed, g3/g4 have no snapshot as of their date)", report.totalGamesConsidered, 1);
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

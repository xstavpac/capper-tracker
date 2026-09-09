// Proof for Zone Model (src/server/data/zone-model.ts):
//  - ML/Total Delta bucket boundary exhaustiveness and point-in-time
//    correctness (unchanged math, re-verified against the new dimensions[]
//    report shape).
//  - Each of the five team-stat dimensions' bucket boundary exhaustiveness
//    (buildMetricBuckets/bucketForMetricValue - real, non-integer bounds),
//    the ERA/WHIP sign-flip (lower is better) vs Run Diff/OPS/Batting
//    Average (higher is better), and the SAME point-in-time discipline
//    (TeamStatSnapshot via findLatestAtOrBefore + dayBefore) verified with
//    the same same-day-snapshot-must-not-leak regression shape that caught
//    the original ML/Total look-ahead bug.
//  - computePendingZoneGames: today's pending games bucketed by CURRENT
//    (not point-in-time) data, with the exact per-game display format.
//
// Pure: the prisma singleton's methods are swapped for spies before each
// call, so no database is touched - same convention as
// team-tendencies-acceptance-test.ts. Run with:
//   npx tsx src/server/data/zone-model-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import {
  bucketForDelta,
  bucketForMetricValue,
  computeZoneModel,
  computePendingZoneGames,
  ZONE_MODEL_BUCKETS,
  type ZoneModelBucketResult,
  type ZoneModelReport,
  type ZoneDimensionKey,
  type MetricBucket,
  type PendingZoneReport,
} from "@/server/data/zone-model";

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

function dimension(report: ZoneModelReport, key: ZoneDimensionKey) {
  const found = report.dimensions.find((d) => d.key === key);
  if (!found) throw new Error(`dimension ${key} missing from report`);
  return found;
}
function bucketResult(results: ZoneModelBucketResult[], bucketId: string): ZoneModelBucketResult {
  const found = results.find((r) => r.bucket.id === bucketId);
  if (!found) throw new Error(`bucket ${bucketId} missing from results - every bucket must always be present`);
  return found;
}

type TendencySnapshotRow = {
  teamName: string;
  snapshotDate: string;
  favWins: number; favLosses: number; favPushes: number;
  dogWins: number; dogLosses: number; dogPushes: number;
  overCount: number; underCount: number; totalPushCount: number;
};
type StatSnapshotRow = {
  teamName: string; snapshotDate: string;
  runDifferential: number; era: number; whip: number; ops: number; battingAvg: number;
};
type GameRow = {
  id: string; homeTeam: string; awayTeam: string; homeScore: number; awayScore: number;
  favTeam: string | null; totalLine: number | null; gameDate: Date;
};

async function main() {
  // ---- 1. ML/Total bucket boundaries - unchanged, re-verified ----
  {
    const boundaryValues = [0, 10, -10, 20, -20, 30, -30, 40, -40, 15, -15, 100, -100, 39, -39];
    for (const value of boundaryValues) {
      const matches = ZONE_MODEL_BUCKETS.filter((b) => (b.min === null || value >= b.min) && (b.max === null || value <= b.max));
      expect(`ML/Total delta=${value} matches exactly one bucket`, matches.length, 1);
    }
    expect("delta=0 is the tie-break case: owned by 0_to_10, not 0_to_neg10", bucketForDelta(0).id, "0_to_10");
    expect("delta=-10 owned by neg10_to_neg20 (not 0_to_neg10)", bucketForDelta(-10).id, "neg10_to_neg20");
  }

  // ---- 2. Metric-bucket boundaries (real, non-integer bounds) - same ownership convention ----
  {
    // Reach into a fresh scheme via computeZoneModel's own exported buckets
    // isn't available directly (STAT_METRICS is module-private), so this
    // proves the shared matcher (bucketForMetricValue) against a
    // hand-built scheme with a round tier width, exercising the exact same
    // matchesMetricBucket the real metrics use.
    const w = 10;
    const buckets: MetricBucket[] = [
      { id: "ge_4w", label: "40+", min: 40, minInclusive: true, max: null, maxInclusive: false },
      { id: "3w_4w", label: "30 to 40", min: 30, minInclusive: true, max: 40, maxInclusive: false },
      { id: "2w_3w", label: "20 to 30", min: 20, minInclusive: true, max: 30, maxInclusive: false },
      { id: "1w_2w", label: "10 to 20", min: 10, minInclusive: true, max: 20, maxInclusive: false },
      { id: "0_1w", label: "0 to 10", min: 0, minInclusive: true, max: 10, maxInclusive: false },
      { id: "0_neg1w", label: "0 to -10", min: -10, minInclusive: false, max: 0, maxInclusive: false },
      { id: "neg1w_neg2w", label: "-10 to -20", min: -20, minInclusive: false, max: -10, maxInclusive: true },
      { id: "neg2w_neg3w", label: "-20 to -30", min: -30, minInclusive: false, max: -20, maxInclusive: true },
      { id: "neg3w_neg4w", label: "-30 to -40", min: -40, minInclusive: false, max: -30, maxInclusive: true },
      { id: "le_neg4w", label: "-40 or less", min: null, minInclusive: false, max: -40, maxInclusive: true },
    ];
    const boundaryValues = [0, w, -w, 2 * w, -2 * w, 3 * w, -3 * w, 4 * w, -4 * w, 5, -5];
    for (const value of boundaryValues) {
      const matches = buckets.filter((b) => {
        const aboveMin = b.min === null || (b.minInclusive ? value >= b.min : value > b.min);
        const belowMax = b.max === null || (b.maxInclusive ? value <= b.max : value < b.max);
        return aboveMin && belowMax;
      });
      expect(`metric-bucket value=${value} matches exactly one bucket`, matches.length, 1);
    }
    expect("value=0 owned by 0_1w (not 0_neg1w) - same tie-break as ML/Total", bucketForMetricValue(0, buckets).id, "0_1w");
    expect("value=w owned by 1w_2w (not 0_1w) - near edge inclusive on the near side, exclusive on the far side", bucketForMetricValue(w, buckets).id, "1w_2w");
    expect("value=-w owned by neg1w_neg2w (not 0_neg1w) - mirrors ML/Total's -10 ownership rule", bucketForMetricValue(-w, buckets).id, "neg1w_neg2w");
    expect("value=4w owned by ge_4w", bucketForMetricValue(4 * w, buckets).id, "ge_4w");
    expect("value=-4w owned by le_neg4w", bucketForMetricValue(-4 * w, buckets).id, "le_neg4w");
  }

  // ---- 3. computeZoneModel: point-in-time correctness across ALL seven dimensions ----
  // TeamA's rate/stat lines EVOLVE over three dated snapshots per table -
  // proving each game's bucket depends on what was true as of ITS OWN date.
  //   2026-06-01: baseline
  //   2026-06-02: SAME DAY as g1 below, drastically different everywhere -
  //               if point-in-time exclusion regressed to same-day-
  //               inclusive, g1 would wrongly pick these values up.
  //   2026-06-05: a second, later baseline (used by g2)
  const teamATendency: TendencySnapshotRow[] = [
    { teamName: "TeamA", snapshotDate: "2026-06-01", favWins: 3, favLosses: 7, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 1, underCount: 1, totalPushCount: 0 },
    { teamName: "TeamA", snapshotDate: "2026-06-02", favWins: 99, favLosses: 1, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 0, underCount: 0, totalPushCount: 0 },
    { teamName: "TeamA", snapshotDate: "2026-06-05", favWins: 9, favLosses: 1, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 0, underCount: 0, totalPushCount: 0 },
  ];
  const teamBTendency: TendencySnapshotRow[] = [
    { teamName: "TeamB", snapshotDate: "2026-06-01", favWins: 0, favLosses: 0, favPushes: 0, dogWins: 2, dogLosses: 8, dogPushes: 0, overCount: 2, underCount: 8, totalPushCount: 0 },
    { teamName: "TeamB", snapshotDate: "2026-06-05", favWins: 0, favLosses: 0, favPushes: 0, dogWins: 2, dogLosses: 8, dogPushes: 0, overCount: 0, underCount: 0, totalPushCount: 0 },
  ];

  const teamAStats: StatSnapshotRow[] = [
    { teamName: "TeamA", snapshotDate: "2026-06-01", runDifferential: 10, era: 4.05, whip: 1.22, ops: 0.690, battingAvg: 0.250 },
    { teamName: "TeamA", snapshotDate: "2026-06-02", runDifferential: 999, era: 0.01, whip: 0.01, ops: 9.999, battingAvg: 0.999 },
    { teamName: "TeamA", snapshotDate: "2026-06-05", runDifferential: -20, era: 6.00, whip: 1.60, ops: 0.600, battingAvg: 0.200 },
  ];
  const teamBStats: StatSnapshotRow[] = [
    { teamName: "TeamB", snapshotDate: "2026-06-01", runDifferential: -5, era: 4.50, whip: 1.30, ops: 0.680, battingAvg: 0.240 },
    { teamName: "TeamB", snapshotDate: "2026-06-05", runDifferential: -5, era: 4.50, whip: 1.30, ops: 0.680, battingAvg: 0.240 },
  ];
  // TeamC: never snapshotted in either table (brand new team, zero history).

  const games: GameRow[] = [
    // g1: 2026-06-02. asOf = end of 2026-06-01 - must pick the 06-01 rows,
    // never the same-day 06-02 rows. Home (TeamA) won 5-3.
    // ML delta = pct(.30)=30 - pct(.20)=20 = 10 -> "10_to_20", fav won -> W.
    // Total: combined over=1+2=3,under=1+8=9,total=12 -> delta=25-75=-50 -> "le_neg40". Actual 8<8.5 -> under -> L.
    // run_diff: 10-(-5)=15 -> [10,20) "1w_2w", home qualifies, home won -> W.
    // era (away-home): 4.50-4.05=0.45 -> [.25,.50) "1w_2w", home qualifies, home won -> W.
    // whip (away-home): 1.30-1.22=0.08 -> [.05,.10) "1w_2w", home qualifies, home won -> W.
    // ops (home-away): .690-.680=.010 -> [0,.02) "0_1w", home qualifies, home won -> W.
    // battingAvg (home-away): .250-.240=.010 -> [.01,.02) "1w_2w" (boundary-exact, owned by the FAR bucket not 0_1w), home qualifies, home won -> W.
    {
      id: "g1", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 5, awayScore: 3,
      favTeam: "TeamA", totalLine: 8.5, gameDate: new Date("2026-06-02T23:00:00Z"),
    },
    // g2: 2026-06-06. asOf = end of 2026-06-05. Home (TeamA) LOST 2-9 - away qualifies in every stat this time.
    // ML delta = 90-20=70 -> "ge_40", fav (home) lost -> L. Total line pushed (11=11) -> excluded.
    // run_diff: -20-(-5)=-15 -> (-20,-10] "neg1w_neg2w", away qualifies, away won -> W.
    // era (away-home): 4.50-6.00=-1.50 -> <=-1.00 "le_neg4w", away qualifies, away won -> W.
    // whip (away-home): 1.30-1.60=-0.30 -> <=-0.20 "le_neg4w", away qualifies, away won -> W.
    // ops (home-away): .600-.680=-.080 -> <=-.08 "le_neg4w" (boundary-exact), away qualifies, away won -> W.
    // battingAvg (home-away): .200-.240=-.040 -> <=-.04 "le_neg4w" (boundary-exact), away qualifies, away won -> W.
    {
      id: "g2", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 2, awayScore: 9,
      favTeam: "TeamA", totalLine: 11, gameDate: new Date("2026-06-06T23:00:00Z"),
    },
    // g3: TeamC has NO snapshot rows at all, ever, in either table - must be
    // skipped entirely across all seven dimensions.
    {
      id: "g3", homeTeam: "TeamC", awayTeam: "TeamB", homeScore: 5, awayScore: 1,
      favTeam: "TeamC", totalLine: 6.5, gameDate: new Date("2026-06-02T23:00:00Z"),
    },
    // g4: 2026-05-25, before EITHER team's earliest snapshot in either table
    // (2026-06-01) - excluded from all seven dimensions.
    {
      id: "g4", homeTeam: "TeamA", awayTeam: "TeamB", homeScore: 4, awayScore: 2,
      favTeam: "TeamA", totalLine: 5.5, gameDate: new Date("2026-05-25T23:00:00Z"),
    },
  ];

  patch("gameResult.findMany", async () => games);
  patch("teamTendencySnapshot.findMany", async () => [...teamATendency, ...teamBTendency]);
  patch("teamStatSnapshot.findMany", async () => [...teamAStats, ...teamBStats]);

  const report = await computeZoneModel(SPORT);

  // ML / Total re-verified against the new dimensions[] shape
  const ml = dimension(report, "ml");
  expect("ML: only g1 and g2 contributed", ml.gamesConsidered, 2);
  expect("ML 10_to_20: g1 (30% vs 20%, NOT same-day 99%)", bucketResult(ml.buckets, "10_to_20").wins, 1);
  expect("ML ge_40: g2 (90% vs 20%) - different bucket than g1, same pair", bucketResult(ml.buckets, "ge_40").losses, 1);
  const total = dimension(report, "total");
  expect("Total: only g1 contributed (g2 pushed)", total.gamesConsidered, 1);
  expect("Total le_neg40: g1's under hit -> 1 L for the over side", bucketResult(total.buckets, "le_neg40").losses, 1);

  // Each of the five stat dimensions
  for (const key of ["run_diff", "era", "whip", "ops", "batting_avg"] as const) {
    const d = dimension(report, key);
    expect(`${key}: both g1 and g2 contributed (g3 no snapshot ever, g4 predates all snapshots)`, d.gamesConsidered, 2);
  }

  const runDiff = dimension(report, "run_diff");
  expect("run_diff 1w_2w: g1 (home +15 run diff, home won) -> W", bucketResult(runDiff.buckets, "1w_2w").wins, 1);
  expect("run_diff neg1w_neg2w: g2 (home -15 run diff edge for away, away won) -> W for the qualifying (away) side", bucketResult(runDiff.buckets, "neg1w_neg2w").wins, 1);

  const era = dimension(report, "era");
  expect("era 1w_2w: g1 uses TeamA's 06-01 ERA (4.05), NOT the same-day 06-02 value (0.01) which would have produced a huge delta in a different bucket", bucketResult(era.buckets, "1w_2w").games, 1);
  expect("era le_neg4w: g2, away(TeamB)'s better ERA qualifies, away won -> W", bucketResult(era.buckets, "le_neg4w").wins, 1);

  const whip = dimension(report, "whip");
  expect("whip 1w_2w: g1, home's better WHIP qualifies, home won -> W", bucketResult(whip.buckets, "1w_2w").wins, 1);
  expect("whip le_neg4w: g2, away's better WHIP qualifies, away won -> W", bucketResult(whip.buckets, "le_neg4w").wins, 1);

  const ops = dimension(report, "ops");
  expect("ops 0_1w: g1 (home OPS edge .010, boundary case owned by 0_1w since < 1w)", bucketResult(ops.buckets, "0_1w").wins, 1);
  expect("ops le_neg4w: g2 (away OPS edge exactly -.080, boundary-exact, owned by le_neg4w)", bucketResult(ops.buckets, "le_neg4w").wins, 1);

  const avg = dimension(report, "batting_avg");
  expect("batting_avg 1w_2w: g1 (home AVG edge exactly .010, boundary-exact, owned by 1w_2w not 0_1w)", bucketResult(avg.buckets, "1w_2w").wins, 1);
  expect("batting_avg le_neg4w: g2 (away AVG edge exactly -.040, boundary-exact, owned by le_neg4w)", bucketResult(avg.buckets, "le_neg4w").wins, 1);

  // Every dimension always reports all 10 buckets, including empty ones
  for (const key of ["ml", "total", "run_diff", "era", "whip", "ops", "batting_avg"] as const) {
    const d = dimension(report, key);
    expect(`${key}: reports exactly 10 buckets`, d.buckets.length, 10);
    const empty = d.buckets.find((b) => b.games === 0);
    if (empty) {
      expect(`${key} ${empty.bucket.id} (empty): winPct=null, never a divide-by-zero fallback like 0`, empty.winPct, null);
    }
  }

  // ---- 4. computePendingZoneGames: TODAY's current data, exact display format ----
  {
    const now = new Date();
    const future = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const past = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

    const pendingGame = {
      id: "pg1", sportKey: SPORT, homeTeam: "TeamX", awayTeam: "TeamY", commenceTime: future,
      bookmakers: [{ key: "book1", title: "Book 1", markets: [
        { key: "h2h", outcomes: [{ name: "TeamX", price: -150 }, { name: "TeamY", price: 130 }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: 8.5 }, { name: "Under", price: -110, point: 8.5 }] },
      ] }],
    };
    // Already-started game in the same snapshot - must be filtered out entirely.
    const startedGame = {
      id: "pg2", sportKey: SPORT, homeTeam: "TeamX", awayTeam: "TeamY", commenceTime: past,
      bookmakers: [{ key: "book1", title: "Book 1", markets: [
        { key: "h2h", outcomes: [{ name: "TeamX", price: -150 }, { name: "TeamY", price: 130 }] },
      ] }],
    };

    patch("oddsSnapshot.findFirst", async () => ({ data: [pendingGame, startedGame] }));
    patch("teamTendency.findMany", async () => [
      { teamName: "TeamX", favWins: 7, favLosses: 3, favPushes: 0, dogWins: 0, dogLosses: 0, dogPushes: 0, overCount: 6, underCount: 4, totalPushCount: 0 },
      { teamName: "TeamY", favWins: 0, favLosses: 0, favPushes: 0, dogWins: 4, dogLosses: 6, dogPushes: 0, overCount: 3, underCount: 7, totalPushCount: 0 },
    ]);
    patch("teamStatSnapshot.findMany", async () => [
      { teamName: "TeamX", snapshotDate: "2026-06-10", runDifferential: 25, era: 3.50, whip: 1.10, ops: 0.750, battingAvg: 0.260 },
      { teamName: "TeamY", snapshotDate: "2026-06-10", runDifferential: 5, era: 4.00, whip: 1.25, ops: 0.700, battingAvg: 0.245 },
    ]);

    const pending: PendingZoneReport = await computePendingZoneGames(SPORT);

    function pendingBucket(key: ZoneDimensionKey, bucketId: string) {
      const dim = pending.dimensions.find((d) => d.key === key);
      if (!dim) throw new Error(`pending dimension ${key} missing`);
      return dim.gamesByBucket[bucketId] ?? [];
    }

    // ML: favTeam=TeamX (70%), dog=TeamY (40%) -> delta=30 -> bucket "30_to_40".
    const mlGames = pendingBucket("ml", "30_to_40");
    expect("pending ML 30_to_40: exactly the one pending game (started game excluded)", mlGames.length, 1);
    expect("pending ML: away @ home format", `${mlGames[0]?.awayTeam} @ ${mlGames[0]?.homeTeam}`, "TeamY @ TeamX");
    expect("pending ML: delta display", mlGames[0]?.deltaDisplay, "30");
    expect("pending ML: qualifying side is always the favorite", mlGames[0]?.qualifyingSide, "TeamX");
    expect("pending ML: qualifier label", mlGames[0]?.qualifierLabel, "Fav ML");

    // Total: combined over=6+3=9, under=4+7=11, total=20 -> overRate 45%, underRate 55% -> delta=-10 -> "neg10_to_neg20".
    const totalGames = pendingBucket("total", "neg10_to_neg20");
    expect("pending Total neg10_to_neg20: the one pending game, using SUMMED counts", totalGames.length, 1);
    expect("pending Total: qualifying side is Under (delta negative), not a team", totalGames[0]?.qualifyingSide, "Under");
    expect("pending Total: delta display", totalGames[0]?.deltaDisplay, "-10");

    // run_diff: home(25)-away(5)=20 -> [20,30) "2w_3w".
    const runDiffGames = pendingBucket("run_diff", "2w_3w");
    expect("pending run_diff 2w_3w: the one pending game", runDiffGames.length, 1);
    expect("pending run_diff: qualifying side is the home team", runDiffGames[0]?.qualifyingSide, "TeamX");
    expect("pending run_diff: qualifier label", runDiffGames[0]?.qualifierLabel, "Run Diff Edge");
    expect("pending run_diff: delta display (integer, no decimal)", runDiffGames[0]?.deltaDisplay, "20");

    // era (away-home, sign-flip): 4.00-3.50=0.50 -> [.50,.75) "2w_3w".
    const eraGames = pendingBucket("era", "2w_3w");
    expect("pending era 2w_3w: the one pending game", eraGames.length, 1);
    expect("pending era: delta display, leading zero stripped (baseball convention)", eraGames[0]?.deltaDisplay, ".50");

    // whip (away-home): 1.25-1.10=0.15 -> [.15,.20) "3w_4w".
    const whipGames = pendingBucket("whip", "3w_4w");
    expect("pending whip 3w_4w: the one pending game", whipGames.length, 1);
    expect("pending whip: delta display", whipGames[0]?.deltaDisplay, ".15");

    // ops (home-away): .750-.700=.050 -> [.040,.060) "2w_3w".
    const opsGames = pendingBucket("ops", "2w_3w");
    expect("pending ops 2w_3w: the one pending game", opsGames.length, 1);
    expect("pending ops: delta display (3 decimals)", opsGames[0]?.deltaDisplay, ".050");

    // batting_avg (home-away): .260-.245=.015 -> [.010,.020) "1w_2w".
    const avgGames = pendingBucket("batting_avg", "1w_2w");
    expect("pending batting_avg 1w_2w: the one pending game", avgGames.length, 1);
    expect("pending batting_avg: delta display", avgGames[0]?.deltaDisplay, ".015");
  }

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();

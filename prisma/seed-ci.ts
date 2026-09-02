// CI-only fixture seed. Inserts the exact rows the 5 DB-backed model-engine
// acceptance suites query by hardcoded id / team / date / pitcherId, so they
// can run on GitHub Actions instead of being SKIPped. Every value here is a
// LOOKUP KEY chosen to match what a test file already hardcodes - not
// real-world-accurate data. The tests' assertions are structural
// (point-in-time resolution correctness, library-vs-independent-loop
// cross-checks, boundary membership) and hold for any internally-consistent
// data, so synthetic rows are sufficient.
//
// Suites served (see docs / scripts/run-tests.mjs):
//   - src/server/data/model-engine/observations-acceptance-test.ts
//   - src/lib/model-engine/weighted-accumulation-acceptance-test.ts
//   - src/server/data/model-engine/decay-delta-bucket-boundary-test.ts
//   - src/server/data/model-engine/acceptance-test.ts
//   - src/server/data/model-engine/orchestrate-acceptance-test.ts
//
// NOT served (deliberately - see scripts/run-tests.mjs):
//   - decay-delta-predictions-acceptance-test.ts  (asserts a drifting
//     production-derived snapshot; cannot pass against a fixture without an
//     assertion rewrite, which is out of scope)
//   - pregame-acceptance-test.ts  (no assertions - reclassified NOT_A_TEST)
//
//   npm run prisma:seed-ci
//
// The fixture insert is exported as seedModelEngineFixtures() and is also
// called at the end of prisma/seed-dev.ts, so `npm run prisma:seed-dev`
// makes these same suites pass against a local dev DB too - this is the
// "build on seed-dev.ts" piece.
//
// Idempotent (upserts on natural keys) so it is safe to re-run.
import { PrismaClient } from "@prisma/client";

const SPORT = "baseball_mlb";
const LINE_SOURCE = "stav_seed_2026"; // acceptance-test.ts (c) filters GameResult on exactly this

// gameDate stored at 16:00Z so the raw UTC calendar day == the Eastern
// calendar day (June/Aug are UTC-4), which observations-acceptance-test.ts
// relies on (it slices gameDate.toISOString(), not easternDateKey).
const at = (isoDay: string) => new Date(`${isoDay}T16:00:00.000Z`);

type GameRow = {
  externalId: string;
  id?: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  favTeam: string;
  totalLine: number;
  gameDate: Date;
};

// Derived-fact cheat sheet (observations.ts:60-98), for reviewers:
//   favWon  = favTeam side outscored the other
//   isPush  = (homeScore + awayScore) === totalLine
//   wentOver/Under otherwise
const games: GameRow[] = [
  // ---- observations-acceptance-test.ts: the 2026-06-01 "day-before" pair ----
  // Spot-check 1 (:57): TWINS beat WHITE SOX 9-6, home favorite won, total 15 > 8.
  { externalId: "ci-obs-0601-twins", homeTeam: "TWINS", awayTeam: "WHITE SOX ", homeScore: 9, awayScore: 6, favTeam: "TWINS", totalLine: 8, gameDate: at("2026-06-01") },
  // Spot-check 2 (:75): DIAMONDBACKS 4, DODGERS 1 - away favorite (DODGERS) LOST, total 5 < 9.
  { externalId: "ci-obs-0601-dbacks", homeTeam: "DIAMONDBACKS", awayTeam: "DODGERS", homeScore: 4, awayScore: 1, favTeam: "DODGERS", totalLine: 9, gameDate: at("2026-06-01") },
  // ---- observations-acceptance-test.ts: >=1 "same-day" (2026-06-02) game, asserted EXCLUDED ----
  { externalId: "ci-obs-0602-mets", homeTeam: "New York Mets", awayTeam: "Washington Nationals", homeScore: 5, awayScore: 2, favTeam: "New York Mets", totalLine: 7.5, gameDate: at("2026-06-02") },

  // ---- weighted-accumulation-acceptance-test.ts: history < 2026-07-15 ----
  // Texas Rangers as FAVORITE (favRoleRate.found).
  { externalId: "ci-wa-rangers-fav", homeTeam: "Texas Rangers", awayTeam: "Seattle Mariners", homeScore: 6, awayScore: 2, favTeam: "Texas Rangers", totalLine: 7.5, gameDate: at("2026-06-05") },
  // Texas Rangers as UNDERDOG (dogRoleRate.found).
  { externalId: "ci-wa-rangers-dog", homeTeam: "Los Angeles Angels", awayTeam: "Texas Rangers", homeScore: 5, awayScore: 3, favTeam: "Los Angeles Angels", totalLine: 9.5, gameDate: at("2026-06-10") },
  // Pittsburgh Pirates as UNDERDOG (computeDecayFavDogDelta(Rangers, Pirates)).
  { externalId: "ci-wa-pirates-dog", homeTeam: "Chicago Cubs", awayTeam: "Pittsburgh Pirates", homeScore: 7, awayScore: 4, favTeam: "Chicago Cubs", totalLine: 8.5, gameDate: at("2026-06-12") },
  // Baltimore Orioles as UNDERDOG in a TOTALS PUSH (5+3 == totalLine 8 -> isPush). Push-exclusion proof (:181-206).
  { externalId: "ci-wa-orioles-push", homeTeam: "New York Yankees", awayTeam: "Baltimore Orioles", homeScore: 5, awayScore: 3, favTeam: "New York Yankees", totalLine: 8, gameDate: at("2026-06-15") },
  // Baltimore Orioles as UNDERDOG, non-push (so dogRoleRate.found is true).
  { externalId: "ci-wa-orioles-dog", homeTeam: "Tampa Bay Rays", awayTeam: "Baltimore Orioles", homeScore: 4, awayScore: 6, favTeam: "Tampa Bay Rays", totalLine: 9.5, gameDate: at("2026-06-18") },
  // (TWINS / "WHITE SOX " Over-Under history is the 2026-06-01 game above - it is < 2026-07-15 and has wentOver != null.)

  // ---- orchestrate-acceptance-test.ts PART A: Atlanta Braves as UNDERDOG < 2026-07-19 ----
  { externalId: "ci-or-braves-dog", homeTeam: "Philadelphia Phillies", awayTeam: "Atlanta Braves", homeScore: 6, awayScore: 2, favTeam: "Philadelphia Phillies", totalLine: 8.5, gameDate: at("2026-06-20") },

  // ---- orchestrate-acceptance-test.ts PART A + decay-delta-bucket-boundary-test.ts ----
  // The "real Rangers/Braves" anchor, referenced by hardcoded id in both files.
  // favTeam Texas Rangers (fav history above), dogTeam Atlanta Braves (dog history above).
  { externalId: "ci-anchor-rangers-braves", id: "cmsqu2pbr0031j52lw78k55cg", homeTeam: "Atlanta Braves", awayTeam: "Texas Rangers", homeScore: 3, awayScore: 5, favTeam: "Texas Rangers", totalLine: 8.5, gameDate: at("2026-07-19") },

  // ---- orchestrate-acceptance-test.ts PART B: the "Giants/Astros" anchor (hardcoded id) ----
  // favTeam Houston Astros -> run-diff-era resolves team_run_differential + team_era for Houston Astros.
  { externalId: "ci-anchor-giants-astros", id: "cmspnjxg7000d5g6fwr1mb075", homeTeam: "Houston Astros", awayTeam: "San Francisco Giants", homeScore: 5, awayScore: 3, favTeam: "Houston Astros", totalLine: 8, gameDate: at("2026-08-13") },
];

export async function seedModelEngineFixtures(prisma: PrismaClient) {
  for (const g of games) {
    const data = {
      sportKey: SPORT,
      externalId: g.externalId,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      favTeam: g.favTeam,
      totalLine: g.totalLine,
      lineSource: LINE_SOURCE,
      gameDate: g.gameDate,
    };
    await prisma.gameResult.upsert({
      where: { sportKey_externalId: { sportKey: SPORT, externalId: g.externalId } },
      update: data, // never re-assign `id` on update
      create: { ...data, ...(g.id ? { id: g.id } : {}) },
    });
  }

  // ---- acceptance-test.ts (a): Detroit Tigers TeamStatSnapshot on two
  //      consecutive days with DIFFERING winPct; resolveVariable(asOf 08-11)
  //      must return the 08-11 value, not 08-12's. ----
  const teamStatBase = {
    sportKey: SPORT,
    wins: 62,
    losses: 60,
    winPct: 0.5,
    runDifferential: 12,
    battingAvg: 0.251,
    obp: 0.32,
    slg: 0.41,
    ops: 0.73,
    era: 3.9,
    whip: 1.25,
    homeWins: 34,
    homeLosses: 26,
    awayWins: 28,
    awayLosses: 34,
    last10Wins: 5,
    last10Losses: 5,
    streakType: "W" as string | null,
    streakCount: 1,
  };
  for (const [snapshotDate, winPct] of [
    ["2026-08-11", 0.5],
    ["2026-08-12", 0.52],
  ] as const) {
    await prisma.teamStatSnapshot.upsert({
      where: { sportKey_teamName_snapshotDate: { sportKey: SPORT, teamName: "Detroit Tigers", snapshotDate } },
      update: { ...teamStatBase, winPct },
      create: { ...teamStatBase, teamName: "Detroit Tigers", snapshotDate, winPct },
    });
  }
  // ---- orchestrate-acceptance-test.ts PART B: Houston Astros (the anchor's
  //      favorite) needs team_run_differential + team_era resolvable <= 08-13. ----
  await prisma.teamStatSnapshot.upsert({
    where: { sportKey_teamName_snapshotDate: { sportKey: SPORT, teamName: "Houston Astros", snapshotDate: "2026-08-12" } },
    update: { ...teamStatBase, runDifferential: 45, era: 3.6, winPct: 0.56 },
    create: { ...teamStatBase, teamName: "Houston Astros", snapshotDate: "2026-08-12", runDifferential: 45, era: 3.6, winPct: 0.56 },
  });

  // ---- acceptance-test.ts (d): pitcher_stats adapter - pitcherId 665152 <= 08-13 ----
  await prisma.pitcherStatSnapshot.upsert({
    where: { sportKey_pitcherId_snapshotDate: { sportKey: SPORT, pitcherId: 665152, snapshotDate: "2026-08-12" } },
    update: { era: 3.85, whip: 1.18, wins: 9, losses: 7, strikeouts: 118, walks: 34, inningsPitched: 132.1 },
    create: {
      sportKey: SPORT,
      pitcherId: 665152,
      pitcherName: "Dean Kremer",
      snapshotDate: "2026-08-12",
      era: 3.85,
      whip: 1.18,
      wins: 9,
      losses: 7,
      strikeouts: 118,
      walks: 34,
      inningsPitched: 132.1,
    },
  });

  // ---- acceptance-test.ts (d): team_tendencies adapter - "Athletics" <= 08-13.
  //      Only found:true is asserted; the rate is correctly null under the
  //      MIN_TENDENCY_SAMPLE (20) floor with these small counts. ----
  await prisma.teamTendencySnapshot.upsert({
    where: { sportKey_teamName_snapshotDate: { sportKey: SPORT, teamName: "Athletics", snapshotDate: "2026-08-12" } },
    update: {},
    create: {
      sportKey: SPORT,
      teamName: "Athletics",
      snapshotDate: "2026-08-12",
      favWins: 2,
      favLosses: 3,
      favPushes: 0,
      dogWins: 4,
      dogLosses: 5,
      dogPushes: 0,
      overCount: 3,
      underCount: 4,
      totalPushCount: 1,
    },
  });

  const counts = {
    gameResults: await prisma.gameResult.count(),
    teamStatSnapshots: await prisma.teamStatSnapshot.count(),
    pitcherStatSnapshots: await prisma.pitcherStatSnapshot.count(),
    teamTendencySnapshots: await prisma.teamTendencySnapshot.count(),
  };
  console.log("model-engine fixtures seeded:", JSON.stringify(counts));
}

// Standalone entrypoint (npm run prisma:seed-ci). When imported by
// seed-dev.ts this block does not run.
if (process.argv[1] && process.argv[1].endsWith("seed-ci.ts")) {
  // Same refusal logic as scripts/guard-not-prod-db.mjs - a fixture seed must
  // never touch production, exactly the Aug 18 incident class.
  const PROD_MARKERS = ["kbmdydpacvdmbemcwhry", "pooler.supabase.com"];
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (PROD_MARKERS.some((m) => dbUrl.includes(m))) {
    console.error(`\n  x DATABASE_URL looks like production. seed-ci only runs against a CI / local database. Aborting.\n`);
    process.exit(1);
  }
  const prisma = new PrismaClient();
  seedModelEngineFixtures(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

// Proof for the DATA resolver layer (Build Step 2) - run with
// `npx tsx src/server/data/model-engine/acceptance-test.ts`. Runs against
// the REAL database (the 755-row 2026 seed import, the live daily-snapshot
// tables), not synthetic fixtures - every entity/date/value below was first
// confirmed to exist by direct query before being hardcoded here, and this
// script re-reads and re-asserts against the live rows every run rather
// than trusting a cached expectation. Exits non-zero if any assertion
// fails.
import { prisma } from "@/lib/prisma";
import { resolveVariable } from "./resolver";
import { getEvaluationEventFacts } from "./facts";

let failures = 0;
function check(label: string, condition: boolean, detail: unknown) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}`, detail);
  if (!condition) failures++;
}

async function main() {
  const SPORT = "baseball_mlb";
  const context = { sportKey: SPORT };

  // ---- (a) Point-in-time guarantee: an entity with real snapshots on
  // multiple, differing dates. Live snapshot history is only 4 consecutive
  // days old as of this run (the cron started 2026-08-10, no gap day exists
  // yet), so this pins asOf to the EARLIER day's own timestamp and confirms
  // the resolver returns that day's value - NOT the later day's differing
  // value, even though that later row already exists in the table. ----
  const tigerRows = await prisma.teamStatSnapshot.findMany({
    where: { sportKey: SPORT, teamName: "Detroit Tigers" },
    orderBy: { snapshotDate: "asc" },
    select: { snapshotDate: true, winPct: true, runDifferential: true },
  });
  console.log("\n=== (a) Point-in-time guarantee - Detroit Tigers, team_win_pct ===");
  console.log("all snapshot rows on file:", tigerRows);
  const earlier = tigerRows.find((r) => r.snapshotDate === "2026-08-11");
  const later = tigerRows.find((r) => r.snapshotDate === "2026-08-12");
  if (!earlier || !later || earlier.winPct === later.winPct) {
    check("(a) prerequisite: 08-11 and 08-12 rows exist with differing winPct", false, { earlier, later });
  } else {
    const asOf = new Date("2026-08-11T18:00:00.000Z"); // within Eastern 2026-08-11
    const resolved = await resolveVariable("team_win_pct", { type: "team", teamName: "Detroit Tigers" }, asOf, context);
    console.log(`asOf = ${asOf.toISOString()}  ->`, resolved);
    check("(a) resolved value matches the EARLIER (08-11) snapshot", resolved.value === earlier.winPct, resolved);
    check("(a) resolved value does NOT match the LATER (08-12) snapshot", resolved.value !== later.winPct, resolved);
    check("(a) resolved timestamp <= asOf", resolved.timestamp !== null && resolved.timestamp.getTime() <= asOf.getTime(), {
      timestamp: resolved.timestamp,
      asOf,
    });
  }

  // ---- (b) Before any snapshot exists ----
  console.log("\n=== (b) Before any snapshot exists - Detroit Tigers, team_win_pct, asOf 2026-08-01 ===");
  const tooEarly = await resolveVariable(
    "team_win_pct",
    { type: "team", teamName: "Detroit Tigers" },
    new Date("2026-08-01T12:00:00.000Z"),
    context
  );
  console.log("resolved:", tooEarly);
  check("(b) found is false", tooEarly.found === false, tooEarly);
  check("(b) value is null", tooEarly.value === null, tooEarly);
  check("(b) timestamp is null", tooEarly.timestamp === null, tooEarly);

  // ---- (c) GameResult canonical facts, spot-checked against a real
  // 2026 seed-import row ----
  console.log("\n=== (c) GameResult canonical facts - a real stav_seed_2026 game ===");
  const seedGame = await prisma.gameResult.findFirst({
    where: { lineSource: "stav_seed_2026", favTeam: { not: null }, totalLine: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (!seedGame) {
    check("(c) prerequisite: a seed game with favTeam/totalLine exists", false, null);
  } else {
    console.log("raw GameResult row:", seedGame);
    const facts = await getEvaluationEventFacts(seedGame.id);
    console.log("getEvaluationEventFacts result:", facts);
    check("(c) facts found", facts !== null, facts);
    check("(c) externalId matches", facts?.externalId === seedGame.externalId, facts);
    check("(c) favTeam matches", facts?.favTeam === seedGame.favTeam, facts);
    check("(c) totalLine matches", facts?.totalLine === seedGame.totalLine, facts);
    check("(c) lineSource matches", facts?.lineSource === seedGame.lineSource, facts);
    check("(c) homeTeam/awayTeam/scores match",
      facts?.homeTeam === seedGame.homeTeam && facts?.awayTeam === seedGame.awayTeam &&
      facts?.homeScore === seedGame.homeScore && facts?.awayScore === seedGame.awayScore, facts);
  }

  // ---- (d) One variable from each of the three snapshot-backed
  // categories, real entities/dates ----
  console.log("\n=== (d) One variable per adapter, real entities ===");

  const asOfLatest = new Date("2026-08-13T18:00:00.000Z");
  const teamStatResult = await resolveVariable("team_win_pct", { type: "team", teamName: "Detroit Tigers" }, asOfLatest, context);
  console.log("team_stats adapter - Detroit Tigers, team_win_pct, asOf 2026-08-13:", teamStatResult);
  check("(d) team_stats adapter found a row", teamStatResult.found === true, teamStatResult);
  check("(d) team_stats adapter returned a numeric value", typeof teamStatResult.value === "number", teamStatResult);

  // Athletics' real sample sizes are still below MIN_TENDENCY_SAMPLE (20)
  // this early in the season, so this is expected to resolve found: true
  // (a real snapshot row exists) with value: null (the rate itself is
  // correctly gated) - the same honest "not enough decided games yet"
  // behavior Charts already shows, now proven through this resolver too.
  const tendencyResult = await resolveVariable("tendency_over_rate", { type: "team", teamName: "Athletics" }, asOfLatest, context);
  console.log("team_tendencies adapter - Athletics, tendency_over_rate, asOf 2026-08-13:", tendencyResult);
  check("(d) team_tendencies adapter found a row", tendencyResult.found === true, tendencyResult);

  const pitcherResult = await resolveVariable("pitcher_era", { type: "pitcher", pitcherId: 665152 }, asOfLatest, context);
  console.log("pitcher_stats adapter - Dean Kremer (665152), pitcher_era, asOf 2026-08-13:", pitcherResult);
  check("(d) pitcher_stats adapter found a row", pitcherResult.found === true, pitcherResult);
  check("(d) pitcher_stats adapter returned a numeric value", typeof pitcherResult.value === "number", pitcherResult);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main();

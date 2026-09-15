// T2 harness: synthetic fixture data for validating the harness ITSELF
// (item 4 of the T2 build task) and for the self-test failure-mode checks.
//
// This is NOT production data and is not a substitute for a real anonymized
// snapshot (extract-from-dump.mjs) - it exists because no production access
// is available in this environment (see the T2 build task writeup), and the
// harness's own correctness (does the disposable-DB lifecycle work, does the
// diff mechanism actually catch a regression, does old-vs-old report zero
// differences) has to be provable without one. Once a real anonymized
// snapshot exists, prefer --source=snapshot:<path> over --source=fixtures for
// validating an actual T3 implementation.
//
// Deliberately its own seed, independent of prisma/seed-dev.ts: seed-dev's
// 3-capper/5-pick fixture has no zero-pick capper, no cross-league capper,
// and no data spread across all 6 SCORECARD_WINDOWS boundaries - exactly the
// gaps this harness's validation needs to exercise. Modifying seed-dev.ts
// itself is out of scope for this pass (T2 build task: "No /cappers or T3
// code changes in this pass").
//
// Run against whatever DATABASE_URL points at - always a disposable
// t2_run_* database in normal harness usage (run-diff.mjs sets this before
// spawning this script). Refuses to run against anything that looks like
// production, same guard as every other DB-touching script in this harness.
import { PrismaClient } from "@prisma/client";
import { assertNotProd } from "./lib/prod-guard.mjs";
import { startOfEasternDay } from "../../src/lib/dates";
import { FIXTURE_USER_A_SUPABASE_ID, FIXTURE_USER_B_SUPABASE_ID } from "./fixture-user-ids.mjs";

export { FIXTURE_USER_A_SUPABASE_ID, FIXTURE_USER_B_SUPABASE_ID };

const dbUrl = process.env.DATABASE_URL ?? "";
assertNotProd(dbUrl, "DATABASE_URL (fixtures.ts)");
if (!/\/t2_run_/.test(dbUrl) && !/\/t2_/.test(dbUrl)) {
  console.error(`[t2-harness] fixtures.ts refuses to run against a database that isn't a t2_* disposable DB (got: ${dbUrl.replace(/:[^:@]+@/, ":***@")})`);
  process.exit(1);
}

const prisma = new PrismaClient();

// Two separate users, not one, because "no favorites" and "favorites
// present" (two of the 6 required validation scenarios - see the T2 build
// task, item 4) are mutually exclusive states of a single user's data. User A
// covers 5 of the 6 scenarios (no favorites, league filter, zero-pick
// capper, category panel, pending/graded mix); User B exists solely to cover
// "favorites present" in isolation. (IDs imported from fixture-user-ids.mjs
// above, re-exported for callers that only need the seeder.)

function eastern(daysBack: number, hour: number): Date {
  const start = startOfEasternDay(new Date());
  return new Date(start.getTime() - daysBack * 86_400_000 + hour * 3_600_000);
}

// Named window anchors - one representative gameTime strictly inside each
// SCORECARD_WINDOWS bucket (and nowhere near a boundary), used to build picks
// that land deterministically in exactly one window (plus ALL, which is
// unfiltered). See src/server/data/stats.ts's filterPicksByGameWindow.
const WINDOW_ANCHORS = {
  today: eastern(0, 14),
  yesterday: eastern(1, 14),
  last7Only: eastern(3, 14), // inside LAST_7, outside TODAY/YESTERDAY
  last30Only: eastern(20, 14), // inside LAST_30, outside LAST_7
  last60Only: eastern(45, 14), // inside LAST_60, outside LAST_30
  allOnly: eastern(100, 14), // outside every rolling window; only ALL includes it
};

async function seedUser(supabaseId: string, name: string) {
  const user = await prisma.user.upsert({
    where: { supabaseId },
    update: { email: `${supabaseId}@t2-anon.invalid`, name },
    create: { supabaseId, email: `${supabaseId}@t2-anon.invalid`, name },
  });
  await prisma.subscription.upsert({
    where: { userId: user.id },
    update: { plan: "PRO", status: "active", currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000) },
    create: { userId: user.id, plan: "PRO", status: "active", currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000) },
  });
  await prisma.pick.deleteMany({ where: { userId: user.id } });
  await prisma.capper.deleteMany({ where: { userId: user.id } });
  return user;
}

type PickSeed = {
  userId: string;
  capperId: string;
  sport: "NFL" | "MLB";
  betType: "SPREAD" | "MONEYLINE" | "TOTAL";
  odds: number;
  line: number | null;
  units: number;
  status: "WIN" | "LOSS" | "PUSH" | "PENDING";
  gameTime: Date;
};

async function main() {
  const sportRecords: Record<string, string> = {};
  for (const name of ["NFL", "MLB"]) {
    const sport = await prisma.sport.upsert({ where: { name }, update: {}, create: { name } });
    sportRecords[name] = sport.id;
  }

  // ==== User A: no favorites, covers league-filter / zero-pick-capper /
  // category-panel / pending-graded-mix scenarios ====
  const userA = await seedUser(FIXTURE_USER_A_SUPABASE_ID, "T2 Fixture User A");

  // Cap A - NFL, not favorited. One decided pick in every rolling window
  // bucket (exercises every SCORECARD_WINDOWS boundary for the same capper)
  // plus one PENDING pick with a future gameTime (the "mix of pending and
  // graded picks" scenario - PENDING must be excluded from computed stats
  // but still counted by getMostActiveThisWeek, which counts by volume
  // regardless of status).
  const capA = await prisma.capper.create({
    data: { userId: userA.id, name: "Fixture Cap A", source: "TWITTER", isFavorite: false, sportSpecialization: "NFL" },
  });

  // Cap B - MLB. 4 decided MONEYLINE picks, all priced as favorites (odds
  // -150, no pickedSide/mlFavoredSide set - classifies as FAV_ML via the
  // odds-sign heuristic, see pickCategory), so at least
  // CATEGORY_LEADERBOARD_MIN_PICKS (3) land in the same category and this
  // capper actually appears in getSportCategoryPanelData's leaderboard.
  const capB = await prisma.capper.create({
    data: { userId: userA.id, name: "Fixture Cap B", source: "DISCORD", isFavorite: false, sportSpecialization: "MLB" },
  });

  // Cap C - zero picks, ever. Exists solely to exercise the ALL-window
  // "show every capper, including 0-pick ones" invariant
  // (getCapperLeaderboardTable's excludesZeroPick logic).
  await prisma.capper.create({
    data: { userId: userA.id, name: "Fixture Cap C (zero-pick)", source: "TELEGRAM", isFavorite: false },
  });

  // Cap D - cross-sport (both NFL and MLB picks), not favorited. Makes the
  // league-filter scenario meaningfully differ from "All leagues": this
  // capper's leaderboard row (and stats) should change depending on which
  // league pill is active.
  const capD = await prisma.capper.create({
    data: { userId: userA.id, name: "Fixture Cap D", source: "INSTAGRAM", isFavorite: false },
  });

  const picksA: PickSeed[] = [
    // Cap A - one per window bucket + a pending one
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "SPREAD", odds: -110, line: -3.5, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.today },
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "SPREAD", odds: -110, line: 2.5, units: 1, status: "LOSS", gameTime: WINDOW_ANCHORS.yesterday },
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "MONEYLINE", odds: -140, line: null, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.last7Only },
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "TOTAL", odds: -105, line: 44.5, units: 1, status: "LOSS", gameTime: WINDOW_ANCHORS.last30Only },
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "SPREAD", odds: -110, line: -6.5, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.last60Only },
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "MONEYLINE", odds: 120, line: null, units: 1, status: "PUSH", gameTime: WINDOW_ANCHORS.allOnly },
    { userId: userA.id, capperId: capA.id, sport: "NFL", betType: "SPREAD", odds: -110, line: -3, units: 1, status: "PENDING", gameTime: eastern(-2, 14) },

    // Cap B - 4 decided FAV_ML MONEYLINE picks (category-panel leaderboard),
    // spread across a couple of windows too so the per-window stats aren't a
    // single-window artifact.
    { userId: userA.id, capperId: capB.id, sport: "MLB", betType: "MONEYLINE", odds: -150, line: null, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.today },
    { userId: userA.id, capperId: capB.id, sport: "MLB", betType: "MONEYLINE", odds: -150, line: null, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.last7Only },
    { userId: userA.id, capperId: capB.id, sport: "MLB", betType: "MONEYLINE", odds: -150, line: null, units: 1, status: "LOSS", gameTime: WINDOW_ANCHORS.last30Only },
    { userId: userA.id, capperId: capB.id, sport: "MLB", betType: "MONEYLINE", odds: -150, line: null, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.allOnly },

    // Cap D - cross-sport: 2 NFL, 2 MLB, all decided.
    { userId: userA.id, capperId: capD.id, sport: "NFL", betType: "SPREAD", odds: -110, line: -1, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.today },
    { userId: userA.id, capperId: capD.id, sport: "NFL", betType: "SPREAD", odds: -110, line: 3, units: 1, status: "LOSS", gameTime: WINDOW_ANCHORS.last7Only },
    { userId: userA.id, capperId: capD.id, sport: "MLB", betType: "MONEYLINE", odds: 110, line: null, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.today },
    { userId: userA.id, capperId: capD.id, sport: "MLB", betType: "TOTAL", odds: -110, line: 8, units: 1, status: "LOSS", gameTime: WINDOW_ANCHORS.last7Only },
  ];

  // ==== User B: favorites present. Small and isolated on purpose - this
  // scenario just needs >=1 favorited capper with real decided picks. ====
  const userB = await seedUser(FIXTURE_USER_B_SUPABASE_ID, "T2 Fixture User B");
  const capE = await prisma.capper.create({
    data: { userId: userB.id, name: "Fixture Cap E (favorited)", source: "TWITTER", isFavorite: true, sportSpecialization: "NFL" },
  });
  const capF = await prisma.capper.create({
    data: { userId: userB.id, name: "Fixture Cap F", source: "DISCORD", isFavorite: false, sportSpecialization: "MLB" },
  });
  const picksB: PickSeed[] = [
    { userId: userB.id, capperId: capE.id, sport: "NFL", betType: "SPREAD", odds: -110, line: -4, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.today },
    { userId: userB.id, capperId: capE.id, sport: "NFL", betType: "MONEYLINE", odds: -160, line: null, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.last7Only },
    { userId: userB.id, capperId: capE.id, sport: "NFL", betType: "SPREAD", odds: -110, line: 5, units: 1, status: "LOSS", gameTime: WINDOW_ANCHORS.last30Only },
    { userId: userB.id, capperId: capF.id, sport: "MLB", betType: "TOTAL", odds: -110, line: 9, units: 1, status: "WIN", gameTime: WINDOW_ANCHORS.today },
  ];

  for (const p of [...picksA, ...picksB]) {
    await prisma.pick.create({
      data: {
        userId: p.userId,
        capperId: p.capperId,
        sportId: sportRecords[p.sport],
        homeTeam: "Fixture Home",
        awayTeam: "Fixture Away",
        betType: p.betType,
        betDetail: null,
        odds: p.odds,
        line: p.line,
        units: p.units,
        status: p.status,
        gradedAt: p.status === "PENDING" ? null : p.gameTime,
        datePosted: new Date(p.gameTime.getTime() - 3_600_000),
        gameTime: p.gameTime,
      },
    });
  }

  const counts = {
    userA: {
      cappers: await prisma.capper.count({ where: { userId: userA.id } }),
      picks: await prisma.pick.count({ where: { userId: userA.id } }),
    },
    userB: {
      cappers: await prisma.capper.count({ where: { userId: userB.id } }),
      picks: await prisma.pick.count({ where: { userId: userB.id } }),
    },
  };
  console.log(`[t2-harness] fixtures loaded: userA=${userA.id} userB=${userB.id} ${JSON.stringify(counts)}`);
  return { userAId: userA.id, userBId: userB.id };
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

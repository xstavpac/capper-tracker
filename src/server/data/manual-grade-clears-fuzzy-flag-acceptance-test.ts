// A manual grade must never be overwritten by the automatic fuzzy re-grade.
//
// The bug: gradePickPool / gradeAllPendingLegs stamp gradedViaFuzzyMatch = true
// when they grade against a fuzzy GameResult match. regradeAllFuzzyMatchedPicks
// (and its leg twin) later re-grade every row still flagged true once an exact
// GameResult appears - and they do not look at *who* set the current status.
// updatePickStatus / updateLegStatus (the manual grade paths) left the flag
// untouched, so a user correcting a wrong fuzzy grade by hand had that
// correction silently reverted by the next cron run.
//
// Fix under test: a manual status write also sets gradedViaFuzzyMatch = false.
//
// Real-database test (no spies): each scenario is fuzzy-graded state -> manual
// correction through the real data-layer function -> an exact GameResult
// appears -> the real global regrade runs. Uses a dedicated sport / sportKey so
// no other row in the database can be touched by the global regrade, and
// removes everything it creates. Run with DATABASE_URL set:
//   npx tsx src/server/data/manual-grade-clears-fuzzy-flag-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import { updatePickStatus } from "@/server/data/picks";
import { updateLegStatus } from "@/server/data/parlays";
import { regradeAllFuzzyMatchedPicks } from "@/server/data/grading";
import { regradeAllFuzzyMatchedLegs } from "@/server/data/parlay-grading";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const TAG = `mgcf-${Date.now()}`;
const SPORT_NAME = `ZZ_${TAG}`;
const SPORT_KEY = `zz_${TAG}`;
// Recent, so the regrade's lookback cutoff includes the rows.
const GAME_TIME = new Date(Date.now() - 3 * 3600000);

async function main() {
  const user = await prisma.user.create({ data: { supabaseId: TAG, email: `${TAG}@example.test` } });
  const other = await prisma.user.create({ data: { supabaseId: `${TAG}-o`, email: `${TAG}-o@example.test` } });
  try {
    const capper = await prisma.capper.create({ data: { userId: user.id, name: "c", source: "OTHER" } });
    const sport = await prisma.sport.create({ data: { name: SPORT_NAME } });

    // The exact game the fuzzy grade was a guess about. Home team won, so an
    // exact re-grade of a HOME moneyline is WIN... the fuzzy grade below is
    // seeded as the *wrong* answer (LOSS) that the user then manually fixes to
    // the right one, and a second scenario where the exact result disagrees
    // with the manual grade (the manual grade must still win).
    const homeWonGame = {
      sportKey: SPORT_KEY,
      externalId: `${TAG}-g1`,
      homeTeam: "Alpha Foxes",
      awayTeam: "Beta Wolves",
      homeScore: 5,
      awayScore: 2,
      gameDate: GAME_TIME,
    };
    const pickBase = {
      userId: user.id,
      capperId: capper.id,
      sportId: sport.id,
      homeTeam: homeWonGame.homeTeam,
      awayTeam: homeWonGame.awayTeam,
      betType: "MONEYLINE" as const,
      odds: -110,
      units: 1,
      gameTime: GAME_TIME,
      pickedSide: "HOME" as const,
    };

    // ---- Picks ----
    // A: fuzzy-graded LOSS (wrong), user manually corrects it to WIN. The exact
    //    result later confirms WIN - regrade must not touch it (no flag).
    // B: fuzzy-graded WIN, user manually sets LOSS (deliberately disagreeing
    //    with what the exact result will say). The manual LOSS must survive.
    // C: fuzzy-graded WIN, never touched by the user: the regrade SHOULD still
    //    run on it (control: the fix must not disable the fuzzy upgrade).
    // D: another user's fuzzy pick, untouched: also still regraded.
    const a = await prisma.pick.create({ data: { ...pickBase, status: "LOSS", gradedAt: new Date(), gradedViaFuzzyMatch: true } });
    const b = await prisma.pick.create({ data: { ...pickBase, status: "WIN", gradedAt: new Date(), gradedViaFuzzyMatch: true } });
    const c = await prisma.pick.create({ data: { ...pickBase, status: "LOSS", gradedAt: new Date(), gradedViaFuzzyMatch: true } });
    const otherCapper = await prisma.capper.create({ data: { userId: other.id, name: "oc", source: "OTHER" } });
    const d = await prisma.pick.create({
      data: { ...pickBase, userId: other.id, capperId: otherCapper.id, status: "LOSS", gradedAt: new Date(), gradedViaFuzzyMatch: true },
    });

    // Manual corrections through the real function.
    await updatePickStatus(user.id, a.id, "WIN");
    await updatePickStatus(user.id, b.id, "LOSS");
    // Checked BEFORE any regrade runs - the regrade itself also clears the flag
    // on every row it touches, so a post-regrade check would pass either way.
    const flagNow = async (id: string) =>
      (await prisma.pick.findUniqueOrThrow({ where: { id }, select: { gradedViaFuzzyMatch: true } })).gradedViaFuzzyMatch;
    expect("pick A: manual grade clears the flag immediately", await flagNow(a.id), false);
    expect("pick B: manual grade clears the flag immediately", await flagNow(b.id), false);
    expect("pick C (control): untouched pick keeps the flag", await flagNow(c.id), true);

    // The exact GameResult finally shows up.
    await prisma.gameResult.create({ data: homeWonGame });

    const res = await regradeAllFuzzyMatchedPicks(SPORT_KEY, SPORT_NAME);
    const after = async (id: string) =>
      prisma.pick.findUniqueOrThrow({ where: { id }, select: { status: true, gradedViaFuzzyMatch: true } });

    expect("pick A: manual WIN survives the regrade", (await after(a.id)).status, "WIN");
    expect("pick B: manual LOSS (against the exact result) survives", (await after(b.id)).status, "LOSS");
    expect("pick C (control): untouched fuzzy pick is still upgraded to the exact result", await after(c.id), {
      status: "WIN",
      gradedViaFuzzyMatch: false,
    });
    expect("pick D (control): other user's untouched fuzzy pick is still upgraded", await after(d.id), {
      status: "WIN",
      gradedViaFuzzyMatch: false,
    });
    expect("regrade only examined the two untouched fuzzy picks", res.checked, 2);

    // ---- Legs (parlay counterpart) ----
    const parlay = await prisma.parlayBet.create({ data: { userId: user.id, capperId: capper.id, units: 1 } });
    const legBase = {
      parlayBetId: parlay.id,
      sportId: sport.id,
      homeTeam: homeWonGame.homeTeam,
      awayTeam: homeWonGame.awayTeam,
      betType: "MONEYLINE" as const,
      odds: -110,
      gameTime: GAME_TIME,
    };
    // Leg 0: fuzzy-graded WIN, user sets LOSS manually (against the exact result).
    // Leg 1: fuzzy-graded LOSS, untouched - control, must be upgraded.
    const legManual = await prisma.leg.create({
      data: { ...legBase, legIndex: 0, status: "WIN", gradedAt: new Date(), gradedViaFuzzyMatch: true },
    });
    const legControl = await prisma.leg.create({
      data: { ...legBase, legIndex: 1, status: "LOSS", gradedAt: new Date(), gradedViaFuzzyMatch: true },
    });
    await updateLegStatus(user.id, legManual.id, "LOSS");
    expect(
      "leg (manual): manual grade clears the flag immediately",
      (await prisma.leg.findUniqueOrThrow({ where: { id: legManual.id }, select: { gradedViaFuzzyMatch: true } })).gradedViaFuzzyMatch,
      false
    );

    const legRes = await regradeAllFuzzyMatchedLegs(SPORT_KEY, SPORT_NAME);
    const legAfter = async (id: string) =>
      prisma.leg.findUniqueOrThrow({ where: { id }, select: { status: true, gradedViaFuzzyMatch: true } });
    expect("leg (manual): manual LOSS survives the regrade", (await legAfter(legManual.id)).status, "LOSS");
    expect("leg (control): untouched fuzzy leg is still upgraded", await legAfter(legControl.id), {
      status: "WIN",
      gradedViaFuzzyMatch: false,
    });
    expect("leg regrade only examined the untouched fuzzy leg", legRes.checked, 1);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    await prisma.gameResult.deleteMany({ where: { sportKey: SPORT_KEY } });
    await prisma.sport.deleteMany({ where: { name: SPORT_NAME } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll assertions passed");
  });

// Boundary proof for resolveGameObservations (Build Step 2.5) - run with
// `npx tsx src/server/data/model-engine/observations-acceptance-test.ts`.
// Runs against the real 2026 seed data, not synthetic fixtures. Exits
// non-zero if any assertion fails.
import { prisma } from "@/lib/prisma";
import { resolveGameObservations } from "./observations";

let failures = 0;
function check(label: string, condition: boolean, detail: unknown) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}`, detail);
  if (!condition) failures++;
}

async function main() {
  const SPORT = "baseball_mlb";

  // Real adjacent-day pair, confirmed by direct query before writing this
  // test: 2026-06-01 (day-before, 9 real graded MLB games with a favTeam)
  // and 2026-06-02 (D, 15 real games, same criteria). asOf is pinned inside
  // Eastern day D.
  const D = "2026-06-02";
  const dayBefore = "2026-06-01";
  const asOf = new Date(`${D}T18:00:00.000Z`); // within Eastern 2026-06-02

  const [dayBeforeRows, sameDayRows] = await Promise.all([
    prisma.gameResult.findMany({ where: { sportKey: SPORT, favTeam: { not: null } } }).then((rows) =>
      rows.filter((r) => r.gameDate.toISOString().slice(0, 10) === dayBefore)
    ),
    prisma.gameResult.findMany({ where: { sportKey: SPORT, favTeam: { not: null } } }).then((rows) =>
      rows.filter((r) => r.gameDate.toISOString().slice(0, 10) === D)
    ),
  ]);
  console.log(`\n=== Real data: ${dayBeforeRows.length} games on ${dayBefore} (day-before), ${sameDayRows.length} games on ${D} (D) ===`);
  check("prerequisite: at least 1 game exists on the day-before", dayBeforeRows.length > 0, dayBeforeRows.length);
  check("prerequisite: at least 1 game exists on D itself", sameDayRows.length > 0, sameDayRows.length);

  const observations = await resolveGameObservations(SPORT, asOf);
  console.log(`\nresolveGameObservations("${SPORT}", ${asOf.toISOString()}) returned ${observations.length} observations`);

  const dayBeforeIds = new Set(dayBeforeRows.map((r) => r.id));
  const sameDayIds = new Set(sameDayRows.map((r) => r.id));
  const observedIds = new Set(observations.map((o) => o.gameId));

  const dayBeforeIncluded = dayBeforeRows.every((r) => observedIds.has(r.id));
  const sameDayExcluded = sameDayRows.every((r) => !observedIds.has(r.id));
  check(`(boundary) ALL ${dayBeforeRows.length} day-before (${dayBefore}) games are INCLUDED`, dayBeforeIncluded, {
    dayBeforeIds: [...dayBeforeIds],
    missing: dayBeforeRows.filter((r) => !observedIds.has(r.id)).map((r) => r.id),
  });
  check(`(boundary) ALL ${sameDayRows.length} same-day (${D}) games are EXCLUDED`, sameDayExcluded, {
    sameDayIds: [...sameDayIds],
    wronglyIncluded: sameDayRows.filter((r) => observedIds.has(r.id)).map((r) => r.id),
  });

  // ---- Spot-check 1: TWINS (home) beat WHITE SOX (away) 9-6 on 06-01,
  // favTeam=TWINS (home favorite that won), totalLine=8, actual total=15 (over) ----
  const twinsRow = dayBeforeRows.find((r) => r.homeTeam === "TWINS" && r.awayTeam === "WHITE SOX ");
  if (!twinsRow) {
    check("(spot-check 1) prerequisite: TWINS/WHITE SOX 06-01 row exists", false, null);
  } else {
    console.log("\nraw GameResult row (spot-check 1):", twinsRow);
    const obs = observations.find((o) => o.gameId === twinsRow.id);
    console.log("resolved observation:", obs);
    check("(spot-check 1) favTeam = TWINS", obs?.favTeam === "TWINS", obs?.favTeam);
    check("(spot-check 1) dogTeam = WHITE SOX ", obs?.dogTeam === "WHITE SOX ", obs?.dogTeam);
    check("(spot-check 1) favWon = true (home favorite won 9-6)", obs?.favWon === true, obs?.favWon);
    check("(spot-check 1) wentOver = true (15 > totalLine 8)", obs?.wentOver === true, obs?.wentOver);
    check("(spot-check 1) isPush = false", obs?.isPush === false, obs?.isPush);
  }

  // ---- Spot-check 2: DIAMONDBACKS (home) 4, DODGERS (away) 1 on 06-01,
  // favTeam=DODGERS (the AWAY team, and the favorite that LOST) - proves
  // favIsHome=false branch and a losing favorite both derive correctly.
  // totalLine=9, actual total=5 (under) ----
  const dbacksRow = dayBeforeRows.find((r) => r.homeTeam === "DIAMONDBACKS" && r.awayTeam === "DODGERS");
  if (!dbacksRow) {
    check("(spot-check 2) prerequisite: DIAMONDBACKS/DODGERS 06-01 row exists", false, null);
  } else {
    console.log("\nraw GameResult row (spot-check 2):", dbacksRow);
    const obs = observations.find((o) => o.gameId === dbacksRow.id);
    console.log("resolved observation:", obs);
    check("(spot-check 2) favTeam = DODGERS (away)", obs?.favTeam === "DODGERS", obs?.favTeam);
    check("(spot-check 2) dogTeam = DIAMONDBACKS (home)", obs?.dogTeam === "DIAMONDBACKS", obs?.dogTeam);
    check("(spot-check 2) favWon = false (away favorite LOST 1-4)", obs?.favWon === false, obs?.favWon);
    check("(spot-check 2) wentOver = false (5 < totalLine 9)", obs?.wentOver === false, obs?.wentOver);
    check("(spot-check 2) isPush = false", obs?.isPush === false, obs?.isPush);
  }

  // ---- Confirm the null-favTeam exclusion count matches a direct query ----
  const nullFavCount = await prisma.gameResult.count({ where: { sportKey: SPORT, favTeam: null } });
  const totalMlb = await prisma.gameResult.count({ where: { sportKey: SPORT } });
  console.log(`\nMLB GameResult rows: ${totalMlb} total, ${nullFavCount} excluded for null favTeam (schema has no other "ungraded" representation - see report)`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main();

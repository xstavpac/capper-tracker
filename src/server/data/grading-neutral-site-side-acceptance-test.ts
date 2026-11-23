// Regression proof for neutral-site picks graded on the WRONG TEAM (follow-up to #521).
//
// A pick row stores the home/away of the feed that resolved it at import (here the Odds API), and pickedSide is
// recorded against THOSE teams. The final score row (game_results, from ESPN) can list the same two teams the other
// way round at a neutral site. matchGameResult's exact branch then finds nothing and its fuzzy fallback returns the
// reversed row - and resolveOutcome used to apply pickedSide by POSITION on it, grading the other team.
//
// Now pickedSide is first a team (the pick row's own homeTeam/awayTeam) and that team is found on the score row by
// name (pickedSideOnScoreRow). A team that can't be placed on exactly one side stays PENDING.
//
// The five games below are the prod picks found wrong on 2026-11-23, scores checked against ESPN's finals.
// Pure: no DB. Run with:
//   npx tsx src/server/data/grading-neutral-site-side-acceptance-test.ts
import type { PickedSide } from "@prisma/client";
import { matchGameResult, pickedSideOnScoreRow, resolveOutcome, scoreRowOrientation } from "@/server/data/grading";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NCAAB = "basketball_ncaab";
type Score = { home: number; away: number };
// A game_results row as ESPN lists it.
const row = (sportKey: string, homeTeam: string, awayTeam: string, final: Score, firstHalf: Score | null = null, linescore: Score[] | null = null) => ({
  id: homeTeam + "|" + awayTeam,
  externalId: homeTeam + "|" + awayTeam,
  sportKey,
  homeTeam,
  awayTeam,
  homeScore: final.home,
  awayScore: final.away,
  firstFiveHomeScore: firstHalf?.home ?? null,
  firstFiveAwayScore: firstHalf?.away ?? null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: linescore as never,
  gameDate: new Date("2026-11-20T00:00:00Z"),
  gameNumber: null,
});
// A pick row as the import stored it: its own home/away, and pickedSide against those.
const pick = (o: { betType: string; homeTeam: string; awayTeam: string; pickedSide: PickedSide | null; betDetail: string; line?: number | null; period?: string }) => ({
  period: "FULL_GAME",
  line: null,
  ...o,
});

// ---------------------------------------------------------------------
// 1. The prod picks (pick row = Odds API orientation, score row = ESPN orientation, reversed).
// ---------------------------------------------------------------------
const MIZZOU_MARQ = row(NCAAB, "Missouri Tigers", "Marquette Golden Eagles", { home: 69, away: 64 }, { home: 33, away: 30 });
const NCST_MURRAY = row(NCAAB, "NC State Wolfpack", "Murray State Racers", { home: 93, away: 83 });
const RICH_WKU = row(NCAAB, "Richmond Spiders", "Western Kentucky Hilltoppers", { home: 68, away: 82 });
const UVU_ECU = row(NCAAB, "Utah Valley Wolverines", "East Carolina Pirates", { home: 90, away: 79 });
const UCI_LMU = row(NCAAB, "UC Irvine Anteaters", "Loyola Marymount Lions", { home: 68, away: 72 });

const marq = { homeTeam: "Marquette Golden Eagles", awayTeam: "Missouri Tigers" };
check(
  "Marquette -1 (Missouri won 69-64): LOSS, not WIN",
  resolveOutcome(pick({ ...marq, betType: "SPREAD", pickedSide: "HOME", betDetail: "Marquette -1", line: -1 }), MIZZOU_MARQ),
  "LOSS"
);
check("Marquette ML: LOSS, not WIN", resolveOutcome(pick({ ...marq, betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Marquette ML" }), MIZZOU_MARQ), "LOSS");
const murray = { homeTeam: "Murray St Racers", awayTeam: "NC State Wolfpack" };
check("Murray State +4 (NC State won 93-83): LOSS", resolveOutcome(pick({ ...murray, betType: "SPREAD", pickedSide: "HOME", betDetail: "Murray State +4", line: 4 }), NCST_MURRAY), "LOSS");
check("Murray State +3.5: LOSS", resolveOutcome(pick({ ...murray, betType: "SPREAD", pickedSide: "HOME", betDetail: "Murray State +3.5", line: 3.5 }), NCST_MURRAY), "LOSS");
check(
  "Western Kentucky +0.5 (WKU won 82-68): WIN, not LOSS",
  resolveOutcome(pick({ homeTeam: "Western Kentucky Hilltoppers", awayTeam: "Richmond Spiders", betType: "SPREAD", pickedSide: "HOME", betDetail: "WKU +0.5", line: 0.5 }), RICH_WKU),
  "WIN"
);
check(
  "Utah Valley -3.5 (won 90-79): WIN, not LOSS",
  resolveOutcome(pick({ homeTeam: "East Carolina Pirates", awayTeam: "Utah Valley Wolverines", betType: "SPREAD", pickedSide: "AWAY", betDetail: "Utah Valley -3.5", line: -3.5 }), UVU_ECU),
  "WIN"
);
check(
  "UC Irvine -2.5 (LMU won 72-68): LOSS, not WIN",
  resolveOutcome(pick({ homeTeam: "Loyola Marymount Lions", awayTeam: "UC Irvine Anteaters", betType: "SPREAD", pickedSide: "AWAY", betDetail: "UC Irvine -2.5", line: -2.5 }), UCI_LMU),
  "LOSS"
);

// The fuzzy fallback is what hands a reversed row to resolveOutcome in prod: pinned here.
const matched = matchGameResult([MIZZOU_MARQ as never], { ...marq, betDetail: "Marquette -1", gameTime: new Date("2026-11-20T01:00:00Z") }, NCAAB);
check("the reversed score row is matched (fuzzy) - so grading must not read it by position", [matched?.matchType, (matched?.game as { homeTeam?: string } | undefined)?.homeTeam], ["fuzzy", "Missouri Tigers"]);

// ---------------------------------------------------------------------
// 2. Every team-side market on a reversed row: ML, spread, team total, a period.
// ---------------------------------------------------------------------
check(
  "period (NCAAB 1st half) Marquette 1H ML on the reversed row: Missouri led 33-30 -> LOSS",
  resolveOutcome(pick({ ...marq, betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Marquette 1H ML", period: "FIRST_HALF" }), MIZZOU_MARQ),
  "LOSS"
);
const NFL = row("americanfootball_nfl", "Chicago Bears", "Detroit Lions", { home: 17, away: 31 });
const lionsHome = { homeTeam: "Detroit Lions", awayTeam: "Chicago Bears" };
check(
  "team total Lions Over 27.5 (Lions 31) with the pick row reversed: WIN (Bears' 17 would lose)",
  resolveOutcome(pick({ ...lionsHome, betType: "TEAM_TOTAL", pickedSide: "HOME", betDetail: "Lions Team Total Over 27.5", line: 27.5 }), NFL),
  "WIN"
);
check(
  "team total, no stored side: read from the text against the score row's own teams (unchanged)",
  resolveOutcome(pick({ ...lionsHome, betType: "TEAM_TOTAL", pickedSide: null, betDetail: "Lions Team Total Over 27.5", line: 27.5 }), NFL),
  "WIN"
);
const NHL = row("icehockey_nhl", "Boston Bruins", "Toronto Maple Leafs", { home: 2, away: 3 }, null, [
  { home: 1, away: 0 },
  { home: 0, away: 1 },
  { home: 1, away: 1 },
  { home: 0, away: 1 },
]);
const leafsHome = { homeTeam: "Toronto Maple Leafs", awayTeam: "Boston Bruins" };
check(
  "NHL 1st period Leafs ML on the reversed row: Bruins won the 1P 1-0 -> LOSS",
  resolveOutcome(pick({ ...leafsHome, betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Leafs 1P ML", period: "FIRST_PERIOD" }), NHL),
  "LOSS"
);
check(
  "NHL puck line Leafs -1.5 (won 3-2 in OT) on the reversed row: LOSS",
  resolveOutcome(pick({ ...leafsHome, betType: "SPREAD", pickedSide: "HOME", betDetail: "Leafs -1.5", line: -1.5 }), NHL),
  "LOSS"
);
check(
  "NHL 3-way Leafs (2-2 in regulation): LOSS; the draw is orientation-free",
  [
    resolveOutcome(pick({ ...leafsHome, betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Leafs 3-way ML", period: "REGULATION" }), NHL),
    resolveOutcome(pick({ ...leafsHome, betType: "MONEYLINE", pickedSide: "DRAW", betDetail: "Leafs Bruins Draw", period: "REGULATION" }), NHL),
  ],
  ["LOSS", "WIN"]
);
check(
  "game total is orientation-free: Over 4.5 on 5 goals WINS either way round",
  [
    resolveOutcome(pick({ ...leafsHome, betType: "TOTAL", pickedSide: null, betDetail: "Over 4.5", line: 4.5 }), NHL),
    resolveOutcome(pick({ homeTeam: "Boston Bruins", awayTeam: "Toronto Maple Leafs", betType: "TOTAL", pickedSide: null, betDetail: "Over 4.5", line: 4.5 }), NHL),
  ],
  ["WIN", "WIN"]
);

// ---------------------------------------------------------------------
// 3. Normal orientation: graded exactly as before.
// ---------------------------------------------------------------------
const same = { homeTeam: "Missouri Tigers", awayTeam: "Marquette Golden Eagles" };
check(
  "same orientation: Missouri ML WIN, Marquette +1.5 LOSS, Marquette +5.5 WIN, Missouri -5 PUSH",
  [
    resolveOutcome(pick({ ...same, betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Missouri ML" }), MIZZOU_MARQ),
    resolveOutcome(pick({ ...same, betType: "SPREAD", pickedSide: "AWAY", betDetail: "Marquette +1.5", line: 1.5 }), MIZZOU_MARQ),
    resolveOutcome(pick({ ...same, betType: "SPREAD", pickedSide: "AWAY", betDetail: "Marquette +5.5", line: 5.5 }), MIZZOU_MARQ),
    resolveOutcome(pick({ ...same, betType: "SPREAD", pickedSide: "HOME", betDetail: "Missouri -5", line: -5 }), MIZZOU_MARQ),
  ],
  ["WIN", "LOSS", "WIN", "PUSH"]
);
check("orientation: same / reversed by name", [scoreRowOrientation(same, MIZZOU_MARQ), scoreRowOrientation(marq, MIZZOU_MARQ)], ["same", "reversed"]);

// ---------------------------------------------------------------------
// 4. Hard guard: a team that can't be placed on exactly one side is never graded.
// ---------------------------------------------------------------------
check(
  "pick's teams not on the score row: PENDING (null), UNMATCHED",
  [
    resolveOutcome(pick({ homeTeam: "Kansas Jayhawks", awayTeam: "Duke Blue Devils", betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Kansas ML" }), MIZZOU_MARQ),
    pickedSideOnScoreRow({ homeTeam: "Kansas Jayhawks", awayTeam: "Duke Blue Devils", betType: "MONEYLINE", pickedSide: "HOME" }, MIZZOU_MARQ),
  ],
  [null, "UNMATCHED"]
);
// Two schools with one mascot, spelled so the strict match fails: either orientation fits the nickname test.
const TIGERS = row("americanfootball_ncaaf", "Clemson Tigers", "LSU Tigers", { home: 20, away: 24 });
check(
  "same-mascot pair the names can't place: PENDING",
  resolveOutcome(pick({ homeTeam: "Clemson U Tigers", awayTeam: "Louisiana St Tigers", betType: "MONEYLINE", pickedSide: "AWAY", betDetail: "LSU ML" }), TIGERS),
  null
);
// Prod 2026-11: no LSU-Louisiana Tech row existed, and the fuzzy fallback matched a different game whose mascots
// collide. A nickname-only reversal is never flipped: PENDING.
const MSU_JSU = row(NCAAB, "Mississippi State Bulldogs", "Jackson State Tigers", { home: 98, away: 57 });
const lsu = { homeTeam: "LSU Tigers", awayTeam: "Louisiana Tech Bulldogs", betType: "SPREAD", pickedSide: "HOME" as const, betDetail: "LSU -29.5", line: -29.5 };
check(
  "a different game with colliding mascots (nickname-only reversal): PENDING, never graded on either team",
  [scoreRowOrientation(lsu, MSU_JSU), resolveOutcome(pick(lsu), MSU_JSU)],
  [null, null]
);
// A same-orientation row the strict names don't settle (a spelling the alias tables lack) grades as before.
check(
  "nickname-only SAME orientation still grades as before",
  resolveOutcome(pick({ homeTeam: "Missouri U Tigers", awayTeam: "Marquette U Golden Eagles", betType: "MONEYLINE", pickedSide: "HOME", betDetail: "Missouri ML" }), MIZZOU_MARQ),
  "WIN"
);
check(
  "a totals pick with a stray pickedSide is not blocked by the side guard",
  pickedSideOnScoreRow({ homeTeam: "Kansas Jayhawks", awayTeam: "Duke Blue Devils", betType: "TOTAL", pickedSide: "HOME" }, MIZZOU_MARQ),
  "HOME"
);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");

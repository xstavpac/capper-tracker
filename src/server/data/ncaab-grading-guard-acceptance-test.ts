// Proof for the temporary NCAAB grading guard (resolveOutcome, grading.ts) and
// the pick gate on NCAAB game results - run with:
//   npx tsx src/server/data/ncaab-grading-guard-acceptance-test.ts
//
// No test framework in this repo. console.logs PASS/FAIL, exits non-zero on
// any failure. No DB, no network.
//
// The bug being fenced off: getEspnGameSegments computes a first half as
// linescore[0] + linescore[1]. That is right for a four-quarter sport and
// WRONG for NCAAB, whose two linescore entries ARE the two halves - the sum is
// all of regulation. The fixture below is a real final (ESPN event 401920912,
// 2026-11-02): Grambling 89, Northern Illinois 87, linescores [43, 46] and
// [36, 51]. Written the buggy way, "first half" would be 89-87 and a first-half
// bet would grade against the whole game.
//
// Until PR C fixes that, an NCAAB pick on any period but FULL_GAME must stay
// PENDING (resolveOutcome returns null).

import { resolveOutcome, withSportKey } from "./grading";
import { finalsWithPicks, PICK_GATED_SPORT_KEYS, NCAAB_SPORT_KEY } from "@/lib/final-pick-gate";
import { tendencyPhaseEnabled } from "@/lib/tendency-pipeline";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// The real final, as persistFinalScores WOULD store it if NCAAB were wired into
// getEspnGameSegments the buggy way: first half = 43+46 vs 36+51.
const GAME = {
  homeTeam: "Grambling Tigers",
  awayTeam: "Northern Illinois Huskies",
  homeScore: 89,
  awayScore: 87,
  firstFiveHomeScore: 89,
  firstFiveAwayScore: 87,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: [
    { home: 43, away: 36 },
    { home: 46, away: 51 },
  ] as never,
};
const ncaab = { ...GAME, sportKey: NCAAB_SPORT_KEY };
const nba = { ...GAME, sportKey: "basketball_nba" };

const pick = (period: string, betType: string, betDetail: string, line: number | null, pickedSide: "HOME" | "AWAY" | null = null) => ({
  period,
  betType,
  betDetail,
  line,
  homeTeam: GAME.homeTeam,
  pickedSide,
});

// ---- the guard: every non-FULL_GAME period stays PENDING for NCAAB ----
const H1_OVER = pick("FIRST_HALF", "TOTAL", "1H Over 80.5", 80.5);
const H2_OVER = pick("SECOND_HALF", "TOTAL", "2H Over 80.5", 80.5);
const Q1_OVER = pick("FIRST_QUARTER", "TOTAL", "1Q Over 40.5", 40.5);
const H1_ML = pick("FIRST_HALF", "MONEYLINE", "1H Grambling ML", null, "HOME");
const H1_SPREAD = pick("FIRST_HALF", "SPREAD", "1H Northern Illinois +3.5", 3.5, "AWAY");

check("NCAAB FIRST_HALF total stays PENDING (the buggy 89-87 'first half' would grade it)", resolveOutcome(H1_OVER, ncaab), null);
check("NCAAB SECOND_HALF total stays PENDING", resolveOutcome(H2_OVER, ncaab), null);
check("NCAAB FIRST_QUARTER total stays PENDING (no quarters: [43,46] are halves)", resolveOutcome(Q1_OVER, ncaab), null);
check("NCAAB FIRST_HALF moneyline stays PENDING", resolveOutcome(H1_ML, ncaab), null);
check("NCAAB FIRST_HALF spread stays PENDING", resolveOutcome(H1_SPREAD, ncaab), null);

// Control: the SAME row and the SAME picks are gradable under another sport, so
// the nulls above are the guard and not a bad fixture.
check("control: same FIRST_HALF total grades under NBA (89 > 80.5)", resolveOutcome(H1_OVER, nba), "WIN");
// (With the buggy first half of 89-87, "second half" = final minus first half = 0-0: the other
// face of the same bug, and why SECOND_HALF is fenced off too.)
check("control: same SECOND_HALF total is computed under NBA (0 < 80.5 from the buggy split)", resolveOutcome(H2_OVER, nba), "LOSS");
check("control: same FIRST_QUARTER total grades under NBA (43 + 36 = 79 > 40.5)", resolveOutcome(Q1_OVER, nba), "WIN");
check("control: a row with no sportKey (older callers) is unguarded", resolveOutcome(H1_OVER, GAME), "WIN");

// ---- FULL_GAME still grades for NCAAB ----
check(
  "NCAAB FULL_GAME total grades (176 > 170.5)",
  resolveOutcome(pick("FULL_GAME", "TOTAL", "Over 170.5", 170.5), ncaab),
  "WIN"
);
check(
  "NCAAB FULL_GAME total under loses (176 is not under 170.5)",
  resolveOutcome(pick("FULL_GAME", "TOTAL", "Under 170.5", 170.5), ncaab),
  "LOSS"
);
check(
  "NCAAB FULL_GAME spread on a stored side grades (Northern Illinois lost by 2, +3.5 covers)",
  resolveOutcome(pick("FULL_GAME", "SPREAD", "Northern Illinois +3.5", 3.5, "AWAY"), ncaab),
  "WIN"
);
check(
  "NCAAB FULL_GAME moneyline on a stored side grades (Grambling won)",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Grambling ML", null, "HOME"), ncaab),
  "WIN"
);

// Team-name resolution with NO stored side (the text fallback). Works for the
// mascot and for a school that also plays NCAAF; a school only the text names
// by its SCHOOL (no NCAAB school list until PR B) resolves to neither team and
// stays PENDING - never graded onto a guessed side.
check(
  "text fallback: mascot ('Huskies') resolves the away side",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Huskies ML", null), ncaab),
  "LOSS"
);
check(
  "text fallback: school shared with NCAAF ('Northern Illinois') resolves",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Northern Illinois ML", null), ncaab),
  "LOSS"
);
check(
  "text fallback: an NCAAB-only school by school name ('Grambling') resolves to neither side -> PENDING",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Grambling ML", null), ncaab),
  null
);

// ---- the guard travels with the candidate pool ----
const pool = withSportKey([{ homeTeam: "A" }, { homeTeam: "B" }], NCAAB_SPORT_KEY);
check("withSportKey stamps every row and leaves the rest", pool, [
  { homeTeam: "A", sportKey: NCAAB_SPORT_KEY },
  { homeTeam: "B", sportKey: NCAAB_SPORT_KEY },
]);
check("a pool row stamped NCAAB is guarded", resolveOutcome(H1_OVER, { ...GAME, ...withSportKey([{}], NCAAB_SPORT_KEY)[0] }), null);

// ---- the pick gate: NCAAB persists only finals a pending pick names ----
check("NCAAB is the only pick-gated sport", [...PICK_GATED_SPORT_KEYS], [NCAAB_SPORT_KEY]);

const finals = [
  { id: "1", homeTeam: "Grambling Tigers", awayTeam: "Northern Illinois Huskies" },
  { id: "2", homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" },
  { id: "3", homeTeam: "Gonzaga Bulldogs", awayTeam: "Houston Cougars" },
  { id: "4", homeTeam: "Saint Mary's Gaels", awayTeam: "San José State Spartans" },
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

check("no pending picks -> no final is persisted", ids(finalsWithPicks(finals, [], NCAAB_SPORT_KEY)), []);
check(
  "a pick on one game keeps that final only",
  ids(finalsWithPicks(finals, [{ homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" }], NCAAB_SPORT_KEY)),
  ["2"]
);
check(
  "home/away swapped between feeds (neutral site) still matches",
  ids(finalsWithPicks(finals, [{ homeTeam: "Houston Cougars", awayTeam: "Gonzaga Bulldogs" }], NCAAB_SPORT_KEY)),
  ["3"]
);
check(
  "case and accents fold the way every cross-feed join does",
  ids(finalsWithPicks(finals, [{ homeTeam: "saint mary's gaels", awayTeam: "San Jose State Spartans" }], NCAAB_SPORT_KEY)),
  ["4"]
);
check(
  "two picks on the same game, one on another: three finals' worth of picks keep exactly two finals",
  ids(
    finalsWithPicks(
      finals,
      [
        { homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" },
        { homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" },
        { homeTeam: "Grambling Tigers", awayTeam: "Northern Illinois Huskies" },
      ],
      NCAAB_SPORT_KEY
    )
  ),
  ["1", "2"]
);
check(
  "one shared team is not enough: the same home team against a different opponent is a different game",
  ids(finalsWithPicks(finals, [{ homeTeam: "Duke Blue Devils", awayTeam: "Houston Cougars" }], NCAAB_SPORT_KEY)),
  []
);
check("no finals -> nothing", finalsWithPicks([], [{ homeTeam: "x", awayTeam: "y" }], NCAAB_SPORT_KEY), []);

// ---- tendencies: a pick-gated sport never takes part (its GameResult rows are a sample of what was bet on) ----
check("tendency phase: NCAAB is out even when the pipeline is on", tendencyPhaseEnabled(true, NCAAB_SPORT_KEY), false);
check("tendency phase: other sports follow the pipeline flag (on)", tendencyPhaseEnabled(true, "basketball_nba"), true);
check("tendency phase: other sports follow the pipeline flag (off)", tendencyPhaseEnabled(false, "basketball_nba"), false);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);

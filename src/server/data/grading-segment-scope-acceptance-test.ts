// Quarter / hockey-period / second-half grading - run with:
//   npx tsx src/server/data/grading-segment-scope-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// History:
//   PR #19 stopped "over 13.5 first quarter" (and every other segment-scoped
//   pick) from silently grading against the full-game score by returning null
//   -> PENDING for any period the grader had no data for. This file now
//   proves the follow-up: NFL / NBA / WNBA / NCAAF Q1-Q4 and 2nd half, and
//   NHL P1-P3, actually grade, off GameResult.linescoreJson (and, for 2nd
//   half, final minus first half). FULL_GAME and FIRST_HALF are unchanged; a
//   segment with genuinely no data (linescore missing, an inning outside
//   MLB's F5 path) still safely stays PENDING.

import { gradePick, resolveOutcome } from "./grading";
import { betScope, pickPeriodFromText } from "@/lib/bet-line";
import type { GameResult, Period } from "@prisma/client";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// UNLV Rebels @ Hawai'i Rainbow Warriors, real box score (2026-09-05):
//   home = Hawai'i, away = UNLV. Final: Hawai'i 6, UNLV 21.
//   Quarter linescore  UNLV(away): 7, 7, 0, 7   Hawai'i(home): 0, 3, 3, 0
//   First half = UNLV 14, Hawai'i 3 ; second half = UNLV 7, Hawai'i 3
const UNLV_HAWAII: GameResult = {
  homeTeam: "Hawai'i Rainbow Warriors",
  awayTeam: "UNLV Rebels",
  homeScore: 6,
  awayScore: 21,
  firstFiveHomeScore: 3,
  firstFiveAwayScore: 14,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: [
    { home: 0, away: 7 },
    { home: 3, away: 7 },
    { home: 3, away: 0 },
    { home: 0, away: 7 },
  ],
} as unknown as GameResult;

function grade(period: Period, betType: string, betDetail: string, line: number | null, game: GameResult, side?: "HOME" | "AWAY") {
  return resolveOutcome(
    { betType, period, betDetail, homeTeam: game.homeTeam, line, pickedSide: side ?? null },
    game
  );
}

// ============================================================
// PART 1 - the exact production pick, now graded correctly
// ============================================================

expect(
  "THE BUG: 'over 13.5 first quarter' now grades LOSS (real Q1 combined = 7), not the silent WIN off the 27-point final",
  grade("FIRST_QUARTER", "TOTAL", "UNLV vs Hawaii over 13.5 first quarter", 13.5, UNLV_HAWAII),
  "LOSS"
);
expect(
  "the same line as an under: WIN",
  grade("FIRST_QUARTER", "TOTAL", "UNLV vs Hawaii under 13.5 1q", 13.5, UNLV_HAWAII),
  "WIN"
);
expect(
  "betScope classifies it as FIRST_QUARTER, and pickPeriodFromText stores it as FIRST_QUARTER",
  `${betScope("over 13.5 first quarter")}/${pickPeriodFromText("over 13.5 first quarter")}`,
  "FIRST_QUARTER/FIRST_QUARTER"
);

// ============================================================
// PART 2 - Q1-Q4 across football / basketball, both bet types
// ============================================================

// Q1: away 7 - home 0 (combined 7)   Q2: away 7 - home 3 (combined 10)
// Q3: away 0 - home 3 (combined 3)    Q4: away 7 - home 0 (combined 7)
expect("Q1 combined total over 6.5 -> WIN", grade("FIRST_QUARTER", "TOTAL", "over 6.5 1q", 6.5, UNLV_HAWAII), "WIN");
expect("Q2 combined total under 9.5 -> LOSS (10)", grade("SECOND_QUARTER", "TOTAL", "under 9.5 q2", 9.5, UNLV_HAWAII), "LOSS");
expect("Q3 combined total over 5.5 -> LOSS (3)", grade("THIRD_QUARTER", "TOTAL", "over 5.5 3rd quarter", 5.5, UNLV_HAWAII), "LOSS");
expect("Q4 combined total push at 7 -> PUSH", grade("FOURTH_QUARTER", "TOTAL", "over 7 4q", 7, UNLV_HAWAII), "PUSH");
expect(
  "Q1 spread: UNLV -3.5 (won the quarter 7-0) -> WIN",
  grade("FIRST_QUARTER", "SPREAD", "UNLV 1q -3.5", -3.5, UNLV_HAWAII, "AWAY"),
  "WIN"
);
expect(
  "Q3 moneyline: Hawai'i (won Q3 3-0) -> WIN",
  grade("THIRD_QUARTER", "MONEYLINE", "Hawaii 3rd quarter ML", null, UNLV_HAWAII, "HOME"),
  "WIN"
);
expect(
  "Q4 moneyline: Hawai'i (lost Q4 0-7) -> LOSS",
  grade("FOURTH_QUARTER", "MONEYLINE", "Hawaii q4 ML", null, UNLV_HAWAII, "HOME"),
  "LOSS"
);

// A generic NBA-shaped game to show quarter grading isn't football-specific.
// IND 116, OKC 107 - linescore IND 24,40,20,32 / OKC 32,28,29,18 (real, 2025).
const NBA_GAME: GameResult = {
  homeTeam: "Indiana Pacers",
  awayTeam: "Oklahoma City Thunder",
  homeScore: 116,
  awayScore: 107,
  firstFiveHomeScore: 64,
  firstFiveAwayScore: 60,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: [
    { home: 24, away: 32 },
    { home: 40, away: 28 },
    { home: 20, away: 29 },
    { home: 32, away: 18 },
  ],
} as unknown as GameResult;
expect("NBA Q2 total over 67.5 -> WIN (68)", grade("SECOND_QUARTER", "TOTAL", "over 67.5 2q", 67.5, NBA_GAME), "WIN");
expect(
  "NBA Q1 moneyline: OKC won Q1 32-24 -> WIN",
  grade("FIRST_QUARTER", "MONEYLINE", "Thunder 1st quarter ML", null, NBA_GAME, "AWAY"),
  "WIN"
);

// ============================================================
// PART 3 - second half (final minus first half, includes OT)
// ============================================================

// UNLV/Hawai'i 2nd half: UNLV 21-14 = 7, Hawai'i 6-3 = 3 (combined 10, UNLV +4)
expect("2nd half combined total over 6.5 -> WIN (10)", grade("SECOND_HALF", "TOTAL", "over 6.5 2nd half", 6.5, UNLV_HAWAII), "WIN");
expect("2nd half combined total under 9.5 -> LOSS (10)", grade("SECOND_HALF", "TOTAL", "under 9.5 2h", 9.5, UNLV_HAWAII), "LOSS");
expect(
  "2nd half spread: Hawai'i +2.5 (lost the half by 4) -> LOSS",
  grade("SECOND_HALF", "SPREAD", "Hawaii 2nd half +2.5", 2.5, UNLV_HAWAII, "HOME"),
  "LOSS"
);
expect(
  "2nd half needs the first-half score: a game missing firstFive -> null (PENDING)",
  grade("SECOND_HALF", "TOTAL", "over 6.5 2nd half", 6.5, { ...UNLV_HAWAII, firstFiveHomeScore: null, firstFiveAwayScore: null } as GameResult),
  null
);

// ============================================================
// PART 4 - NHL periods P1-P3 (linescoreJson index 0..2; OT/SO ignored)
// ============================================================

// EDM @ FLA, real 2025 OT game: FLA 4, EDM 5 (Final/OT).
// linescores FLA 3,0,1,0  EDM 0,3,1,1  -> P1..P3 = FLA 3/0/1, EDM 0/3/1
// (regulation 4-4); index 3 (0/1) is the OT goal and must never be read.
const NHL_OT_GAME: GameResult = {
  homeTeam: "Florida Panthers",
  awayTeam: "Edmonton Oilers",
  homeScore: 4,
  awayScore: 5,
  firstFiveHomeScore: null,
  firstFiveAwayScore: null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: [
    { home: 3, away: 0 },
    { home: 0, away: 3 },
    { home: 1, away: 1 },
    { home: 0, away: 1 },
  ],
} as unknown as GameResult;
expect("NHL P1 moneyline: FLA won the period 3-0 -> WIN", grade("FIRST_PERIOD", "MONEYLINE", "Panthers 1st period ML", null, NHL_OT_GAME, "HOME"), "WIN");
expect("NHL P2 total over 2.5 -> WIN (3)", grade("SECOND_PERIOD", "TOTAL", "over 2.5 2nd period", 2.5, NHL_OT_GAME), "WIN");
expect("NHL P3 total under 2.5 -> WIN (2 - the OT goal at index 3 is NOT counted)", grade("THIRD_PERIOD", "TOTAL", "under 2.5 p3", 2.5, NHL_OT_GAME), "WIN");
expect("NHL P3 moneyline: tied period 1-1 -> PUSH", grade("THIRD_PERIOD", "MONEYLINE", "Panthers 3rd period ML", null, NHL_OT_GAME, "HOME"), "PUSH");

// ============================================================
// PART 5 - regressions: FULL_GAME and FIRST_HALF unchanged
// ============================================================

expect("FULL_GAME total still grades (over 20.5 vs final 27) -> WIN", grade("FULL_GAME", "TOTAL", "over 20.5", 20.5, UNLV_HAWAII), "WIN");
expect("FULL_GAME moneyline still grades -> WIN", grade("FULL_GAME", "MONEYLINE", "UNLV ML", null, UNLV_HAWAII, "AWAY"), "WIN");
expect(
  "FIRST_HALF total still grades off firstFive (UNLV 14 + Hawai'i 3 = 17) over 16.5 -> WIN",
  grade("FIRST_HALF", "TOTAL", "over 16.5 1st half", 16.5, UNLV_HAWAII),
  "WIN"
);
expect(
  "FIRST_HALF with no firstFive captured -> null (pre-existing behavior, unchanged)",
  grade("FIRST_HALF", "TOTAL", "over 16.5 1st half", 16.5, { ...UNLV_HAWAII, firstFiveHomeScore: null, firstFiveAwayScore: null } as GameResult),
  null
);
expect(
  "gradePick direct call, FULL_GAME phrasing, is completely unaffected",
  gradePick("SPREAD", "Hawaii +10.5", 10.5, "Hawai'i Rainbow Warriors", "UNLV Rebels", 6, 21, "HOME"),
  "LOSS"
);

// ============================================================
// PART 6 - still-unsupported segments stay PENDING, never guessed
// ============================================================

expect(
  "a lone inning outside MLB's F5 path -> UNSUPPORTED_SEGMENT -> null",
  grade("FULL_GAME", "TOTAL", "over 0.5 1st inning", 0.5, UNLV_HAWAII),
  null
);
expect('betScope("over 0.5 3rd inning") -> UNSUPPORTED_SEGMENT', betScope("over 0.5 3rd inning"), "UNSUPPORTED_SEGMENT");
expect(
  "a quarter pick on a game with no linescore captured yet -> null (PENDING), not graded against the final",
  grade("SECOND_QUARTER", "TOTAL", "over 9.5 q2", 9.5, { ...UNLV_HAWAII, linescoreJson: null } as GameResult),
  null
);
expect(
  "a quarter pick whose linescore array is too short -> null",
  grade("FOURTH_QUARTER", "TOTAL", "over 6.5 q4", 6.5, { ...UNLV_HAWAII, linescoreJson: [{ home: 0, away: 7 }, { home: 3, away: 7 }] } as unknown as GameResult),
  null
);
expect(
  "legacy safety: text says 'Q1' but the pick was stored FULL_GAME (predates quarter Periods) -> null, not a full-game grade",
  grade("FULL_GAME", "TOTAL", "over 13.5 first quarter", 13.5, UNLV_HAWAII),
  null
);
expect(
  "legacy safety: bare '1H' text on a FULL_GAME-stored pick -> null",
  grade("FULL_GAME", "TOTAL", "UNLV 1H over 13.5", 13.5, UNLV_HAWAII),
  null
);

// ============================================================
// PART 7 - NRFI is untouched by any of the segment logic
// ============================================================

const MLB_GAME: GameResult = {
  homeTeam: "New York Yankees",
  awayTeam: "Boston Red Sox",
  homeScore: 5,
  awayScore: 3,
  firstFiveHomeScore: 2,
  firstFiveAwayScore: 1,
  firstInningHomeScore: 0,
  firstInningAwayScore: 0,
  linescoreJson: null,
} as unknown as GameResult;
expect("NRFI still grades off first-inning scores (0 runs) -> WIN", grade("FULL_GAME", "NRFI", "no run first inning", null, MLB_GAME), "WIN");
expect(
  "YRFI grades LOSS when the 1st was scoreless",
  grade("FULL_GAME", "NRFI", "yes run first inning", null, MLB_GAME),
  "LOSS"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);

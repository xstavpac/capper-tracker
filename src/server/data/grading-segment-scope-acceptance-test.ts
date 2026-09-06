// Regression proof for the Q1 / segment-scoped grading bug - run with:
//   npx tsx src/server/data/grading-segment-scope-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// THE BUG (found in production):
//   A real logged pick - "UNLV Rebels @ Hawai'i Rainbow Warriors,
//   over 13.5 first quarter" - graded as WIN in the app. The game finished
//   UNLV 21, Hawai'i 6 (final combined 27); Q1 was UNLV 7, Hawai'i 0
//   (combined 7), well UNDER 13.5, so the pick was a LOSS.
//
//   Mechanism: Prisma's Period enum only has FULL_GAME and FIRST_HALF, and
//   parse-catalog.ts's importer only ever sets FIRST_HALF (its isFirstFive
//   flag) for F5 / "1st half" / "first half" phrasing. "first quarter" (and
//   "Q1", "1Q", "2nd half", "1st period", a lone inning, ...) matches none of
//   it, so the pick was stored period=FULL_GAME and was indistinguishable
//   from a real full-game total at grading time. resolveOutcome -> gradePick
//   then compared the FINAL combined score (27) to 13.5 and returned WIN.
//
// THE FIX (bet-line.ts betScope + guards in gradePick / resolveOutcome):
//   Grading re-derives the pick's game-segment scope from betDetail text (the
//   same "never stored, always re-read from betDetail" pattern already used
//   for TOTAL's over/under side and NRFI's yes/no side). Any scope the grader
//   has no score source for -> return null -> the pick stays PENDING for
//   manual grading, never a silent wrong grade. This mirrors the codebase's
//   existing rule, already covered by the NHL/CFL grading tests: "a FIRST_HALF
//   pick with no period source -> null, not a wrong grade."

import { gradePick, resolveOutcome } from "./grading";
import { betScope } from "@/lib/bet-line";
import type { GameResult } from "@prisma/client";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

function fakeGame(over: Partial<GameResult>): GameResult {
  return {
    sportKey: "americanfootball_ncaaf",
    externalId: "test-event",
    homeTeam: "Hawai'i Rainbow Warriors",
    awayTeam: "UNLV Rebels",
    homeScore: 6,
    awayScore: 21,
    firstFiveHomeScore: null,
    firstFiveAwayScore: null,
    firstInningHomeScore: null,
    firstInningAwayScore: null,
    ...over,
  } as unknown as GameResult;
}

// ============================================================
// PART 1 - the exact production pick
// ============================================================

expect(
  "gradePick: 'over 13.5 first quarter' with the 27-point FINAL -> null (was a silent WIN)",
  gradePick(
    "TOTAL",
    "UNLV vs Hawaii over 13.5 first quarter",
    13.5,
    "Hawai'i Rainbow Warriors",
    "UNLV Rebels",
    6,
    21,
    null
  ),
  null
);

expect(
  "resolveOutcome: the same pick as the importer actually stored it (betType=TOTAL, period=FULL_GAME) -> null",
  resolveOutcome(
    {
      betType: "TOTAL",
      period: "FULL_GAME",
      betDetail: "UNLV vs Hawaii over 13.5 first quarter",
      homeTeam: "Hawai'i Rainbow Warriors",
      line: 13.5,
      pickedSide: null,
    },
    fakeGame({})
  ),
  null
);

// Sanity: had a Q1 score source existed and said 7, this is the grade the
// pick should have gotten. (gradePick with an explicit non-segment detail so
// the guard doesn't fire - this documents the "correct answer was LOSS".)
expect(
  "gradePick: combined Q1 total of 7 vs over 13.5 -> LOSS (the grade the pick should have had)",
  gradePick("TOTAL", "over 13.5", 13.5, "Hawai'i Rainbow Warriors", "UNLV Rebels", 0, 7, null),
  "LOSS"
);

// ============================================================
// PART 2 - the general class: every unsupported segment scope, any sport
// ============================================================

const UNSUPPORTED: [string, string][] = [
  ["NCAAF/NFL Q1 total, spelled out", "over 13.5 first quarter"],
  ["Q1 total, 'Q1' shorthand", "team total over 6.5 Q1"],
  ["Q1 total, '1Q' shorthand", "UNLV 1Q over 6.5"],
  ["Q2 spread", "Hawaii 2nd quarter +3.5"],
  ["3rd quarter total", "over 14.5 3rd quarter"],
  ["4th quarter moneyline", "UNLV ML 4q"],
  ["second half total", "over 27.5 second half"],
  ["2nd half spread", "Hawaii 2nd half +7"],
  ["'2H' shorthand", "UNLV 2H -3"],
  ["hockey 1st period total", "over 2.5 1st period"],
  ["hockey 2nd period moneyline", "Jets 2nd period ML"],
  ["a lone inning total (not the F5 block)", "over 0.5 3rd inning"],
];

for (const [label, detail] of UNSUPPORTED) {
  expect(
    `betScope: "${detail}" -> UNSUPPORTED_SEGMENT`,
    betScope(detail),
    "UNSUPPORTED_SEGMENT"
  );
  expect(
    `gradePick declines (${label}) -> null, not a full-game grade`,
    gradePick("TOTAL", detail, 13.5, "Hawai'i Rainbow Warriors", "UNLV Rebels", 6, 21, null),
    null
  );
  expect(
    `resolveOutcome declines (${label}) even when stored period=FULL_GAME -> null`,
    resolveOutcome(
      { betType: "TOTAL", period: "FULL_GAME", betDetail: detail, homeTeam: "Hawai'i Rainbow Warriors", line: 13.5, pickedSide: null },
      fakeGame({})
    ),
    null
  );
}

// A first-half pick the importer FAILED to tag as Period.FIRST_HALF (e.g.
// bare "1H") must also not grade against the full game - betScope catches the
// text, and resolveOutcome declines on the period mismatch.
expect(
  'betScope: bare "1H" text -> FIRST_HALF',
  betScope("UNLV 1H over 13.5"),
  "FIRST_HALF"
);
expect(
  'resolveOutcome: "1H" text but stored period=FULL_GAME -> null (not graded against the final)',
  resolveOutcome(
    { betType: "TOTAL", period: "FULL_GAME", betDetail: "UNLV 1H over 13.5", homeTeam: "Hawai'i Rainbow Warriors", line: 13.5, pickedSide: null },
    fakeGame({})
  ),
  null
);

// ============================================================
// PART 3 - regressions: everything that WAS grading must still grade
// ============================================================

expect(
  "regression: a real FULL_GAME total still grades (over 20.5 vs final 27) -> WIN",
  gradePick("TOTAL", "UNLV vs Hawaii over 20.5", 20.5, "Hawai'i Rainbow Warriors", "UNLV Rebels", 6, 21, null),
  "WIN"
);

expect(
  "regression: a FULL_GAME moneyline still grades -> WIN",
  gradePick("MONEYLINE", "UNLV ML", null, "Hawai'i Rainbow Warriors", "UNLV Rebels", 6, 21, "AWAY"),
  "WIN"
);

expect(
  "regression: a FULL_GAME spread still grades (Hawaii +10.5, lost by 15) -> LOSS",
  gradePick("SPREAD", "Hawaii +10.5", 10.5, "Hawai'i Rainbow Warriors", "UNLV Rebels", 6, 21, "HOME"),
  "LOSS"
);

expect(
  "regression: betScope of an ordinary total is FULL_GAME",
  betScope("UNLV vs Hawaii over 55.5"),
  "FULL_GAME"
);

expect(
  "regression: a properly-tagged FIRST_HALF total grades against firstFive scores -> WIN (10+9=19 > 13.5)",
  resolveOutcome(
    { betType: "TOTAL", period: "FIRST_HALF", betDetail: "over 13.5 first half", homeTeam: "Hawai'i Rainbow Warriors", line: 13.5, pickedSide: null },
    fakeGame({ firstFiveHomeScore: 9, firstFiveAwayScore: 10 })
  ),
  "WIN"
);

expect(
  "regression: a FIRST_HALF pick with no firstFive source still -> null (pre-existing behavior, unchanged)",
  resolveOutcome(
    { betType: "TOTAL", period: "FIRST_HALF", betDetail: "over 13.5 first half", homeTeam: "Hawai'i Rainbow Warriors", line: 13.5, pickedSide: null },
    fakeGame({})
  ),
  null
);

// NRFI is first-inning-scoped by definition and has its own score source -
// the "first inning" / "1st" text in its betDetail must NOT trip the
// unsupported-segment guard.
expect(
  "regression: NRFI still grades against first-inning scores -> WIN (0 runs, NRFI)",
  resolveOutcome(
    { betType: "NRFI", period: "FULL_GAME", betDetail: "no run first inning", homeTeam: "New York Yankees", line: null, pickedSide: null },
    fakeGame({ firstInningHomeScore: 0, firstInningAwayScore: 0 }) as GameResult
  ),
  "WIN"
);

expect(
  "regression: YRFI still grades -> WIN (2 runs in the 1st)",
  resolveOutcome(
    { betType: "NRFI", period: "FULL_GAME", betDetail: "yes run first inning", homeTeam: "New York Yankees", line: null, pickedSide: null },
    fakeGame({ firstInningHomeScore: 1, firstInningAwayScore: 1 }) as GameResult
  ),
  "WIN"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
